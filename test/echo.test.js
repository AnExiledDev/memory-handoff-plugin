import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ECHO_MIN_TERMS, echoOf, termsOf, turnWriting } from "../hooks/echo.js";

const memory = {
    title: "The monitor cron stops when flock is held",
    body: "A stale flock on monitor.lock blocks every tick; the watchdog clears it after ninety minutes.",
};

describe("what counts as a word worth echoing", () => {
    it("keeps content words and drops the short and the common ones", () => {
        const terms = termsOf("The watchdog clears it after ninety minutes, and that is that.");

        assert.ok(terms.has("watchdog"));
        assert.ok(terms.has("ninety"));
        assert.ok(!terms.has("the"));
        assert.ok(!terms.has("it"));
        assert.ok(!terms.has("that"));
        assert.ok(!terms.has("after"));
    });

    // "locks" in the memory and "lock" in the answer are one word to a reader.
    it("folds a plural onto its singular, and leaves a double s alone", () => {
        assert.deepEqual([...termsOf("locks lock")], ["lock"]);
        assert.ok(termsOf("process").has("process"));
    });

    it("reads a non-string as no words", () => {
        assert.equal(termsOf(undefined).size, 0);
        assert.equal(termsOf(null).size, 0);
    });
});

describe("whether a memory was echoed", () => {
    it("is echoed when the turn wrote back enough of the memory's own words", () => {
        const echo = echoOf(memory, "why did the job stop", "The watchdog clears the stale flock on monitor.lock after ninety minutes.");

        assert.equal(echo.verdict, "echoed");
        assert.ok(echo.echoedTerms >= ECHO_MIN_TERMS);
        assert.ok(echo.echoed.includes("watchdog"));
    });

    it("is silent when the turn wrote none of them", () => {
        const echo = echoOf(memory, "why did the job stop", "Restart the service and check the logs.");

        assert.equal(echo.verdict, "silent");
        assert.equal(echo.echoedTerms, 0);
        assert.ok(echo.distinctTerms > 0);
    });

    // The prompt already said "cron" and "monitor"; an answer repeating the
    // question is not evidence the memory was read.
    it("does not count a word the prompt already carried", () => {
        const echo = echoOf(memory, "the monitor cron stops, why", "The monitor cron stops because of the monitor cron.");

        assert.equal(echo.verdict, "silent");
        assert.ok(!echo.echoed.includes("monitor"));
        assert.ok(!echo.echoed.includes("cron"));
    });

    it("is silent below the threshold", () => {
        const echo = echoOf(memory, "why did the job stop", "Something about a watchdog.");

        assert.equal(echo.echoedTerms, 1);
        assert.equal(echo.verdict, "silent");
    });

    // A memory with two distinctive words cannot echo three; both is all of it.
    it("asks a short memory for every distinctive word it has, not more", () => {
        const short = { title: "flock watchdog", body: "" };

        assert.equal(echoOf(short, "why", "the flock and the watchdog").verdict, "echoed");
        assert.equal(echoOf(short, "why", "the flock").verdict, "silent");
    });

    // Every word of the memory was already in the prompt: nothing it could add
    // is observable, so the verdict says so rather than guessing either way.
    it("is indistinct when the prompt already carried every word of the memory", () => {
        const echo = echoOf({ title: "cron stops", body: "" }, "the cron stops", "cron stops");

        assert.equal(echo.verdict, "indistinct");
        assert.equal(echo.distinctTerms, 0);
    });

    it("keeps a bounded, sorted sample of the words that echoed", () => {
        const long = { title: "", body: Array.from({ length: 30 }, (_, i) => `wordnumber${i}x`).join(" ") };
        const echo = echoOf(long, "", long.body);

        assert.equal(echo.echoedTerms, 30);
        assert.ok(echo.echoed.length <= 12);
        assert.deepEqual(echo.echoed, [...echo.echoed].sort());
    });
});

describe("what the turn wrote", () => {
    const messages = [
        { role: "user", text: "an earlier prompt", toolUses: [] },
        { role: "assistant", text: "an earlier answer about flock", toolUses: [] },
        { role: "user", text: "why did the job stop", toolUses: [] },
        {
            role: "assistant",
            text: "Looking at the lock.",
            toolUses: [{ tool_use_id: "t1", tool: "Bash", input: { command: "ls monitor.lock", timeout: 5 }, result: "RESULTWORD" }],
        },
        { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "t1", text: "RESULTWORD", isError: false }] },
        { role: "assistant", text: "Found the watchdog.", toolUses: [] },
    ];

    it("is the assistant's text and tool arguments since the prompt, plus the answer", () => {
        const writing = turnWriting(messages, "The final answer.");

        assert.ok(writing.includes("Looking at the lock."));
        assert.ok(writing.includes("ls monitor.lock"));
        assert.ok(writing.includes("Found the watchdog."));
        assert.ok(writing.includes("The final answer."));
    });

    // A file the model read is not something the model wrote.
    it("leaves out tool results and the prompt itself", () => {
        const writing = turnWriting(messages, "");

        assert.ok(!writing.includes("RESULTWORD"));
        assert.ok(!writing.includes("why did the job stop"));
    });

    it("stops at the prompt, so an earlier turn's answer is not this turn's", () => {
        assert.ok(!turnWriting(messages, "").includes("earlier answer"));
    });

    it("is the answer alone when the transcript is not a list", () => {
        assert.equal(turnWriting(undefined, "just this"), "just this");
        assert.equal(turnWriting({ deny: "no" }, ""), "");
    });
});
