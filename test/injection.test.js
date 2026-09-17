import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    elementTable,
    fakeApi,
    fakeRuntime,
    paneLines,
    paneNodes,
    passThrough,
    promptInput,
    searchDocument,
} from "./fixtures.js";
import { composeInjection, injectionGate } from "../hooks/inject.js";
import { fit, paneTree } from "../hooks/pane.js";

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

/** One prompt, submitted, with the `next` it was handed back for inspection. */
const submitted = async (host, input = promptInput()) => {
    const runtime = await started(host);
    const next = passThrough();
    const answer = await runtime.dispatch("prompt.submit", host.$, input, next);

    return { runtime, next, answer };
};

/** The context the prompt carried down, whatever the hook did to it. */
const contextOf = (next) => next.calls.at(-1)?.context ?? [];

const HEADER = "Memories from earlier sessions (memory-handoff, retrieval 7)";

describe("who gets memories", () => {
    it("injects on the person's own Enter", async () => {
        const host = fakeApi();
        const { next } = await submitted(host);

        assert.equal(contextOf(next).length, 1);
        assert.ok(contextOf(next)[0].startsWith(HEADER));
        assert.equal(host.childrenOf("search").length, 1);
    });

    // The same person through Remote Control. A memory is no less theirs
    // because they are on a phone.
    it("injects on a prompt from the bridge", async () => {
        const host = fakeApi();
        const { next } = await submitted(host, promptInput({ origin: { kind: "bridge" } }));

        assert.equal(contextOf(next).length, 1);
    });

    // The deliberate one: the engine says it cannot attest where this came
    // from, and an unattributable turn is the last thing to hand memories to.
    it("leaves an unclassified prompt alone, and writes no row", async () => {
        const host = fakeApi();
        const { next } = await submitted(host, promptInput({ origin: { kind: "unclassified" } }));

        assert.equal(contextOf(next).length, 0);
        assert.equal(host.childrenOf("search").length, 0);
        assert.equal(host.adminDocs("injection").length, 0);
    });

    it("leaves a headless host's own turn alone", async () => {
        const host = fakeApi();
        const { next } = await submitted(host, promptInput({ origin: { kind: "sdk" } }));

        assert.equal(contextOf(next).length, 0);
        assert.equal(host.childrenOf("search").length, 0);
    });

    it("leaves a prompt delivered into a running turn alone", async () => {
        const host = fakeApi();
        const { next } = await submitted(host, promptInput({ turnId: "turn-1" }));

        assert.equal(contextOf(next).length, 0);
        assert.equal(host.adminDocs("injection").length, 0);
    });

    it("leaves a prompt with no text alone", async () => {
        const host = fakeApi();
        const { next } = await submitted(host, promptInput({ text: "   " }));

        assert.equal(contextOf(next).length, 0);
        assert.equal(host.childrenOf("search").length, 0);
    });

    it("gates on the origin without the runtime", () => {
        assert.equal(injectionGate(promptInput()).inject, true);
        assert.equal(injectionGate(promptInput({ origin: { kind: "unclassified" } })).inject, false);
        assert.equal(injectionGate({ text: "x" }).inject, false);
    });
});

