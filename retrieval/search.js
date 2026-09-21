/**
 * The entry point: query in, ranked memories out, one trace written.
 *
 * `search({ query, project, ... }, { db, client })` is the whole of the public
 * surface. It runs against a database file with no Claude Code session
 * anywhere, which is what makes it testable and what makes `search-cli.js`
 * possible; #684 wires the same function into the prompt hook and the tool.
 *
 * The pipeline, decided in #678 and not reopened here:
 *
 *     query → metadata filter → FTS5 + vector → merge (RRF) → rerank → top-k
 *
 * Two behaviours are contract rather than detail.
 *
 * **It never returns an empty list silently.** Every way this can go wrong
 * degrades to something: the runtime down means FTS5-only with
 * `degraded = 'vector: unavailable'`, the reranker alone down means the merged
 * order with `degraded` set, and a query with nothing searchable in it returns
 * zero results with the reason on the trace. A caller can always tell the
 * difference between "nothing matched" and "half the pipeline was missing".
 *
 * **It is bounded.** A daemon's `/health` says `ready: true` as soon as a load
 * has *begun*, so a runtime that answered can still block on the first `/embed`
 * for as long as its ONNX sessions take to load. Every call out of here is
 * raced against `runtimeTimeoutMs`, and a call that overruns is a degraded rung
 * with its reason on the trace, exactly like a runtime that was never there.
 *
 * `runtimeTimeoutMs` alone bounds each call and not their sum, so the worst case
 * used to be the autostart window plus the embed timeout plus the rerank
 * timeout. A caller that kills this process sooner than that sum got nothing at
 * all, degradation included. `budgetMs` is the deadline they share: the worst
 * case is that one number, and the caller sets it below its own kill.
 *
 * **Every retrieval is explainable from the database alone.** One `retrievals`
 * row, one `retrieval_candidates` row per candidate considered including the
 * ones it threw away, and the reason on each. `explain.js` reads them back and
 * re-runs nothing.
 */

import { buildMatch, MAX_RERANK_QUERY_CHARS, truncateForEmbedding, truncateForRerank } from "./query.js";
import { mergeArms, orderForReturn, rankArm, RRF_K } from "./merge.js";
import { dot, embeddingCount, ftsHits, textOf, vectorRows, writeTrace } from "./store.js";

/** How many memories a retrieval returns by default. Small on purpose: this text is injected into a prompt. */
export const DEFAULT_K = 5;

/** How many hits each arm contributes before the merge. Matches the rerank cap: a deeper arm cannot reach the reranker anyway. */
export const ARM_LIMIT = 30;

/**
 * How many merged candidates the reranker sees, in one call.
 *
 * The reranker is a cross-encoder: one forward pass per (query, document) pair,
 * so the cost is linear in this number and there is no batching trick that
 * changes that. #681 measured 20 pairs; 30 is that measurement plus headroom
 * for the arms disagreeing completely, which is the case that most needs the
 * reranker.
 */
export const RERANK_CAP = 30;

/**
 * How long one call to the runtime is given before retrieval goes on without
 * it.
 *
 * It is not a guess at how long inference takes — #681 measured an embedding in
 * tens of milliseconds and a 30-pair rerank in a few hundred. It is a ceiling on
 * a runtime that is loading, wedged, or answering something else entirely, and
 * it exists because the caller is a prompt on its way out.
 *
 * Inference is kept under it by bounding what the models see rather than by
 * raising it: #711 cut the rerank query to `MAX_RERANK_QUERY_CHARS`, because a
 * long paste was the one input whose rerank overran this ceiling every time.
 */
export const RUNTIME_TIMEOUT_MS = 5000;

/**
 * How long the whole retrieval is given, across every runtime call it makes.
 *
 * `RUNTIME_TIMEOUT_MS` bounds *one* call. Three of them run in sequence — the
 * autostart wait, the embed, the rerank — so the per-call ceiling alone bounds
 * the search at three times itself, and the caller that kills this process does
 * not wait that long. When it kills mid-degradation the `retrievals` row is
 * never written and the prompt gets nothing, which is not the FTS5-only answer
 * this file is built to fall back to.
 *
 * Measured on this box 2026-09-21 against a warm daemon: embed 53 ms, a 30-pair
 * rerank 537 ms. Measured against the live store over 122 retrievals, 82 were
 * killed at the outer 2500 ms bound and every one of them returned nothing.
 *
 * So the budget is a deadline, not a third ceiling: every call gets the smaller
 * of its own ceiling and what is left of this, and a call with nothing left is
 * skipped rather than started. Null means no deadline, which is what a CLI or a
 * test gets when it does not ask for one.
 */
