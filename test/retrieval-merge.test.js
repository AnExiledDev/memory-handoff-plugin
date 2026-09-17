import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { byScoreThenId, mergeArms, orderForReturn, rankArm, rrfContribution, RRF_K } from "../retrieval/merge.js";

/** BM25 as SQLite returns it: negative, and lower is better. */
const FTS = [
    { memoryId: 1, score: -3.0 },
    { memoryId: 2, score: -1.0 },
    { memoryId: 3, score: -2.0 },
];

/** Cosine over unit vectors: higher is better. */
const VECTOR = [
    { memoryId: 3, score: 0.9 },
    { memoryId: 4, score: 0.8 },
    { memoryId: 1, score: 0.1 },
];

describe("an arm is ranked in its own direction", () => {
    // The single most likely silent inversion in the pipeline: a higher BM25
    // read as a better match. It looks almost right, because the strongest
    // match is still in the list.
    it("ranks the most negative bm25 first", () => {
        assert.deepEqual(
            rankArm(FTS, "lower-is-better").map((hit) => hit.memoryId),
            [1, 3, 2],
        );
    });

    it("ranks the highest cosine first", () => {
        assert.deepEqual(
            rankArm(VECTOR, "higher-is-better").map((hit) => hit.memoryId),
            [3, 4, 1],
        );
    });

    it("breaks a tie inside an arm by memory id ascending", () => {
        const tied = rankArm([{ memoryId: 9, score: 0.5 }, { memoryId: 2, score: 0.5 }], "higher-is-better");

        assert.deepEqual(tied.map((hit) => hit.memoryId), [2, 9]);
        assert.deepEqual(tied.map((hit) => hit.rank), [1, 2]);
    });
});

describe("reciprocal rank fusion", () => {
    it("scores a candidate as the sum of 1/(RRF_K + rank) over the arms it appeared in", () => {
        const merged = mergeArms({ fts: rankArm(FTS, "lower-is-better"), vector: rankArm(VECTOR, "higher-is-better") });
        const byId = new Map(merged.map((candidate) => [candidate.memoryId, candidate]));

        assert.equal(byId.get(1).mergeScore, 1 / (RRF_K + 1) + 1 / (RRF_K + 3));
        assert.equal(byId.get(2).mergeScore, 1 / (RRF_K + 3));
        assert.equal(RRF_K, 60);
        assert.equal(rrfContribution(1), 1 / 61);
    });

    // The exact order, over a hand-built set, is the test the acceptance
    // criteria name. 3 leads because both arms liked it, and it beats 1 which
    // one arm put first: agreement outranks a single arm's top hit, which is
    // the whole argument for RRF.
    it("puts the candidate both arms found above the candidate one arm ranked first", () => {
        const merged = mergeArms({ fts: rankArm(FTS, "lower-is-better"), vector: rankArm(VECTOR, "higher-is-better") });

        assert.deepEqual(merged.map((candidate) => candidate.memoryId), [3, 1, 4, 2]);
        assert.deepEqual(merged.map((candidate) => candidate.mergeRank), [1, 2, 3, 4]);
    });

    it("keeps a memory found by both arms as one candidate carrying both origins", () => {
        const merged = mergeArms({ fts: rankArm(FTS, "lower-is-better"), vector: rankArm(VECTOR, "higher-is-better") });
        const both = merged.filter((candidate) => candidate.memoryId === 3);

        assert.equal(both.length, 1);
        assert.deepEqual(
            { fromFts: both[0].fromFts, fromVector: both[0].fromVector, ftsRank: both[0].ftsRank, vectorRank: both[0].vectorRank },
            { fromFts: true, fromVector: true, ftsRank: 2, vectorRank: 1 },
        );
    });

    it("leaves the other arm's columns null for a candidate only one arm found", () => {
        const merged = mergeArms({ fts: rankArm(FTS, "lower-is-better"), vector: rankArm(VECTOR, "higher-is-better") });
        const vectorOnly = merged.find((candidate) => candidate.memoryId === 4);

        assert.equal(vectorOnly.fromFts, false);
        assert.equal(vectorOnly.ftsRank, null);
        assert.equal(vectorOnly.ftsScore, null);
        assert.equal(vectorOnly.vectorRank, 2);
    });

    it("merges two disjoint arms without treating the disagreement as an error", () => {
        const merged = mergeArms({
            fts: rankArm([{ memoryId: 10, score: -5 }], "lower-is-better"),
            vector: rankArm([{ memoryId: 20, score: 0.9 }], "higher-is-better"),
        });

        assert.deepEqual(merged.map((candidate) => candidate.memoryId), [10, 20]);
        assert.equal(merged[0].mergeScore, merged[1].mergeScore);
    });
});

describe("a tie cannot reorder between runs", () => {
    // Two memories identical on every score. Their arm ranks are already
    // id-ordered, so the fused scores come out id-ordered too, and the output
    // order is the id order on every run and every machine.
    it("orders candidates tied on every score by memory id ascending", () => {
        const merged = mergeArms({
            fts: rankArm([{ memoryId: 8, score: -2 }, { memoryId: 3, score: -2 }], "lower-is-better"),
            vector: rankArm([{ memoryId: 8, score: 0.5 }, { memoryId: 3, score: 0.5 }], "higher-is-better"),
        });

        assert.deepEqual(merged.map((candidate) => candidate.memoryId), [3, 8]);
    });

    it("sorts by score descending and id ascending wherever the comparator is used", () => {
        const rows = [
            { memoryId: 5, score: 1 },
            { memoryId: 2, score: 1 },
            { memoryId: 9, score: 2 },
        ];

        assert.deepEqual([...rows].sort(byScoreThenId((row) => row.score)).map((row) => row.memoryId), [9, 2, 5]);
    });
});

describe("the final order", () => {
    const merged = mergeArms({ fts: rankArm(FTS, "lower-is-better"), vector: rankArm(VECTOR, "higher-is-better") });

    it("follows the reranker when it answered", () => {
        const scores = new Map([[1, 9.5], [2, 9.0], [3, -1.0], [4, 0.0]]);

        assert.deepEqual(orderForReturn(merged, scores).map((candidate) => candidate.memoryId), [1, 2, 4, 3]);
    });

    it("falls back to the merged order when the reranker was unavailable", () => {
        const ordered = orderForReturn(merged, null);

        assert.deepEqual(ordered.map((candidate) => candidate.memoryId), [3, 1, 4, 2]);
        assert.deepEqual(ordered.map((candidate) => candidate.rerankScore), [null, null, null, null]);
    });

    it("breaks a rerank tie by memory id ascending", () => {
        const scores = new Map([[1, 1], [2, 1], [3, 1], [4, 1]]);

        assert.deepEqual(orderForReturn(merged, scores).map((candidate) => candidate.memoryId), [1, 2, 3, 4]);
    });
});