describe("what goes down with the prompt", () => {
    it("keeps the entries next already carried and adds one block", async () => {
        const host = fakeApi();
        const { next } = await submitted(host, promptInput({ context: ["a settings hook's note"] }));

        assert.deepEqual(contextOf(next).slice(0, 1), ["a settings hook's note"]);
        assert.equal(contextOf(next).length, 2);
    });

    // A hook may put back the origin it received and may not set another, so
    // this one sets none at all.
    it("passes the origin down as it received it", async () => {
        const host = fakeApi();
        const input = promptInput();
        const { next } = await submitted(host, input);

        assert.deepEqual(next.calls.at(-1).origin, { kind: "composer" });
        assert.deepEqual(next.calls.at(-1).text, input.text);
    });

    it("numbers the memories under one header", async () => {
        const host = fakeApi();
        const { next } = await submitted(host);
        const block = contextOf(next)[0];

        assert.ok(block.includes("\n1. memory 1"));
        assert.ok(block.includes("\n2. memory 2"));
    });

    it("records the whole of what it attached", async () => {
        const host = fakeApi();
        const { next } = await submitted(host);
        const row = host.adminDocs("injection").at(0);
        const block = contextOf(next)[0];

        assert.deepEqual(row.memoryIds, [1, 2]);
        assert.equal(row.chars, block.length);
        assert.equal(row.approxTokens, Math.ceil(block.length / 4));
        assert.equal(row.retrievalId, 7);
        assert.equal(row.sessionId, "session-under-test");
        assert.equal(row.dropped, 0);
        assert.equal(row.clippedChars, 0);
        assert.equal(row.capEntries, 5);
        assert.equal(row.capChars, 4000);
    });

    it("sends the prompt over stdin, never on the argv", async () => {
        const host = fakeApi();
        const runtime = await started(host);

        await runtime.dispatch("prompt.submit", host.$, promptInput(), passThrough());

        const call = host.childrenOf("search").at(0);

        // `ps` is readable by everyone on the machine, and this argv carries
        // whatever the person typed.
        assert.equal(call.argv.includes("--query"), false);
        assert.ok(call.argv.includes("--query-stdin"));
        assert.equal(call.stdin, promptInput().text);
        assert.equal(call.argv.join(" ").includes(promptInput().text), false);
    });

    it("passes the session id down to the retrieval so the trace carries it", async () => {
        const host = fakeApi();

        await submitted(host);

        const argv = host.childrenOf("search").at(0).argv;

        assert.ok(argv.includes("--session-id"));
        assert.equal(argv[argv.indexOf("--session-id") + 1], "session-under-test");
        assert.equal(argv[argv.indexOf("--origin") + 1], "prompt");
    });
});

describe("the caps", () => {
    it("drops whole memories past the entry cap and records how many", async () => {
        const host = fakeApi({ env: { MEMORY_HANDOFF_INJECT_MAX_ENTRIES: "2" }, search: searchDocument(5) });
        const { next } = await submitted(host);
        const row = host.adminDocs("injection").at(0);

        assert.deepEqual(row.memoryIds, [1, 2]);
        assert.equal(row.dropped, 3);
        assert.ok(!contextOf(next)[0].includes("memory 3"));
    });

    it("drops the lowest-ranked memory rather than clipping one mid-body", async () => {
        const host = fakeApi({ env: { MEMORY_HANDOFF_INJECT_MAX_CHARS: "150" }, search: searchDocument(3) });
        const { next } = await submitted(host);
        const row = host.adminDocs("injection").at(0);

        assert.ok(contextOf(next)[0].length <= 150);
        assert.ok(row.memoryIds.length < 3);
        assert.equal(row.clippedChars, 0);
        assert.equal(row.dropped, 3 - row.memoryIds.length);
    });

    it("asks the retrieval for k, as the environment sets it", async () => {
        const host = fakeApi({ env: { MEMORY_HANDOFF_INJECT_K: "9" } });

        await submitted(host);

        const argv = host.childrenOf("search").at(0).argv;

        assert.equal(argv[argv.indexOf("--k") + 1], "9");
    });

    it("composes under both caps without a runtime", () => {
        const results = searchDocument(4).results;
        const composed = composeInjection(results, { maxEntries: 2, maxChars: 4000 }, 7);

        assert.equal(composed.entries.length, 2);
        assert.equal(composed.dropped, 2);
        assert.equal(composed.chars, composed.block.length);
        assert.equal(composed.clippedChars, 0);
    });
});

