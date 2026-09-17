/**
 * The merge, and the only place a ranking rule is written down. Pure: it takes
 * two ranked lists and answers one, and knows nothing about SQLite, the runtime
 * or the trace.
 *
 * **Reciprocal rank fusion**, `score = Σ 1/(RRF_K + rank)` over the arms a
 * candidate appeared in. Decided in #683 over a weighted sum of normalised
 * scores, and the argument is that the two arms' scores are not comparable and
 * cannot be made comparable at this size: SQLite's `bm25()` is negative and
 * unbounded, cosine over unit vectors is roughly 0 to 1, and a min-max
 * normalisation over twenty candidates is degenerate the moment one arm returns
 * a single row. RRF reads ranks only, so neither scale can leak into the other,
 * at the price of throwing magnitude away — a runaway lexical match ranks like
 * a merely good one, which is the trade this issue accepts.
 *
 * **Determinism is a requirement, not an aspiration.** Every sort in this file
 * is `(score desc, memory_id asc)`, so two candidates that tie on every score
 * cannot swap between runs. A tie broken by nothing scores differently on every
 * run and the difference gets read as a real effect.
 */

/**
 * RRF's `k`. 60 is the constant from the original paper (Cormack, Clarke &
 * Buettcher 2009) and it is a damping term, not a tuned weight: it flattens the
 * difference between the top ranks so a single arm's first place cannot by
 * itself outrank agreement between the two. There is no labelled corpus here to
 * tune it against, and a constant tuned by eye on ten queries is worse than a
 * principled default.
 */
export const RRF_K = 60;

/**
 * @typedef {object} ArmHit
 * @property {number} memoryId
 * @property {number} score
 */

/**
 * @typedef {object} MergedCandidate
 * @property {number} memoryId
 * @property {boolean} fromFts
 * @property {boolean} fromVector
 * @property {number | null} ftsRank
 * @property {number | null} ftsScore
 * @property {number | null} vectorRank
 * @property {number | null} vectorScore
 * @property {number} mergeScore
 * @property {number} mergeRank
 */

/**
 * Ranks one arm's hits, 1-based, deterministically.
 *
 * `direction` is the whole reason this helper exists. `bm25()` is negative and
 * **lower is better**; cosine is higher is better. Code that treats a higher
 * BM25 as better looks almost right and is the single most likely silent
 * inversion in the pipeline, so the two arms say which way they run rather than
 * sharing a comparator that assumes one of them.
 *
 * @param {ArmHit[]} hits
 * @param {"higher-is-better" | "lower-is-better"} direction
 * @returns {{ memoryId: number, score: number, rank: number }[]}
 */
export const rankArm = (hits, direction) => {
    const sign = direction === "lower-is-better" ? 1 : -1;
    const ordered = [...hits].sort(
        (left, right) => sign * (left.score - right.score) || left.memoryId - right.memoryId,
    );

    return ordered.map((hit, index) => ({ memoryId: hit.memoryId, score: hit.score, rank: index + 1 }));
};

/**
 * Fuses the two arms into one deduped, ranked candidate list.
 *
 * The arms arrive already ranked (each arm's SQL or scan has ordered it), and a
 * memory in both arms is one candidate carrying both origins, never two rows:
 * `retrieval_candidates` is keyed `(retrieval_id, memory_id)` and would refuse
 * the second anyway.
 *
 * @param {{ fts?: { memoryId: number, score: number, rank: number }[], vector?: { memoryId: number, score: number, rank: number }[] }} arms
 * @returns {MergedCandidate[]}
 */
export const mergeArms = (arms) => {
    /** @type {Map<number, MergedCandidate>} */
    const byMemory = new Map();

    const blank = (memoryId) => ({
        memoryId,
        fromFts: false,
        fromVector: false,
        ftsRank: null,
        ftsScore: null,
        vectorRank: null,
        vectorScore: null,
        mergeScore: 0,
        mergeRank: 0,
    });

    for (const hit of arms.fts ?? []) {
        const candidate = byMemory.get(hit.memoryId) ?? blank(hit.memoryId);

        candidate.fromFts = true;
        candidate.ftsRank = hit.rank;
        candidate.ftsScore = hit.score;
        candidate.mergeScore += rrfContribution(hit.rank);

        byMemory.set(hit.memoryId, candidate);
    }

    for (const hit of arms.vector ?? []) {
        const candidate = byMemory.get(hit.memoryId) ?? blank(hit.memoryId);

        candidate.fromVector = true;
        candidate.vectorRank = hit.rank;
        candidate.vectorScore = hit.score;
        candidate.mergeScore += rrfContribution(hit.rank);

        byMemory.set(hit.memoryId, candidate);
    }

    const merged = [...byMemory.values()].sort(byScoreThenId((candidate) => candidate.mergeScore));

    return merged.map((candidate, index) => ({ ...candidate, mergeRank: index + 1 }));
};

/**
 * One arm's contribution to a candidate's fused score.
 *
 * @param {number} rank
 * @returns {number}
 */
export const rrfContribution = (rank) => 1 / (RRF_K + rank);

/**
 * The comparator every stage sorts by: score descending, `memory_id` ascending.
 *
 * @template T
 * @param {(item: T) => number} scoreOf
 * @returns {(left: T & { memoryId: number }, right: T & { memoryId: number }) => number}
 */
export const byScoreThenId = (scoreOf) => (left, right) =>
    scoreOf(right) - scoreOf(left) || left.memoryId - right.memoryId;

/**
 * The final order: rerank scores when the reranker answered, the merge order
 * when it did not. Cross-encoder scores are comparable only inside a single
 * call, so they are used as a ranking here and never as a threshold — nothing
 * in this function cuts on a score's value.
 *
 * @param {MergedCandidate[]} candidates
 * @param {Map<number, number> | null} rerankScores memory id to score, or null when the reranker was unavailable.
 * @returns {(MergedCandidate & { rerankScore: number | null })[]}
 */
export const orderForReturn = (candidates, rerankScores) => {
    const scored = candidates.map((candidate) => ({
        ...candidate,
        rerankScore: rerankScores?.get(candidate.memoryId) ?? null,
    }));

    if (rerankScores === null) {
        return [...scored].sort(byScoreThenId((candidate) => candidate.mergeScore));
    }

    return [...scored].sort(byScoreThenId((candidate) => candidate.rerankScore ?? Number.NEGATIVE_INFINITY));
};