export const DEFAULT_BUDGET_MS = null;

/** What `retrievals.query_source` records. The raw prompt, decided in #683; the column exists so an extracted query can be compared later. */
export const QUERY_SOURCE = "raw-prompt";

/** The basis every locally-computed cost row carries: CPU time is real, API spend is not. */
export const LOCAL_BASIS = "local: no API spend";

/**
 * @typedef {object} SearchRequest
 * @property {string} query
 * @property {string} project
 * @property {string[]} [types]
 * @property {string[]} [status] Defaults to `['active']`, which is what excludes a superseded memory while its successor stays.
 * @property {string | null} [since]
 * @property {string | null} [until]
 * @property {number} [k] Clamped to `RERANK_CAP`; the trace records the number asked for.
 * @property {number} [runtimeTimeoutMs] How long any one runtime call is given. Defaults to `RUNTIME_TIMEOUT_MS`.
 * @property {number} [budgetMs] How long every runtime call gets between them. Defaults to `DEFAULT_BUDGET_MS`, which is no deadline.
 * @property {"prompt" | "tool" | "manual"} [origin]
 * @property {string | null} [sessionId]
 * @property {string | null} [turnId]
 */

/**
 * @typedef {object} SearchDeps
 * @property {import("bun:sqlite").Database} db
 * @property {{ embed: Function, rerank: Function } | null} client The runtime client, or null to run FTS5-only deliberately.
 * @property {(() => Promise<{ ready: boolean, reason?: string }>) | undefined} [ensureRuntime] Called once before the embed; `ensure-runtime.js` is the implementation the CLIs pass.
 * @property {() => number} [now] Milliseconds, for timing. Injected so a test can hold the clock still.
 * @property {() => string} [at] The ISO timestamp on the `retrievals` row.
 */

/**
 * @param {SearchRequest} request
 * @param {SearchDeps} deps
 * @returns {Promise<{ ok: true, retrievalId: number, results: { memoryId: number, title: string, body: string, scores: { fts: number | null, vector: number | null, merge: number, rerank: number | null } }[], degraded: string | null, matchExpression: string, msTotal: number } | { ok: false, reason: string }>}
 */
