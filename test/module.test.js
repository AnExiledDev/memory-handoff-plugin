import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { SEAM_TOOL, compactInput, fakeApi, fakeRuntime, fakeSeam, forkReply, passThrough } from "./fixtures.js";

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
    it("hands compact-handoff a tool name at session.start and records the reading", async () => {
        const seam = fakeSeam();
        const host = fakeApi({ seam: seam.noun });

        await started(host);

        assert.equal(seam.subscribers.length, 1);
        assert.equal(seam.subscribers[0].tool, SEAM_TOOL);
        assert.equal(seam.subscribers[0].name, "memory-handoff");
        assert.deepEqual(host.store.get("seam"), {
            present: true,
            version: "0.6.0",
            detail: null,
            at: host.store.get("seam").at,
        });
    });

    // Reading a noun that is not there throws, and that throw is the whole of
    // the detection: there is no `typeof` check, because the engine's static
    // scan refuses a noun of `$` read as a value.
    it("records the seam as absent when the noun is not on $", async () => {
        const host = fakeApi();

        await started(host);

        const reading = host.store.get("seam");

        assert.equal(reading.present, false);
        assert.equal(reading.version, null);
        assert.equal(typeof reading.detail, "string");
        assert.ok(reading.detail.length > 0);
    });

    it("records the seam as absent when subscribing throws", async () => {
        const host = fakeApi({
            seam: {
                beforeCompact: async () => {
                    throw new Error("no room for another subscriber");
                },
                version: async () => "0.6.0",
            },
        });

        await started(host);

        assert.equal(host.store.get("seam").present, false);
        assert.match(host.store.get("seam").detail, /no room/u);
    });

    // The double spend the seam exists to prevent: if this plugin is outermost
    // it sees the event first, and must leave the fork to the raise.
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

    it("forks once when the tool is raised, and the row says so", async () => {
        const seam = fakeSeam();
        let forks = 0;
        const host = fakeApi({
            seam: seam.noun,
            fork: async () => {
                forks += 1;

                return forkReply(3);
            },
        });

        const runtime = await started(host);

        await seam.raise(runtime, host.$, { trigger: "auto", messageCount: 412 });

        const rows = host.rowsIn("index.jsonl");

        assert.equal(forks, 1);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].via, "seam");
        assert.equal(rows[0].outcome, "extracted");
        assert.equal(rows[0].parsedRows, 3);
        assert.equal(rows[0].rejectedRows, 0);
        assert.equal(rows[0].memoriesWritten, 3);
        assert.equal(rows[0].writeOutcome, "wrote");
        // The messages cannot cross the boundary, so the count is what the
        // raise carries and the fork reads the live session itself.
        assert.equal(rows[0].trigger, "auto");
        assert.equal(rows[0].messagesIn, 412);
        assert.deepEqual(rows[0].raise.keys, ["tool", "trigger", "messageCount"]);
    });

    it("answers the raise with what happened and never calls next", async () => {
        const seam = fakeSeam();
        const host = fakeApi({ seam: seam.noun });
        const runtime = await started(host);
        const next = passThrough();

        await runtime.dispatch("session.start", host.$, {}, passThrough());

        const answer = await runtime.dispatch(
            "tool.call",
            host.$,
            { tool: SEAM_TOOL, trigger: "manual", messageCount: 2 },
            next,
        );

        assert.equal(answer.result.outcome, "extracted");
        assert.equal(typeof answer.result.n, "number");
        assert.equal(typeof answer.result.elapsedMs, "number");
        assert.equal(next.calls.length, 0);
    });

    // Live run C: with the tool unregistered the engine refused the raise with
    // `no tool named "mcp__memory-handoff__before_compact" in this session`, so
    // registering it is not optional. There is no way to hide it from the model.
    it("registers the raised tool at session.start, with the seam fields required", async () => {
        const host = fakeApi({ seam: fakeSeam().noun });

        await started(host);

        const spec = host.tools.find((entry) => entry.name === "before_compact");

        assert.equal(typeof spec.description, "string");
        assert.match(spec.description, /compact-handoff/u);
        assert.deepEqual(spec.inputSchema.required, ["trigger", "messageCount"]);
        assert.deepEqual(Object.keys(spec.inputSchema.properties), ["trigger", "messageCount"]);
    });

    it("denies a call that does not carry the seam fields, and says so on a row", async () => {
        let forks = 0;
        const host = fakeApi({
            seam: fakeSeam().noun,
            fork: async () => {
                forks += 1;

                return forkReply();
            },
        });
        const runtime = await started(host);

        const answer = await runtime.dispatch(
            "tool.call",
            host.$,
            { tool: SEAM_TOOL, tool_use_id: "toolu_1" },
            passThrough(),
        );

        const rows = host.rowsIn("index.jsonl");

        assert.match(answer.deny, /not a tool for the model/u);
        assert.equal(answer.result, undefined);
        assert.equal(forks, 0);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].outcome, "denied");
        assert.equal(rows[0].via, "seam");
    });

    it("records what the engine filled in on the raise", async () => {
        const seam = fakeSeam();
        const host = fakeApi({ seam: seam.noun });
        const runtime = await started(host);

        await runtime.dispatch(
            "tool.call",
            host.$,
            { tool: SEAM_TOOL, tool_use_id: "toolu_2", trigger: "manual", messageCount: 9, messages: [1, 2] },
            passThrough(),
        );

        const row = host.rowsIn("index.jsonl")[0];

        assert.equal(row.raise.hasToolUseId, true);
        // The messages never travel, so the field is dropped rather than
        // counted: the row is a note about the raise, not a copy of it.
        assert.deepEqual(row.raise.keys, ["tool", "tool_use_id", "trigger", "messageCount"]);
    });

    it("answers the raise even when the generation throws", async () => {
        const seam = fakeSeam();
        const host = fakeApi({
            seam: seam.noun,
            session: {
                usage: async () => {
                    throw new Error("nothing answers here");
                },
            },
            fork: async () => {
                throw new Error("the model said no");
            },
        });
        const runtime = await started(host);

        const answer = await seam.raise(runtime, host.$);

        assert.equal(answer.result.outcome, "threw");
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
        assert.match(stored.prompt, /Answer with a single `<memories>` block/u);
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

    it("records prose with no block as an empty generation, and never asks again", async () => {
        let forks = 0;
        const host = fakeApi({
            fork: async () => {
                forks += 1;

                return { text: "I would rather not.", usage: {} };
            },
        });
        const runtime = await started(host);

        await runtime.dispatch("session.compact", host.$, compactInput(), passThrough());

        const row = host.rowsIn("index.jsonl")[0];

        // No repair call: a fork that ignored the format is one fork and one
        // recorded miss, never a second paid attempt.
        assert.equal(forks, 1);
        assert.equal(row.outcome, "empty");
        assert.equal(row.parsedRows, 0);
        assert.equal(row.rejectedRows, 1);
        assert.deepEqual(row.rejected, [{ line: 0, reason: "no block" }]);
        assert.equal(row.replyChars, 19);
    });
});