describe("when the retrieval does not answer", () => {
    // `$.process.run` rejects on its timeout rather than resolving with a
    // code, so the fake throws the way the engine does.
    it("lets the prompt through and says why, when the child times out", async () => {
        const host = fakeApi({
            search: () => {
                throw new Error("timed out after 2500ms");
            },
        });
        const { next } = await submitted(host);
        const row = host.adminDocs("injection").at(0);

        assert.equal(contextOf(next).length, 0);
        assert.equal(row.retrievalId, null);
        assert.deepEqual(row.memoryIds, []);
        assert.equal(row.chars, 0);
        assert.ok(row.failure.reason.includes("2500ms"));
        assert.equal(row.failure.query, promptInput().text);
        assert.equal(row.failure.origin, "prompt");
    });

    it("lets the prompt through and says why, when the child exits non-zero", async () => {
        const host = fakeApi({ search: () => ({ exitCode: 1, stdout: "", stderr: "no such database" }) });
        const { next } = await submitted(host);
        const row = host.adminDocs("injection").at(0);

        assert.equal(contextOf(next).length, 0);
        assert.ok(row.failure.reason.includes("exited 1"));
        assert.ok(row.failure.reason.includes("no such database"));
    });

    it("bounds the child at the timeout the environment sets", async () => {
        const host = fakeApi({ env: { MEMORY_HANDOFF_INJECT_TIMEOUT_MS: "1400" } });

        await submitted(host);

        const call = host.childrenOf("search").at(0);

        assert.equal(call.timeoutMs, 1400);
        assert.equal(call.argv[call.argv.indexOf("--runtime-timeout-ms") + 1], "700", "the margin for the bun start and the tail after the wait");
    });
});

describe("rehearsing", () => {
    it("retrieves, records and attaches nothing", async () => {
        const host = fakeApi({ env: { MEMORY_HANDOFF_LIVE: "" } });
        const { next } = await submitted(host);
        const row = host.adminDocs("injection").at(0);

        assert.equal(host.childrenOf("search").length, 1);
        assert.equal(contextOf(next).length, 0);
        assert.equal(row.retrievalId, 7);
        assert.deepEqual(row.memoryIds, []);
        assert.equal(row.chars, 0);
        assert.equal(row.approxTokens, 0);
        // Everything the retrieval found, and none of it attached: the pair of
        // rows is what says "rehearsed" while the schema has no column for it.
        assert.equal(row.dropped, 2);
        assert.equal(row.failure, undefined);
    });
});