export const search = async (request, deps) => {
    const project = typeof request.project === "string" ? request.project.trim() : "";

    if (project === "") {
        return { ok: false, reason: "search needs a project: retrieval is scoped and there is no global scope" };
    }

    const now = deps.now ?? (() => Date.now());
    const startedAt = now();
    const filters = filtersOf(request, project);
    const match = buildMatch(request.query);
    const embedText = truncateForEmbedding(request.query);
    const timeoutMs = Number.isFinite(request.runtimeTimeoutMs) && Number(request.runtimeTimeoutMs) > 0 ? Number(request.runtimeTimeoutMs) : RUNTIME_TIMEOUT_MS;
    const budgetMs = Number.isFinite(request.budgetMs) && Number(request.budgetMs) > 0 ? Number(request.budgetMs) : DEFAULT_BUDGET_MS;
    const allow = deadlineFrom({ startedAt, budgetMs, now });

    const stages = { embed: null, fts: null, vector: null, rerank: null };
    const degradations = [];
    const notes = {};

    // Asking for more than the reranker sees would return a tail nothing
    // ranked, so `k` is clamped rather than quietly served from the merge order.
    const asked = Number.isInteger(request.k) && Number(request.k) > 0 ? Number(request.k) : DEFAULT_K;
    const k = Math.min(asked, RERANK_CAP);

    if (k !== asked) {
        notes.k_clamped_from = asked;
    }

    // A query with no searchable term in it is not a degradation and not an
    // error: "ok", "thanks" and "y" are a large share of real prompts. It
    // returns nothing, spends nothing, and says why on the trace.
    if (match.empty) {
        return finish({
            request, deps, filters, match, embedText, k, timeoutMs, startedAt, now,
            candidates: [], results: [], stages,
            degraded: null,
            notes: { ...notes, query_empty_reason: match.emptyReason },
            costs: [costOfNothing(`no model call: ${match.emptyReason}`)],
            vectorsScanned: 0,
        });
    }

    const ftsStarted = now();
    const fts = rankArm(ftsHits(deps.db, { match: match.expression, filters, limit: ARM_LIMIT }), "lower-is-better");

    stages.fts = now() - ftsStarted;

    const runtime = await readiness(deps, allow(timeoutMs));
    const vector = await vectorArm({ deps, filters, embedText, runtime, timeoutMs, allow, now, stages, degradations, notes });
    const merged = mergeArms({ fts, vector: vector.hits });
    const reranked = await rerankArm({ deps, request, merged, runtime, timeoutMs, allow, now, stages, degradations, notes });
    const ordered = orderForReturn(reranked.candidates, reranked.scores);
    const text = textOf(deps.db, ordered.map((candidate) => candidate.memoryId));

    const returned = ordered.slice(0, k);
    const rows = [
        ...ordered.map((candidate, index) => candidateRow(candidate, index < k ? index + 1 : null, cutReasonFor(index, k))),
        ...merged.slice(RERANK_CAP).map((candidate) => candidateRow({ ...candidate, rerankScore: null }, null, `over the rerank cap of ${RERANK_CAP}`)),
        ...typeExcludedRows(deps.db, filters, match, vector.excluded),
    ];

    return finish({
        request, deps, filters, match, embedText, k, timeoutMs, startedAt, now,
        candidates: rows,
        results: returned.map((candidate) => resultOf(candidate, text)),
        stages,
        degraded: degradations.length === 0 ? null : degradations.join("; "),
        notes,
        costs: reranked.costs.concat(vector.costs).concat([summaryCost(vector.costs.concat(reranked.costs))]),
        vectorsScanned: vector.scanned,
        counts: { fts: fts.length, vector: vector.hits.length, merged: merged.length, reranked: reranked.count },
    });
};

/**
 * The vector arm, and every way it can be missing.
 *
 * A runtime that is not running, has no weights, or answers something
 * unreadable all arrive here as `{ ok: false, reason }` — `runtime/client.js`
 * never throws — and all of them mean the same thing to a caller: FTS5-only,
 * with `vector: unavailable` on the row.
 */
const vectorArm = async ({ deps, filters, embedText, runtime, timeoutMs, allow, now, stages, degradations, notes }) => {
    const unavailable = (reason) => {
        degradations.push("vector: unavailable");
        notes.vector_unavailable_reason = reason;

        return { hits: [], excluded: [], scanned: 0, costs: [costOfNothing(`no query embedding: ${reason}`, "query-embed")] };
    };

    if (!runtime.ready) {
        return unavailable(runtime.reason);
    }

    const embedStarted = now();
    const embedded = await withTimeout(() => deps.client.embed([embedText.text], { kind: "query" }), allow(timeoutMs), "the query embedding");

    stages.embed = now() - embedStarted;

    if (!embedded.ok) {
        return unavailable(embedded.reason);
    }

    notes.embed_model = embedded.model;
    notes.query_truncated_by_runtime = embedded.truncated?.[0] === true;

    const scanStarted = now();
    const rows = vectorRows(deps.db, { filters, model: embedded.model });
    const queryVector = embedded.vectors[0];

    // A vector of another width is a vector from another model or another
    // dtype, and a dot product over the shorter of the two is a number that
    // looks like a similarity and is not one.
    const comparable = rows.filter((row) => row.vector.length === queryVector.length);

    if (comparable.length !== rows.length) {
        notes.vectors_skipped_dim = rows.length - comparable.length;
    }

    // An empty arm on a database full of embeddings is a model change, not an
    // empty corpus, and it is otherwise invisible: the results simply get worse.
    if (rows.length === 0 && embeddingCount(deps.db) > 0) {
        notes.vector_no_rows_for_model = embedded.model;
    }

    const scored = comparable.map((row) => ({ memoryId: row.memoryId, type: row.type, score: dot(queryVector, row.vector) }));
    const wanted = filters.types === null ? scored : scored.filter((row) => filters.types.includes(row.type));

    stages.vector = now() - scanStarted;

    return {
        hits: rankArm(wanted, "higher-is-better").slice(0, ARM_LIMIT),
        excluded: filters.types === null ? [] : scored.filter((row) => !filters.types.includes(row.type)),
        scanned: rows.length,
        costs: [localCost("query-embed", embedded.model, `one bge query embedding, ${embedded.ms} ms on the local runtime`)],
    };
};

