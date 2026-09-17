import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ensureRuntime, READY_TIMEOUT_MS, servePath } from "../retrieval/ensure-runtime.js";

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

        const result = await ensureRuntime({ client, spawn: () => { spawns += 1; }, ...clock });

        assert.deepEqual(result, { ready: true, started: true });
        assert.equal(spawns, 1, "one daemon, not one per poll");
    });

    // The rule this whole module exists for: a slow model load must never hold
    // a prompt open. The wait is bounded and the caller is told to go on.
    it("gives up at the deadline and hands back a reason instead of blocking", async () => {
        const client = fakeClient([{ ready: false, reason: "connect failed" }, { ready: false, reason: "still loading" }]);
        const clock = fakeClock(250);

        const result = await ensureRuntime({ client, spawn: () => {}, ...clock, timeoutMs: 1000, pollMs: 250 });

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

    it("turns a failed spawn into a reason rather than throwing at the caller", async () => {
        const client = fakeClient([{ ready: false, reason: "connect failed" }]);

        const result = await ensureRuntime({
            client,
            spawn: () => { throw new Error("bun is not on PATH"); },
            ...fakeClock(250),
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
