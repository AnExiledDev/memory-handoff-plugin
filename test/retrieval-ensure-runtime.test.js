import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createClient } from "../runtime/client.js";
import { AUTOSTART_COOLDOWN_MS, ensureRuntime, READY_TIMEOUT_MS, servePath } from "../retrieval/ensure-runtime.js";

/**
 * A `/health` that answers from a script, so a start sequence is a list and not
 * a race. Nothing here sleeps for real: `sleep` and `now` are injected, so the
 * five-second window is exercised in microseconds.
 */
const fakeClient = (answers) => {
    const calls = [];

    return {
        calls,
        health: async () => {
            calls.push("health");

            return answers[Math.min(calls.length - 1, answers.length - 1)];
        },
    };
};

/**
 * A `/health` over the real client, answering from a script of bodies. The
 * client is in the loop on purpose: what retrieval polls is the daemon's JSON,
 * so a loading answer has to survive the parse as well as the wait.
 */
const fakeFetchClient = (bodies) => {
    const urls = [];
    const fetchText = async (url) => {
        urls.push(url);

        const body = bodies[Math.min(urls.length - 1, bodies.length - 1)];

        return { status: 200, ok: true, text: JSON.stringify(body) };
    };

    return { urls, client: createClient({ fetchText, port: 8799 }) };
};

/** A clock the test advances itself, one poll at a time. */
const fakeClock = (pollMs) => {
    let at = 0;

    return {
        now: () => at,
        sleep: async (ms) => {
            at += ms === undefined ? pollMs : ms;
        },
    };
};

/** The stamp file as a value, so no test touches the real autostart stamp on this box. */
const fakeStamp = (at = null) => {
    const state = { at };

    return { state, readStamp: () => state.at, writeStamp: (when) => { state.at = when; } };
};

describe("the daemon is started by retrieval, and only when it has to be", () => {
    it("spawns nothing when the runtime is already answering", async () => {
        const client = fakeClient([{ ready: true }]);
        let spawns = 0;

        const result = await ensureRuntime({ client, spawn: () => { spawns += 1; } });

        assert.deepEqual(result, { ready: true, started: false });
        assert.equal(spawns, 0);
        assert.equal(client.calls.length, 1);
    });

    it("spawns once and reports ready when the daemon comes up inside the window", async () => {
        const client = fakeClient([{ ready: false, reason: "connect failed" }, { ready: false, reason: "loading" }, { ready: true }]);
        const clock = fakeClock(250);
        let spawns = 0;

        const result = await ensureRuntime({ client, spawn: () => { spawns += 1; }, ...clock, ...fakeStamp() });

        assert.deepEqual(result, { ready: true, started: true });
        assert.equal(spawns, 1, "one daemon, not one per poll");
    });

    // `loading` is not `down`. The daemon says so for as long as the ONNX
    // sessions take, and bailing on the first `ready: false` would throw away
    // the warm runtime this wait exists to get.
    it("polls through a daemon that answers loading before it answers ready", async () => {
        const loading = { ready: false, reason: "loading the models, both sessions are still coming up", models: [], rss_bytes: 0 };
        const { urls, client } = fakeFetchClient([loading, loading, { ready: true, models: [], rss_bytes: 0 }]);
        const clock = fakeClock(250);
        let spawns = 0;

        const result = await ensureRuntime({ client, spawn: () => { spawns += 1; }, ...clock, ...fakeStamp() });

        assert.deepEqual(result, { ready: true, started: true });
        assert.equal(urls.length, 3, "it asked again after each loading answer instead of giving up on the first one");
        assert.equal(clock.now(), 500, "two polls, and it stopped the moment the load finished");
        assert.equal(spawns, 1);
    });

    // The rule this whole module exists for: a slow model load must never hold
    // a prompt open. The wait is bounded and the caller is told to go on.
    it("gives up at the deadline and hands back a reason instead of blocking", async () => {
        const client = fakeClient([{ ready: false, reason: "connect failed" }, { ready: false, reason: "still loading" }]);
        const clock = fakeClock(250);

        const result = await ensureRuntime({ client, spawn: () => {}, ...clock, ...fakeStamp(), timeoutMs: 1000, pollMs: 250 });

        assert.equal(result.ready, false);
        assert.equal(result.started, true);
        assert.match(String(result.reason), /did not come up within 1000 ms: still loading/u);
        assert.ok(clock.now() >= 1000 && clock.now() < 2000, "it waited the window and not a poll longer");
    });

    // Missing weights are an install-time fact, not a transient one. Starting a
    // process to watch it say so again is 90 MB of nothing.
    it("refuses to spawn when the weights are not on disk", async () => {
        const client = fakeClient([{ ready: false, reason: "weights missing: bge-small-en-v1.5" }]);
        let spawns = 0;

        const result = await ensureRuntime({ client, spawn: () => { spawns += 1; } });

        assert.equal(spawns, 0);
        assert.deepEqual(result, { ready: false, started: false, reason: "weights missing: bge-small-en-v1.5" });
    });

    // Same install-time fact, same reasoning: a copy with no `node_modules` is
    // not something a fresh process finds, and the reason already carries the
    // command that fixes it.
    it("refuses to spawn when the engine was never installed", async () => {
        const client = fakeClient([
            { ready: false, reason: "dependencies missing (@huggingface/transformers): run bun runtime/install.js" },
        ]);
        let spawns = 0;

        const result = await ensureRuntime({ client, spawn: () => { spawns += 1; } });

        assert.equal(spawns, 0);
        assert.equal(result.ready, false);
        assert.match(String(result.reason), /dependencies missing \(@huggingface\/transformers\): run bun runtime\/install\.js/u);
    });

    it("turns a failed spawn into a reason rather than throwing at the caller", async () => {
        const client = fakeClient([{ ready: false, reason: "connect failed" }]);

        const result = await ensureRuntime({
            client,
            spawn: () => { throw new Error("bun is not on PATH"); },
            ...fakeClock(250),
            ...fakeStamp(),
        });

        assert.equal(result.ready, false);
        assert.equal(result.started, false);
        assert.match(String(result.reason), /could not start the runtime: bun is not on PATH/u);
    });
});