/**
 * Whether the runtime is worth calling at all, asked once per retrieval.
 *
 * Both arms share the answer. Asking the reranker after the autostart already
 * said the daemon is not there is a guaranteed wait for a guaranteed failure,
 * and it was exactly what the first cut of this file did.
 *
 * @returns {Promise<{ ready: boolean, reason?: string }>}
 */
const readiness = async (deps, timeoutMs) => {
    if (deps.client === null || deps.client === undefined) {
        return { ready: false, reason: "no runtime client was given" };
    }

    if (deps.ensureRuntime === undefined) {
        return { ready: true };
    }

    const answer = await withTimeout(
        async () => ({ ok: true, value: await deps.ensureRuntime() }),
        timeoutMs,
        "the runtime start",
    );

    if (!answer.ok) {
        return { ready: false, reason: answer.reason };
    }

    return answer.value.ready ? { ready: true } : { ready: false, reason: answer.value.reason ?? "the runtime did not become ready" };
};

/**
 * What is left of the whole retrieval's deadline, as a ceiling on one call.
 *
 * `allow(want)` is the smaller of that call's own ceiling and the time left, so
 * the calls in sequence share one budget instead of each starting a fresh one.
 * Zero means the deadline is spent and the call must not be started: a call
 * begun with nothing left cannot finish inside it, and starting it is what gets
 * the whole process killed before it can write its row.
 *
 * @param {{ startedAt: number, budgetMs: number | null, now: () => number }} options
 * @returns {(want: number) => number}
 */
export const deadlineFrom = ({ startedAt, budgetMs, now }) => {
    if (budgetMs === null) {
        return (want) => want;
    }

    const endsAt = startedAt + budgetMs;

    return (want) => Math.max(0, Math.min(want, endsAt - now()));
};

/** The reason a call never ran, so the trace says "spent", not "unavailable". */
const SPENT = "the retrieval budget was spent before the call could start";

/**
 * One call to the runtime, bounded.
 *
 * The client never throws, so the only thing it can do wrong is take too long,
 * and it can: `/health` reports a load that has started as ready, and the
 * client's own socket timeout is twenty seconds. A call that overruns comes
 * back as the same `{ ok: false, reason }` shape as any other failure, so every
 * caller degrades through one path. The call itself is abandoned rather than
 * cancelled — the runtime keeps loading, and the next retrieval gets the
 * benefit of it.
 *
 * @template T
 * @param {() => Promise<T>} call
 * @param {number} ms
 * @param {string} what
 * @returns {Promise<T | { ok: false, reason: string }>}
 */
const withTimeout = async (call, ms, what) => {
    if (ms <= 0) {
        return { ok: false, reason: SPENT };
    }

    let timer = null;
    const expired = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: `${what} did not answer within ${ms} ms` }), ms);
    });

    try {
        return await Promise.race([call(), expired]);
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
};

/**
 * The reranker over the capped candidate set, and the merged order when it is
 * not there.
 *
 * Nothing here thresholds on a rerank score. Cross-encoder logits are
 * comparable only inside one call, so they order this call's candidates and
 * mean nothing outside it.
 */
const rerankArm = async ({ deps, request, merged, runtime, timeoutMs, allow, now, stages, degradations, notes }) => {
    const capped = merged.slice(0, RERANK_CAP);

    const unavailable = (reason) => {
        degradations.push("rerank: unavailable");
        notes.rerank_unavailable_reason = reason;

        return { candidates: capped, scores: null, count: 0, costs: [costOfNothing(`no model call: ${reason}`, "rerank")] };
    };

    if (capped.length === 0) {
        return { candidates: capped, scores: null, count: 0, costs: [costOfNothing("no model call: no candidates to rerank", "rerank")] };
    }

    if (!runtime.ready) {
        return unavailable(runtime.reason);
    }

    const text = textOf(deps.db, capped.map((candidate) => candidate.memoryId));
    const documents = capped.map((candidate) => documentFor(text.get(candidate.memoryId)));
    const queryText = truncateForRerank(request.query);

    // Recorded whichever way it went, like the embedder's own cut: "the
    // reranker saw all of it" is a fact about this retrieval, not an absence.
    notes.rerank_query_truncated = queryText.truncated;
    notes.rerank_query_truncated_to = queryText.truncated ? queryText.text.length : null;

    const started = now();
    const ranked = await withTimeout(() => deps.client.rerank(queryText.text, documents), allow(timeoutMs), "the rerank");

    stages.rerank = now() - started;

    if (!ranked.ok) {
        return unavailable(ranked.reason);
    }

    const scores = new Map(capped.map((candidate, index) => [candidate.memoryId, ranked.scores[index]]));

    return {
        candidates: capped,
        scores,
        count: capped.length,
        costs: [localCost("rerank", ranked.model, `${capped.length} cross-encoder pairs in one call, ${ranked.ms} ms on the local runtime`)],
    };
};

