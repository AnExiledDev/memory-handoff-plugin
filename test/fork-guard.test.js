import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LATE, nestedForkCompaction, OTHER, OWN } from "../hooks/fork-guard.js";

const WINDOW = 5000;

/** The shape `session.compact` arrives in, cut down to what the guard reads. */
const dispatch = (agentId) => (agentId === undefined ? { trigger: "auto" } : { trigger: "auto", agentId });

describe("nestedForkCompaction", () => {
    it("refuses a nested compaction that arrives while a fork is in flight", () => {
        const guard = { since: 1_000 };

        assert.equal(nestedForkCompaction(guard, dispatch("fork-1"), 1_200, WINDOW), OWN);
    });

    it("refuses one at the far edge of the window", () => {
        const guard = { since: 1_000 };

        assert.equal(nestedForkCompaction(guard, dispatch("fork-1"), 6_000, WINDOW), OWN);
    });

    // The whole point of the window: a subagent compacting during a long fork
    // keeps its compaction. This is the case the #690 design doc called
    // untestable and refused to build for.
    it("hands on a nested compaction past the window, and says it was late", () => {
        const guard = { since: 1_000 };

        assert.equal(nestedForkCompaction(guard, dispatch("agent-9"), 6_001, WINDOW), LATE);
    });

    it("hands on a subagent's compaction when no fork is running", () => {
        assert.equal(nestedForkCompaction({ since: null }, dispatch("agent-9"), 9_999, WINDOW), OTHER);
    });

    // The main conversation carries no `agentId`, so the person's own
    // compaction can never be read as a fork's however the clock reads.
    it("never reads the main conversation's compaction as a fork's", () => {
        const guard = { since: 1_000 };

        assert.equal(nestedForkCompaction(guard, dispatch(undefined), 1_100, WINDOW), OTHER);
    });

    it("treats an empty agentId as the main conversation", () => {
        const guard = { since: 1_000 };

        assert.equal(nestedForkCompaction(guard, dispatch(""), 1_100, WINDOW), OTHER);
    });

    it("reads a missing or malformed guard as no fork in flight", () => {
        assert.equal(nestedForkCompaction(undefined, dispatch("fork-1"), 1_100, WINDOW), OTHER);
        assert.equal(nestedForkCompaction({ since: "1000" }, dispatch("fork-1"), 1_100, WINDOW), OTHER);
    });

    it("reads a missing dispatch as nothing to refuse", () => {
        assert.equal(nestedForkCompaction({ since: 1_000 }, null, 1_100, WINDOW), OTHER);
    });
});
