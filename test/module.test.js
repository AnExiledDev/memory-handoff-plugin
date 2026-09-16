import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { compactInput, fakeApi, fakeRuntime, fakeSeam, forkReply, passThrough } from "./fixtures.js";

// `node --check` reads module.js as a script and never sees an `await` in a
// non-async arrow, so importing it is the only cheap parse that matches how the
// runtime loads it.
describe("the hooks module parses as the runtime loads it", () => {
    it("imports and exports register", async () => {
        const mod = await import("../hooks/module.js");

        assert.equal(typeof mod.register, "function");
    });
});

const registered = async () => {
    const runtime = fakeRuntime();

    (await import("../hooks/module.js")).register(runtime.on);

    return runtime;
};

const started = async (host) => {
    const runtime = await registered();

    await runtime.dispatch("session.start", host.$, { sessionId: "session-under-test" }, passThrough());

    return runtime;
};

describe("beside compact-handoff, the seam carries the compaction", () => {
    it("subscribes under its own name at session.start", async () => {
        const seam = fakeSeam();
        const host = fakeApi({ seam: seam.noun });

        await started(host);

        assert.equal(seam.subscribers.length, 1);
        assert.equal(seam.subscribers[0].name, "memory-handoff");
        assert.equal(host.store.get("seam").present, true);
        assert.equal(host.store.get("seam").version, "0.4.3");
    });

    // The double spend the seam exists to prevent: if this plugin is outermost
    // it sees the event first, and must leave the fork to the seam call.
    it("forks nothing in its own hook and still calls next", async () => {
        const seam = fakeSeam();
        let forks = 0;
        const host = fakeApi({
            seam: seam.noun,
            fork: async () => {
                forks += 1;

                return forkReply();
            },
        });
        const runtime = await started(host);
        const next = passThrough();

        await runtime.dispatch("session.compact", host.$, compactInput(), next);

        assert.equal(forks, 0);
        assert.equal(host.rowsIn("index.jsonl").length, 0);
        assert.equal(next.calls.length, 1);
    });

    it("forks once when the seam fires, and the row says so", async () => {
        const seam = fakeSeam();
        let forks = 0;
        const host = fakeApi({
            seam: seam.noun,
            fork: async () => {
                forks += 1;

                return forkReply(3);
            },
        });

        await started(host);
        await seam.fire(compactInput());

        const rows = host.rowsIn("index.jsonl");

        assert.equal(forks, 1);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].via, "seam");
        assert.equal(rows[0].outcome, "extracted");
        assert.equal(rows[0].candidates, 3);
    });
});

describe("alone, the plugin's own session.compact hook carries it", () => {
    it("forks once and hands the compaction on to the engine", async () => {
        let forks = 0;
        const host = fakeApi({
            fork: async () => {
                forks += 1;

                return forkReply();
            },
        });
        const runtime = await started(host);
        const next = passThrough();

        const answer = await runtime.dispatch("session.compact", host.$, compactInput(), next);

        const rows = host.rowsIn("index.jsonl");

        assert.equal(forks, 1);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].via, "hook");
        assert.equal(next.calls.length, 1);
        // Never an answer of its own: whatever `next` returned is what the
        // engine gets back, so the compaction is unchanged by installing this.
        assert.deepEqual(answer, { passedThrough: true });
    });

    it("spends nothing on a precompute and passes it through", async () => {
        let forks = 0;
        const host = fakeApi({
            fork: async () => {
                forks += 1;

                return forkReply();
            },
        });
        const runtime = await started(host);
        const next = passThrough();

        const answer = await runtime.dispatch("session.compact", host.$, compactInput({ trigger: "precompute" }), next);

        assert.equal(forks, 0);
        assert.equal(host.rowsIn("index.jsonl").length, 0);
        assert.deepEqual(answer, { passedThrough: true });
    });

    it("passes a subagent's compaction through with a row and no fork", async () => {
        let forks = 0;
        const host = fakeApi({
            fork: async () => {
                forks += 1;

                return forkReply();
            },
        });
        const runtime = await started(host);
        const next = passThrough();

        await runtime.dispatch("session.compact", host.$, compactInput({ agentId: "agent-1" }), next);

        const rows = host.rowsIn("index.jsonl");

        assert.equal(forks, 0);
        assert.equal(rows[0].outcome, "subagent");
        assert.equal(next.calls.length, 1);
    });

    it("rehearses until MEMORY_HANDOFF_LIVE is on", async () => {
        let forks = 0;
        const host = fakeApi({
            env: { MEMORY_HANDOFF_LIVE: "" },
            fork: async () => {
                forks += 1;

                return forkReply();
            },
        });
        const runtime = await started(host);

        await runtime.dispatch("session.compact", host.$, compactInput(), passThrough());

        assert.equal(forks, 0);
        assert.equal(host.rowsIn("index.jsonl")[0].outcome, "rehearsed");
    });
});

