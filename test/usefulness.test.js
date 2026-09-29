import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fakeApi, fakeRuntime, passThrough, promptInput, searchDocument } from "./fixtures.js";

/**
 * Two memories a prompt about a stopped cron job retrieves: one about a lock
 * and a watchdog, one about a database replica. An answer about the watchdog
 * echoes the first and not the second.
 */
const SEARCH = searchDocument(2, {
    results: [
        {
            rank: 1,
            memoryId: 11,
            title: "a stale flock blocks the monitor",
            body: "The watchdog clears monitor.lock after ninety minutes.",
            scores: { merge: 0.016, rerank: 2.1 },
        },
        {
            rank: 2,
            memoryId: 12,
            title: "replica lag on the staging postgres",
            body: "Dashboards read the replica, which trails the primary by seconds.",
            scores: { merge: 0.015, rerank: 1.4 },
        },
    ],
});

const ECHOING_ANSWER = "The watchdog clears the stale flock on monitor.lock after ninety minutes.";

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

/**
 * A `next` for `prompt.submit` that does what the engine does inside it: the
 * turn starts, and `turn.start` fires, before `next` resolves. `during` runs
 * after that, for a test that wants the whole turn to end inside it.
 */
const engineNext = (runtime, host, turnId, during = async () => {}) => {
    const next = passThrough();
    const wrapped = async (input) => {
        next(input);

        if (turnId !== null) {
            await runtime.dispatch("turn.start", host.$, { text: input.text, turnId }, passThrough());
        }

        await during();

        return { passedThrough: true };
    };

    wrapped.calls = next.calls;

    return wrapped;
};

const completed = (extra = {}) => ({
    answer: ECHOING_ANSWER,
    durationMs: 900,
    isAborted: false,
    turnId: "turn-1",
    reason: "answer",
    ...extra,
});

/** One prompt, its turn started under `turn-1`, and its `turn.complete` raised with `complete`. */
const oneTurn = async (host, { input = promptInput(), complete = completed() } = {}) => {
    const runtime = await started(host);

    await runtime.dispatch("prompt.submit", host.$, input, engineNext(runtime, host, "turn-1"));

    const next = passThrough();
    const answer = await runtime.dispatch("turn.complete", host.$, complete, next);

    return { runtime, answer, next };
};

const verdicts = (doc) => Object.fromEntries(doc.rows.map((row) => [row.memoryId, row.verdict]));

describe("a turn that was handed memories records whether each showed up", () => {
    it("records one row per injected memory, against the injection the prompt wrote", async () => {
        const host = fakeApi({ search: SEARCH });

        await oneTurn(host);

        const [doc] = host.adminDocs("echo");

        assert.equal(host.adminDocs("echo").length, 1);
        assert.equal(doc.injectionId, 1);
        assert.equal(doc.turnId, "turn-1");
        assert.deepEqual(verdicts(doc), { 11: "echoed", 12: "silent" });
        assert.ok(doc.rows.find((row) => row.memoryId === 11).echoed.includes("watchdog"));
    });

    // The model's work in a turn is mostly tool calls; a memory it acted on
    // shows up in a command before it shows up in the answer.
    it("reads what the model wrote into its tools during the turn, not only the answer", async () => {
        const host = fakeApi({
            search: SEARCH,
            messages: [
                { role: "user", text: "why did the cron job stop", toolUses: [] },
                {
                    role: "assistant",
                    text: "",
                    toolUses: [{ tool_use_id: "t1", tool: "Bash", input: { command: "grep watchdog ninety monitor.lock flock" } }],
                },
                { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "t1", text: "", isError: false }] },
            ],
        });

        await oneTurn(host, { complete: completed({ answer: "Fixed." }) });

        assert.deepEqual(verdicts(host.adminDocs("echo")[0]), { 11: "echoed", 12: "silent" });
    });

    it("hands turn.complete's own answer back up the chain", async () => {
        const host = fakeApi({ search: SEARCH });
        const { answer, next } = await oneTurn(host);

        assert.deepEqual(answer, { passedThrough: true });
        assert.equal(next.calls.length, 1);
    });

    it("scores a turn once, however often its end is reported", async () => {
        const host = fakeApi({ search: SEARCH });
        const { runtime } = await oneTurn(host);

        await runtime.dispatch("turn.complete", host.$, completed(), passThrough());

        assert.equal(host.adminDocs("echo").length, 1);
    });

    // The engine may end a short turn before prompt.submit has written the
    // injection row. The score waits for the row; nothing waits on a lock.
    it("records a turn that ended before the injection row was written", async () => {
        const host = fakeApi({ search: SEARCH });
        const runtime = await started(host);
        const next = engineNext(runtime, host, "turn-1", async () => {
            await runtime.dispatch("turn.complete", host.$, completed(), passThrough());

            assert.equal(host.adminDocs("echo").length, 0);
        });

        await runtime.dispatch("prompt.submit", host.$, promptInput(), next);

        assert.equal(host.adminDocs("echo").length, 1);
        assert.equal(host.adminDocs("echo")[0].injectionId, 1);
    });
});