describe("the tools", () => {
    const call = async (host, tool, input = {}) => {
        const runtime = await started(host);
        const answer = await runtime.dispatch("tool.call", host.$, { tool, ...input }, passThrough());

        return JSON.parse(answer.result);
    };

    it("registers every tool at session.start", async () => {
        const host = fakeApi();

        await started(host);

        assert.deepEqual(
            host.tools.map((spec) => spec.name).sort(),
            ["before_compact", "memory_delete", "memory_explain", "memory_list", "memory_search", "memory_status"],
        );
    });

    it("memory_search parses the child's document and traces the call as a tool", async () => {
        const host = fakeApi();
        const answer = await call(host, "mcp__memory-handoff__memory_search", { query: "cron", k: 3 });
        const argv = host.childrenOf("search").at(0).argv;

        assert.equal(answer.ok, true);
        assert.equal(answer.retrievalId, 7);
        assert.equal(answer.results.length, 2);
        assert.equal(argv[argv.indexOf("--origin") + 1], "tool");
        assert.equal(argv[argv.indexOf("--k") + 1], "3");
    });

    it("memory_search sends its query over stdin too", async () => {
        const host = fakeApi();

        await call(host, "mcp__memory-handoff__memory_search", { query: "cron" });

        const ran = host.childrenOf("search").at(0);

        assert.equal(ran.argv.includes("--query"), false);
        assert.ok(ran.argv.includes("--query-stdin"));
        assert.equal(ran.stdin, "cron");
    });

    it("memory_search refuses a call with no query rather than searching for nothing", async () => {
        const host = fakeApi();
        const answer = await call(host, "mcp__memory-handoff__memory_search", { query: "  " });

        assert.equal(answer.ok, false);
        assert.equal(host.childrenOf("search").length, 0);
    });

    it("memory_explain reads one trace back", async () => {
        const host = fakeApi();
        const answer = await call(host, "mcp__memory-handoff__memory_explain", { retrievalId: 7 });

        assert.equal(answer.ok, true);
        assert.equal(answer.retrieval.id, 7);
        assert.ok(host.childrenOf("explain").at(0).argv.includes("--json"));
    });

    it("memory_explain refuses an id that is not one", async () => {
        const host = fakeApi();
        const answer = await call(host, "mcp__memory-handoff__memory_explain", { retrievalId: "recent" });

        assert.equal(answer.ok, false);
        assert.equal(host.childrenOf("explain").length, 0);
    });

    it("memory_list asks the admin child for this project's memories", async () => {
        const host = fakeApi();
        const answer = await call(host, "mcp__memory-handoff__memory_list", { limit: 5 });

        assert.equal(answer.ok, true);
        assert.deepEqual(host.adminDocs("list").at(0), { project: "github.com/owner/repo", limit: 5 });
    });

    it("memory_delete tombstones by default and purges when asked", async () => {
        const host = fakeApi();
        const tombstoned = await call(host, "mcp__memory-handoff__memory_delete", { id: 4 });

        assert.equal(tombstoned.mode, "tombstoned");
        assert.deepEqual(host.adminDocs("delete").at(0), { id: 4, purge: false });

        const purged = await call(host, "mcp__memory-handoff__memory_delete", { id: 4, purge: true });

        assert.equal(purged.mode, "purged");
    });

    it("memory_status reports the session, the store and the spend", async () => {
        const host = fakeApi();
        const runtime = await started(host);

        await runtime.dispatch("prompt.submit", host.$, promptInput(), passThrough());

        const answer = JSON.parse(
            (await runtime.dispatch("tool.call", host.$, { tool: "mcp__memory-handoff__memory_status" }, passThrough())).result,
        );

        assert.equal(answer.session.injections, 1);
        assert.equal(answer.session.retrievals, 1);
        assert.equal(answer.session.memoriesInjected, 2);
        assert.ok(answer.session.charsInjected > 0);
        assert.equal(answer.session.budgetUsd, 1);
        assert.equal(answer.database.spend.unpricedRows, 1);
        assert.ok(answer.dbPath.endsWith("/memory.sqlite"));
    });

    it("answers rather than throwing when a tool's own child fails", async () => {
        const host = fakeApi({ admin: { ok: false, reason: "no memory 9 in this database" } });
        const answer = await call(host, "mcp__memory-handoff__memory_delete", { id: 9 });

        assert.equal(answer.ok, false);
    });
});