/** The pair the reranker scores. Title first, because the title is what a memory is about. */
const documentFor = (row) => (row === undefined ? "" : `${row.title}\n\n${row.body}`);

/** @returns {import("./store.js").Filters} */
const filtersOf = (request, project) => ({
    project,
    status: Array.isArray(request.status) && request.status.length > 0 ? [...request.status] : ["active"],
    types: Array.isArray(request.types) && request.types.length > 0 ? [...request.types] : null,
    since: request.since ?? null,
    until: request.until ?? null,
});

/**
 * The candidates a type restriction the caller asked for threw away.
 *
 * The whole rest of the corpus does not earn a row — the filter is recorded as
 * a predicate on the `retrievals` row — but a memory that would have been a
 * candidate if the caller had not narrowed the types is exactly the thing
 * somebody debugging an empty result needs to see.
 */
const typeExcludedRows = (db, filters, match, vectorExcluded) => {
    if (filters.types === null) {
        return [];
    }

    const lexical = ftsHits(db, { match: match.expression, filters, limit: ARM_LIMIT, typeMode: "exclude" });
    const byMemory = new Map();
    const reason = `type not in the requested set (${filters.types.join(", ")})`;

    for (const hit of lexical) {
        byMemory.set(hit.memoryId, {
            retrieval_id: 0,
            memory_id: hit.memoryId,
            from_fts: 1,
            from_vector: 0,
            fts_rank: null,
            fts_score: hit.score,
            vector_rank: null,
            vector_score: null,
            merge_score: null,
            merge_rank: null,
            rerank_score: null,
            final_rank: null,
            filtered_reason: reason,
        });
    }

    // Only the excluded memories the vector arm would plausibly have reached.
    // Every filtered memory has a cosine against every query; logging all of
    // them would put the corpus in the trace.
    const nearest = [...vectorExcluded]
        .sort((left, right) => right.score - left.score || left.memoryId - right.memoryId)
        .slice(0, ARM_LIMIT);

    for (const hit of nearest) {
        const existing = byMemory.get(hit.memoryId);

        byMemory.set(hit.memoryId, {
            ...(existing ?? {
                retrieval_id: 0,
                memory_id: hit.memoryId,
                from_fts: 0,
                fts_rank: null,
                fts_score: null,
                merge_score: null,
                merge_rank: null,
                rerank_score: null,
                final_rank: null,
                filtered_reason: reason,
            }),
            from_vector: 1,
            vector_rank: null,
            vector_score: hit.score,
        });
    }

    return [...byMemory.values()].sort((left, right) => left.memory_id - right.memory_id);
};

/** @param {number} index @param {number} k @returns {string | null} */
const cutReasonFor = (index, k) => (index < k ? null : `below the top ${k}`);

const candidateRow = (candidate, finalRank, filteredReason) => ({
    retrieval_id: 0,
    memory_id: candidate.memoryId,
    from_fts: candidate.fromFts ? 1 : 0,
    from_vector: candidate.fromVector ? 1 : 0,
    fts_rank: candidate.ftsRank,
    fts_score: candidate.ftsScore,
    vector_rank: candidate.vectorRank,
    vector_score: candidate.vectorScore,
    merge_score: candidate.mergeScore,
    merge_rank: candidate.mergeRank,
    rerank_score: candidate.rerankScore ?? null,
    final_rank: finalRank,
    filtered_reason: filteredReason,
});