describe("a turn records nothing when there is nothing honest to record", () => {
    it("records nothing when MEMORY_HANDOFF_LIVE is off", async () => {
        const host = fakeApi({ search: SEARCH, env: { MEMORY_HANDOFF_LIVE: "0" } });

        await oneTurn(host);

        assert.equal(host.adminDocs("injection").length, 1);
        assert.equal(host.adminDocs("echo").length, 0);
    });

    it("records nothing when injection is switched off", async () => {
        const host = fakeApi({ search: SEARCH, env: { MEMORY_HANDOFF_INJECT: "0" } });

        await oneTurn(host);

        assert.equal(host.adminDocs("echo").length, 0);
    });

    it("records nothing when the retrieval failed", async () => {
        const host = fakeApi({
            search: () => {
                throw new Error("timed out");
            },
        });

        await oneTurn(host);

        assert.equal(host.adminDocs("injection").length, 1);
        assert.equal(host.adminDocs("echo").length, 0);
    });

    it("records nothing when the retrieval found nothing to inject", async () => {
        const host = fakeApi({ search: searchDocument(0) });

        await oneTurn(host);

        assert.equal(host.adminDocs("echo").length, 0);
    });

    it("records nothing when the injection row was never written", async () => {
        const host = fakeApi({
            search: SEARCH,
            admin: (argv) => ({ exitCode: 0, stdout: `${JSON.stringify(argv.at(-1) === "injection" ? { ok: false, reason: "locked" } : { ok: true })}\n`, stderr: "" }),
        });

        await oneTurn(host);

        assert.equal(host.adminDocs("echo").length, 0);
    });

    // An interrupted turn wrote part of what it would have; silence there
    // would be read as "the memory was no use", which nobody observed.
    for (const reason of ["aborted", "error", "refusal"]) {
        it(`records nothing when the turn ended by ${reason}`, async () => {
            const host = fakeApi({ search: SEARCH });

            await oneTurn(host, { complete: completed({ reason, isAborted: reason === "aborted" }) });

            assert.equal(host.adminDocs("echo").length, 0);
        });
    }

    it("records nothing when the turn wrote nothing at all", async () => {
        const host = fakeApi({ search: SEARCH });

        await oneTurn(host, { complete: completed({ answer: "" }) });

        assert.equal(host.adminDocs("echo").length, 0);
    });

    it("leaves a subagent's turn alone and still scores the main loop's", async () => {
        const host = fakeApi({ search: SEARCH });
        const runtime = await started(host);

        await runtime.dispatch("prompt.submit", host.$, promptInput(), engineNext(runtime, host, "turn-1"));
        await runtime.dispatch("turn.complete", host.$, completed({ turnId: "turn-1", agentId: "agent-7" }), passThrough());

        assert.equal(host.adminDocs("echo").length, 0);

        await runtime.dispatch("turn.complete", host.$, completed(), passThrough());

        assert.equal(host.adminDocs("echo").length, 1);
    });

    it("leaves a turn that is not the one the memories went to alone", async () => {
        const host = fakeApi({ search: SEARCH });

        await oneTurn(host, { complete: completed({ turnId: "turn-other" }) });

        assert.equal(host.adminDocs("echo").length, 0);
    });

    // An injection whose turn never started must not be scored against the
    // next turn, which was handed nothing.
    it("does not carry memories over to the next prompt's turn", async () => {
        const host = fakeApi({ search: SEARCH });
        const runtime = await started(host);

        await runtime.dispatch("prompt.submit", host.$, promptInput(), engineNext(runtime, host, null));
        await runtime.dispatch("prompt.submit", host.$, promptInput({ origin: { kind: "sdk" } }), engineNext(runtime, host, "turn-2"));
        await runtime.dispatch("turn.complete", host.$, completed({ turnId: "turn-2" }), passThrough());

        assert.equal(host.adminDocs("echo").length, 0);
    });
});