describe("what gets started", () => {
    it("resolves serve.js from this file, not from the cwd", () => {
        assert.match(servePath(), /runtime[/\\]serve\.js$/u);
        assert.equal(READY_TIMEOUT_MS, 5000);
    });
});

describe("a start that failed suppresses the next one", () => {
    const down = [{ ready: false, reason: "connect failed" }];

    // A wedged port -- something else listening, or a daemon dying on start --
    // otherwise costs a fresh detached process and the whole five-second wait
    // on every single search, forever.
    it("spawns nothing and waits for nothing when an attempt was made a moment ago", async () => {
        const client = fakeClient(down);
        const stamp = fakeStamp(0);
        const clock = fakeClock(250);
        let spawns = 0;

        const result = await ensureRuntime({ client, spawn: () => { spawns += 1; }, ...clock, ...stamp, now: () => 12_000 });

        assert.equal(spawns, 0);
        assert.equal(result.ready, false);
        assert.equal(result.started, false);
        assert.equal(result.reason, "runtime: autostart attempted 12s ago, not ready");
        assert.equal(clock.now(), 0, "it did not sleep through the window either");
    });

    it("tries again once the cooldown has passed, and stamps the attempt", async () => {
        const client = fakeClient(down);
        const stamp = fakeStamp(0);
        let spawns = 0;
        const at = AUTOSTART_COOLDOWN_MS + 1;

        const result = await ensureRuntime({
            client,
            spawn: () => { spawns += 1; },
            sleep: async () => {},
            now: () => at,
            timeoutMs: 0,
            ...stamp,
        });

        assert.equal(spawns, 1);
        assert.equal(stamp.state.at, at, "the attempt is stamped before the wait, so a crash still counts as an attempt");
        assert.equal(result.started, true);
    });

    it("stamps the first attempt on a box that has never started one", async () => {
        const stamp = fakeStamp(null);

        await ensureRuntime({ client: fakeClient(down), spawn: () => {}, sleep: async () => {}, now: () => 5000, timeoutMs: 0, ...stamp });

        assert.equal(stamp.state.at, 5000);
    });

    it("does not stamp, or cool down, a runtime that is already up", async () => {
        const stamp = fakeStamp(null);

        const result = await ensureRuntime({ client: fakeClient([{ ready: true }]), spawn: () => {}, ...stamp });

        assert.deepEqual(result, { ready: true, started: false });
        assert.equal(stamp.state.at, null);
    });
});