const resultOf = (candidate, text) => {
    const row = text.get(candidate.memoryId);

    return {
        memoryId: candidate.memoryId,
        title: row?.title ?? "",
        body: row?.body ?? "",
        type: row?.type ?? null,
        importance: row?.importance ?? null,
        scores: {
            fts: candidate.ftsScore,
            vector: candidate.vectorScore,
            merge: candidate.mergeScore,
            rerank: candidate.rerankScore ?? null,
        },
    };
};

/**
 * A model call that ran on this box. Local inference is not free — it is CPU
 * time — but it is not API spend, and `basis` is the only thing that lets a
 * status command sum a mixed history without lying about either.
 */
const localCost = (kind, model, note) => ({
    at: new Date().toISOString(),
    kind,
    model,
    usd: 0,
    basis: LOCAL_BASIS,
    cost_note: note,
});

/** A call that was never made: a real zero, and the note is what stops it being read as "this was free". */
const costOfNothing = (note, kind = "retrieval") => ({
    at: new Date().toISOString(),
    kind,
    model: null,
    usd: 0,
    basis: "no model call",
    cost_note: note,
});

/** The row `retrievals.cost_id` points at: what the whole retrieval spent. */
const summaryCost = (calls) => {
    const ran = calls.filter((call) => call.basis === LOCAL_BASIS);

    if (ran.length === 0) {
        return costOfNothing("no model call: every arm that would have made one was unavailable");
    }

    return {
        at: new Date().toISOString(),
        kind: "retrieval",
        model: null,
        usd: 0,
        basis: LOCAL_BASIS,
        cost_note: `${ran.length} local model call(s): ${ran.map((call) => call.kind).join(", ")}`,
    };
};

/** Writes the trace and answers the caller. The one place a `retrievals` row is built. */
const finish = ({ request, deps, filters, match, embedText, k, timeoutMs, startedAt, now, candidates, results, stages, degraded, notes, costs, vectorsScanned, counts }) => {
    const msTotal = now() - startedAt;
    const retrieval = {
        at: (deps.at ?? (() => new Date().toISOString()))(),
        session_id: request.sessionId ?? null,
        turn_id: request.turnId ?? null,
        origin: originOf(request.origin),
        query_text: request.query ?? "",
        query_source: QUERY_SOURCE,
        filters: JSON.stringify(traceFilters(filters, match, embedText, vectorsScanned, timeoutMs, notes)),
        k,
        fts_n: counts?.fts ?? 0,
        vector_n: counts?.vector ?? 0,
        merged_n: counts?.merged ?? 0,
        reranked_n: counts?.reranked ?? 0,
        returned_n: results.length,
        ms_total: msTotal,
        ms_embed: stages.embed,
        ms_fts: stages.fts,
        ms_vector: stages.vector,
        ms_rerank: stages.rerank,
        degraded,
    };
    // The summary cost row is written last and is the one the retrieval points
    // at; the per-call rows stand on their own so a day's spend can be summed
    // by kind.
    const written = writeTrace(deps.db, {
        retrieval,
        candidates,
        costs,
        retrievalCostIndex: costs.length === 0 ? null : costs.length - 1,
    });

    return {
        ok: /** @type {const} */ (true),
        retrievalId: written.retrievalId,
        results,
        degraded,
        matchExpression: match.expression,
        msTotal,
    };
};

/**
 * Everything about this retrieval that is not already a column: the predicates
 * as applied, the exact MATCH expression, how the query was cut, and how many
 * vectors the brute-force arm read.
 */
const traceFilters = (filters, match, embedText, vectorsScanned, timeoutMs, notes) => ({
    project: filters.project,
    status: filters.status,
    types: filters.types,
    since: filters.since,
    until: filters.until,
    match_expression: match.expression,
    match_tokens: match.tokens,
    match_dropped: match.dropped,
    query_chars: embedText.chars,
    query_truncated: embedText.truncated,
    query_truncated_to: embedText.truncated ? embedText.text.length : null,
    rerank_query_chars: MAX_RERANK_QUERY_CHARS,
    vectors_scanned: vectorsScanned,
    arm_limit: ARM_LIMIT,
    rerank_cap: RERANK_CAP,
    rrf_k: RRF_K,
    runtime_timeout_ms: timeoutMs,
    ...notes,
});

/** @param {unknown} origin @returns {"prompt" | "tool" | "manual"} */
const originOf = (origin) => (origin === "prompt" || origin === "tool" ? origin : "manual");