describe("the pane", () => {
    const render = async (runtime, host, requestId = "memory-handoff") =>
        runtime.dispatch(
            "ui.render",
            host.$,
            { surface: "terminal", component: "Pane", requestId, props: { bodyColumns: 80 }, viewport: { columns: 80 } },
            passThrough(),
        );

    it("opens once, on the first injection, and redraws after each", async () => {
        const host = fakeApi();
        const runtime = await started(host);

        assert.equal(host.opens.length, 0);

        await runtime.dispatch("prompt.submit", host.$, promptInput(), passThrough());
        await runtime.dispatch("prompt.submit", host.$, promptInput(), passThrough());

        assert.equal(host.opens.length, 1);
        assert.deepEqual(host.opens[0], { id: "memory-handoff", title: "Memories" });
        assert.equal(host.invalidations.length, 2);
        assert.deepEqual(host.invalidations, ["ui.render", "ui.render"]);
    });

    it("opens again in the next session, whatever the last one left in the store", async () => {
        const host = fakeApi();
        const first = await started(host);

        await first.dispatch("prompt.submit", host.$, promptInput(), passThrough());
        await first.dispatch("ui.close", host.$, { id: "memory-handoff", origin: { kind: "person" } }, passThrough());

        // The same store, because `$.store` is one file the plugin keeps
        // between sessions; a session's pane state must not be in it.
        const second = await started(host);

        await second.dispatch("prompt.submit", host.$, promptInput(), passThrough());

        assert.equal(host.opens.length, 2, "the second session opens its own pane");
        assert.equal(host.adminDocs("injection").length, 2);
    });

    it("stays closed once the person closes it", async () => {
        const host = fakeApi();
        const runtime = await started(host);

        await runtime.dispatch("prompt.submit", host.$, promptInput(), passThrough());
        await runtime.dispatch("ui.close", host.$, { id: "memory-handoff", origin: { kind: "person" } }, passThrough());
        await runtime.dispatch("prompt.submit", host.$, promptInput(), passThrough());

        assert.equal(host.opens.length, 1);
        assert.equal(host.invalidations.length, 1);
    });

    it("reopens after a close that was not the person's", async () => {
        const host = fakeApi();
        const runtime = await started(host);

        await runtime.dispatch("prompt.submit", host.$, promptInput(), passThrough());
        await runtime.dispatch("ui.close", host.$, { id: "memory-handoff", origin: { kind: "plugin" } }, passThrough());
        await runtime.dispatch("prompt.submit", host.$, promptInput(), passThrough());

        assert.equal(host.invalidations.length, 2);
    });

    it("logs an open that fails rather than swallowing it", async () => {
        const host = fakeApi({
            open: async () => {
                throw new Error("no surface");
            },
        });
        const runtime = await started(host);

        await runtime.dispatch("prompt.submit", host.$, promptInput(), passThrough());

        assert.equal(host.logs.length, 1);
        assert.ok(host.logs[0].includes("no surface"));
    });

    it("leaves another plugin's pane to its own hook", async () => {
        const host = fakeApi();
        const runtime = await started(host);
        const answer = await render(runtime, host, "somebody-elses-pane");

        assert.deepEqual(answer, { passedThrough: true });
    });

    it("draws this session's injections with Box and Text alone", async () => {
        const host = fakeApi();
        const runtime = await started(host);

        await runtime.dispatch("prompt.submit", host.$, promptInput(), passThrough());

        const tree = await render(runtime, host);
        const nodes = paneNodes(tree);

        assert.ok(nodes.length > 0);
        assert.deepEqual([...new Set(nodes.map((node) => node.element))].sort(), ["Box", "Text"]);
        // Every child goes in `props.children`: a positional child draws an
        // empty frame and still settles the dispatch.
        assert.ok(nodes.every((node) => node.props.children !== undefined || node.element === "Text"));
    });

    it("draws no line wider than the pane", async () => {
        const host = fakeApi({ search: searchDocument(3, { retrievalId: 12 }) });
        const runtime = await started(host);

        await runtime.dispatch("prompt.submit", host.$, promptInput({ text: "x".repeat(400) }), passThrough());

        const lines = paneLines(await render(runtime, host));

        assert.ok(lines.length > 0);
        assert.ok(lines.every((line) => line.length <= 80), lines.find((line) => line.length > 80));
    });

    it("names the prompt, the trace and each memory's final score", async () => {
        const host = fakeApi();
        const runtime = await started(host);

        await runtime.dispatch("prompt.submit", host.$, promptInput(), passThrough());

        const lines = paneLines(await render(runtime, host));

        assert.ok(lines.some((line) => line.includes("why did the cron job stop")));
        assert.ok(lines.some((line) => line.includes("retrieval 7")));
        assert.ok(lines.some((line) => line.includes("rerank 2.2500")));
    });

    it("says so while it is rehearsing", async () => {
        const host = fakeApi({ env: { MEMORY_HANDOFF_LIVE: "" } });
        const runtime = await started(host);

        await runtime.dispatch("prompt.submit", host.$, promptInput(), passThrough());

        const lines = paneLines(await render(runtime, host));

        assert.ok(lines.some((line) => line.includes("rehearsing")));
    });

    it("draws an empty pane without a runtime", () => {
        const tree = paneTree(elementTable(), { live: true, dbPath: "/tmp/memory.sqlite", injections: [] }, 80);

        assert.ok(paneLines(tree).some((line) => line.includes("Nothing injected yet")));
        assert.equal(fit("a".repeat(100), 20).length, 20);
    });
});