describe("memory_status", () => {
    it("registers and answers with the row count and the last row", async () => {
        const host = fakeApi();
        const runtime = await started(host);

        assert.deepEqual(
            host.tools.map((spec) => spec.name),
            ["before_compact", "memory_status"],
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

// Every pattern here is a spelling the engine's static scan refuses, measured
// against module.js as text because the refusal happens before the module is
// ever loaded. 0.1.0 was refused at load for the first and the third.
describe("the module is spelled the way the engine's scan takes", () => {
    const moduleSource = readFileSync(new URL("../hooks/module.js", import.meta.url), "utf8");

    it("never optionally chains a noun of $", () => {
        // "$.<noun> is used as a value": `$.compactHandoff?.beforeCompact`.
        assert.equal(/\$\.[A-Za-z_$][\w$]*\?\./u.test(moduleSource), false);
    });

    it("never reaches a noun of $ by computed key", () => {
        // The scan reads `$.noun.event` literally, so `$["noun"]` is refused.
        assert.equal(/\$\[/u.test(moduleSource), false);
    });

    it("never binds, passes or returns a noun of $ as a value", () => {
        // `const seam = $.compactHandoff;` and `f($.store)` both refuse.
        assert.equal(/\$\.[A-Za-z_$][\w$]*\s*[;,)]/u.test(moduleSource), false);
    });

    it("raises the seam tool by its literal name", () => {
        // The runtime allowlist is built from literal calls, and the tool this
        // plugin answers must be the one compact-handoff was handed.
        assert.match(moduleSource, /"mcp__memory-handoff__before_compact"/u);
    });
});