describe("a generation that fails costs a row and nothing else", () => {
    it("a throwing fork still calls next and still writes a row", async () => {
        const host = fakeApi({
            fork: async () => {
                throw new Error("the model said no");
            },
        });
        const runtime = await started(host);
        const next = passThrough();

        await runtime.dispatch("session.compact", host.$, compactInput(), next);

        const rows = host.rowsIn("index.jsonl");

        assert.equal(rows.length, 1);
        assert.equal(rows[0].outcome, "threw");
        assert.match(rows[0].detail, /the model said no/u);
        assert.equal(rows[0].usage, null);
        assert.equal(next.calls.length, 1);
    });

    it("a cold fork is its own outcome, never a zero-cost success", async () => {
        const host = fakeApi({ fork: async () => null });
        const runtime = await started(host);

        await runtime.dispatch("session.compact", host.$, compactInput(), passThrough());

        assert.equal(host.rowsIn("index.jsonl")[0].outcome, "cold");
    });

    // The engine's own `$.clock.now()` answers a Promise, so a duration built
    // on it is NaN and serialises as null. Everything here is `Date.now()`.
    it("times itself even though the engine's clock answers a Promise", async () => {
        const host = fakeApi();
        const runtime = await started(host);

        await runtime.dispatch("session.compact", host.$, compactInput(), passThrough());

        const row = host.rowsIn("index.jsonl")[0];

        assert.equal(typeof row.elapsedMs, "number");
        assert.ok(Number.isFinite(row.elapsedMs));
    });
});

describe("the row a compaction leaves behind", () => {
    it("carries the fork's usage, the context it ran over, and where the reply went", async () => {
        const host = fakeApi();
        const runtime = await started(host);

        await runtime.dispatch("session.compact", host.$, compactInput(), passThrough());

        const row = host.rowsIn("index.jsonl")[0];

        assert.equal(row.sessionId, "session-under-test");
        assert.equal(row.cwd, "/repo");
        assert.equal(row.trigger, "manual");
        assert.equal(row.model, "claude-sonnet-5");
        assert.equal(row.plugin, "0.1.0-test");
        assert.equal(row.messagesIn, 2);
        assert.equal(row.live, true);
        assert.equal(row.n, 0);
        // The warm-fork reading: a cold fork shows up as cache_read near zero.
        assert.equal(row.usage.cache_read_input_tokens, 48_000);
        assert.equal(row.context.tokens, 48_000);
        assert.equal(row.replyFile, "/home/nobody/.claude/memory-handoff/sessions/session-under-test/0.json");

        const stored = JSON.parse(host.files.get(row.replyFile));

        assert.equal(stored.via, "hook");
        assert.match(stored.prompt, /Answer with JSON/u);
        assert.match(stored.text, /memories/u);
    });

    it("counts one row per compaction and numbers them", async () => {
        const host = fakeApi();
        const runtime = await started(host);

        await runtime.dispatch("session.compact", host.$, compactInput(), passThrough());
        await runtime.dispatch("session.compact", host.$, compactInput(), passThrough());

        assert.deepEqual(
            host.rowsIn("index.jsonl").map((row) => row.n),
            [0, 1],
        );
    });

    it("records a reply that is not the JSON asked for, with no count", async () => {
        const host = fakeApi({ fork: async () => ({ text: "I would rather not.", usage: {} }) });
        const runtime = await started(host);

        await runtime.dispatch("session.compact", host.$, compactInput(), passThrough());

        const row = host.rowsIn("index.jsonl")[0];

        assert.equal(row.outcome, "extracted");
        assert.equal(row.candidates, null);
        assert.equal(row.replyChars, 19);
    });
});

describe("memory_status", () => {
    it("registers and answers with the row count and the last row", async () => {
        const host = fakeApi();
        const runtime = await started(host);

        assert.deepEqual(
            host.tools.map((spec) => spec.name),
            ["memory_status"],
        );

        await runtime.dispatch("session.compact", host.$, compactInput(), passThrough());

        // The tool reads the log back off disk, which the fake appends to
        // rather than writes, so seed it from what was appended.
        host.files.set(
            "/home/nobody/.claude/memory-handoff/index.jsonl",
            host.appends.map((entry) => entry.line).join("\n"),
        );

        const answer = await runtime.dispatch(
            "tool.call",
            host.$,
            { tool: "mcp__memory-handoff__memory_status" },
            passThrough(),
        );
        const report = JSON.parse(answer.result);

        assert.equal(report.rows, 1);
        assert.equal(report.live, true);
        assert.equal(report.dir, "/home/nobody/.claude/memory-handoff");
        assert.equal(report.seam.present, false);
        assert.equal(report.last.via, "hook");
    });
});
