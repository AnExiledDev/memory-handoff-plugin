/**
 * `memory_explain`: one retrieval, rendered from the database and nothing else.
 *
 * It re-runs no query, embeds nothing and calls no model. That is the whole
 * value of it — an explain that re-ran the pipeline would be a second retrieval
 * that might not agree with the first, and the question this answers is "why
 * did *that* memory come back", not "what would happen if I asked again".
 *
 * `renderExplain` is pure: rows in, text out. `explain` is the three-line
 * adapter that reads the rows first, so the renderer can be tested against a
 * hand-built trace with no database at all.
 */

import { readTrace } from "./store.js";

/**
 * @param {import("bun:sqlite").Database} db
 * @param {number} retrievalId
 * @returns {{ ok: true, text: string, retrieval: any, candidates: any[] } | { ok: false, reason: string }}
 */
export const explain = (db, retrievalId) => {
    const trace = readTrace(db, retrievalId);

    if (!trace.ok) {
        return trace;
    }

    return { ok: true, text: renderExplain(trace), retrieval: trace.retrieval, candidates: trace.candidates };
};

/**
 * The whole trace as text.
 *
 * @param {{ retrieval: any, candidates: any[] }} trace
 * @returns {string}
 */
export const renderExplain = (trace) => {
    const { retrieval, candidates } = trace;
    const filters = parseFilters(retrieval.filters);

    return [
        ...header(retrieval, filters),
        "",
        ...candidateTable(candidates),
        "",
        ...footer(retrieval, candidates),
    ].join("\n");
};

/** @param {any} retrieval @param {Record<string, any>} filters @returns {string[]} */
const header = (retrieval, filters) => [
    `retrieval ${retrieval.id}  ${retrieval.at}  origin=${retrieval.origin}  k=${retrieval.k}`,
    `query        (${retrieval.query_source}, ${filters.query_chars ?? retrieval.query_text.length} chars${filters.query_truncated ? `, truncated to ${filters.query_truncated_to}` : ""})`,
    `             ${oneLine(retrieval.query_text)}`,
    `match        ${filters.match_expression === "" || filters.match_expression === undefined ? "(none)" : filters.match_expression}`,
    ...(filters.query_empty_reason === undefined ? [] : [`             nothing searchable: ${filters.query_empty_reason}`]),
    `filters      project=${filters.project}  status=${list(filters.status)}  types=${list(filters.types)}  since=${filters.since ?? "-"}  until=${filters.until ?? "-"}`,
    `constants    rrf_k=${filters.rrf_k ?? "-"}  arm_limit=${filters.arm_limit ?? "-"}  rerank_cap=${filters.rerank_cap ?? "-"}`,
    `counts       fts=${retrieval.fts_n}  vector=${retrieval.vector_n}  merged=${retrieval.merged_n}  reranked=${retrieval.reranked_n}  returned=${retrieval.returned_n}  vectors_scanned=${filters.vectors_scanned ?? "-"}`,
    `timing       total=${ms(retrieval.ms_total)}  embed=${ms(retrieval.ms_embed)}  fts=${ms(retrieval.ms_fts)}  vector=${ms(retrieval.ms_vector)}  rerank=${ms(retrieval.ms_rerank)}`,
    `degraded     ${retrieval.degraded ?? "no"}`,
    ...degradationReasons(filters),
];

/** @param {any[]} candidates @returns {string[]} */
const candidateTable = (candidates) => {
    const columns = [
        ["final", 5, (row) => numberOrDash(row.final_rank)],
        ["merge#", 6, (row) => numberOrDash(row.merge_rank)],
        ["memory", 6, (row) => String(row.memory_id)],
        ["arms", 8, (row) => armsOf(row)],
        ["fts#", 4, (row) => numberOrDash(row.fts_rank)],
        ["fts score", 14, (row) => scoreOrDash(row.fts_score)],
        ["vec#", 4, (row) => numberOrDash(row.vector_rank)],
        ["vec score", 14, (row) => scoreOrDash(row.vector_score)],
        ["merge score", 12, (row) => scoreOrDash(row.merge_score)],
        ["rerank", 10, (row) => scoreOrDash(row.rerank_score)],
        ["title", 32, (row) => oneLine(row.title ?? "(purged)").slice(0, 32)],
        ["cut", 40, (row) => row.filtered_reason ?? ""],
    ];

    const line = (cells) => cells.map(([value, width]) => String(value).padEnd(width)).join("  ").trimEnd();

    return [
        `candidates (${candidates.length})`,
        line(columns.map((column) => [column[0], column[1]])),
        ...candidates.map((row) => line(columns.map((column) => [column[2](row), column[1]]))),
    ];
};

/** @param {any} retrieval @param {any[]} candidates @returns {string[]} */
const footer = (retrieval, candidates) => {
    const cut = candidates.filter((row) => row.filtered_reason !== null).length;

    return [
        `${candidates.length} candidate(s) considered, ${retrieval.returned_n} returned, ${cut} cut.`,
        retrieval.cost_id === null ? "no cost row." : `cost row ${retrieval.cost_id}.`,
    ];
};

/** The reasons behind a degradation, which live in `filters` because `retrievals` has one column for the fact and none for the why. */
const degradationReasons = (filters) =>
    [
        filters.vector_unavailable_reason === undefined ? null : `             vector: ${filters.vector_unavailable_reason}`,
        filters.rerank_unavailable_reason === undefined ? null : `             rerank: ${filters.rerank_unavailable_reason}`,
    ].filter((line) => line !== null);

/** @param {string} raw @returns {Record<string, any>} */
const parseFilters = (raw) => {
    try {
        const parsed = JSON.parse(raw);

        return parsed !== null && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
};

const armsOf = (row) => {
    const arms = [row.from_fts ? "fts" : null, row.from_vector ? "vec" : null].filter((arm) => arm !== null);

    return arms.length === 0 ? "-" : arms.join("+");
};

const numberOrDash = (value) => (value === null || value === undefined ? "-" : String(value));

/**
 * Scores print at six significant digits. BM25 is negative and small, cosine is
 * a fraction, and RRF scores live around 0.016; one format that reads all three
 * beats three formats a human has to keep straight.
 */
const scoreOrDash = (value) => (value === null || value === undefined ? "-" : Number(value).toPrecision(6));

const ms = (value) => (value === null || value === undefined ? "-" : `${value}ms`);

const list = (value) => (Array.isArray(value) ? value.join(",") : (value ?? "(any)"));

const oneLine = (text) => String(text).replace(/\s+/gu, " ").trim();
