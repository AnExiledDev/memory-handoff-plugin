import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { explain } from "../retrieval/explain.js";
import { MAX_RERANK_QUERY_CHARS } from "../retrieval/query.js";
import { DEFAULT_K, search } from "../retrieval/search.js";
import { DEPENDENCY_MISSING_REASON } from "../runtime/infer.js";
import { FAKE_EMBED_MODEL, fakeClient, insertEmbedding, insertMemory, withDb } from "./retrieval-fixtures.js";

const PROJECT = "host/owner/alpha";
const OTHER = "host/owner/beta";
const QUERY = "worktree stash collides";

/** The query vector the fake runtime answers with; every fixture vector is placed relative to it. */
const QUERY_VECTOR = [1, 0, 0, 0];

/**
 * The four probe cases the issue names, in one corpus.
 *
 * - `lexical` shares the query's words and has no embedding at all, which is
 *   what a memory written while the runtime was down looks like. The vector arm
 *   is brute force over the filtered set, so on a corpus smaller than the arm
 *   limit every *embedded* memory is a vector candidate at its true cosine;
 *   "the lexical arm alone found this" is a memory with no vector, or a corpus
 *   bigger than the arm limit.
 * - `semantic` shares no content word with the query and sits on it.
 * - `both` is found by both arms.
 * - `wrongProject` is the same text as `both`, in another project.
 */
const seed = (db) => ({
    lexical: insertMemory(db, {
        project: PROJECT,
        title: "Worktree stash",
        body: "The stash stack is shared with every checkout.",
    }),
    semantic: insertMemory(db, {
        project: PROJECT,
        title: "Parallel checkouts",
        body: "An isolated copy of a repository, made beside the primary one.",
        vector: QUERY_VECTOR,
    }),
    both: insertMemory(db, {
        project: PROJECT,
        title: "A worktree and the stash",
        body: "Popping in one worktree can take another session's work.",
        vector: [0.7, 0.7, 0, 0],
    }),
    wrongProject: insertMemory(db, {
        project: OTHER,
        title: "A worktree and the stash",
        body: "Popping in one worktree can take another session's work.",
        vector: [0.7, 0.7, 0, 0],
    }),
});

const client = (options = {}) => fakeClient({ queryVector: QUERY_VECTOR, rerank: (_query, docs) => docs.map((doc) => doc.length / 100), ...options });

const run = (db, request, deps = {}) =>
    search({ query: QUERY, project: PROJECT, origin: "manual", ...request }, { db, client: client(), ...deps });

const candidatesOf = (db, retrievalId) =>
    db.query("SELECT * FROM retrieval_candidates WHERE retrieval_id = ? ORDER BY memory_id ASC").all(retrievalId);

const retrievalOf = (db, retrievalId) => db.query("SELECT * FROM retrievals WHERE id = ?").get(retrievalId);

describe("the hybrid pipeline", () => {
    it("returns memories from both arms and says which arm found each", async () => {
        await withDb(async ({ db }) => {
            const ids = seed(db);
            const answer = await run(db, {});

            assert.equal(answer.ok, true);

            const returned = answer.results.map((result) => result.memoryId).sort((left, right) => left - right);

            assert.deepEqual(returned, [ids.lexical, ids.semantic, ids.both]);

            const rows = new Map(candidatesOf(db, answer.retrievalId).map((row) => [row.memory_id, row]));

            assert.deepEqual(
                { fts: rows.get(ids.lexical).from_fts, vector: rows.get(ids.lexical).from_vector, vectorRank: rows.get(ids.lexical).vector_rank },
                { fts: 1, vector: 0, vectorRank: null },
                "a memory only the lexical arm found carries no vector columns",
            );
            assert.deepEqual(
                { fts: rows.get(ids.semantic).from_fts, vector: rows.get(ids.semantic).from_vector, ftsRank: rows.get(ids.semantic).fts_rank },
                { fts: 0, vector: 1, ftsRank: null },
                "a paraphrase sharing no content word is a vector-only candidate",
            );
            assert.equal(rows.get(ids.both).from_fts, 1);
            assert.equal(rows.get(ids.both).from_vector, 1);
        });
    });

    // The primary key (retrieval_id, memory_id) enforces this, so a second row
    // would be an exception rather than a wrong answer; the assertion is that
    // nothing tries.
    it("writes one candidate row for a memory both arms ranked, not two", async () => {
        await withDb(async ({ db }) => {
            const ids = seed(db);
            const answer = await run(db, {});
            const rows = candidatesOf(db, answer.retrievalId).filter((row) => row.memory_id === ids.both);

            assert.equal(rows.length, 1);
        });
    });

    it("records the exact MATCH expression, the filters and the vectors it scanned", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            const answer = await run(db, {});
            const filters = JSON.parse(retrievalOf(db, answer.retrievalId).filters);

            assert.equal(filters.match_expression, '"worktree" OR "stash" OR "collides"');
            assert.equal(filters.project, PROJECT);
            assert.deepEqual(filters.status, ["active"]);
            assert.equal(filters.vectors_scanned, 2, "the other project's vector is never scanned, and the unembedded memory has none");
            assert.equal(filters.rrf_k, 60);
        });
    });

    it("writes the row's query as the raw prompt", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            const answer = await run(db, {});
            const row = retrievalOf(db, answer.retrievalId);

            assert.equal(row.query_text, QUERY);
            assert.equal(row.query_source, "raw-prompt");
            assert.equal(row.origin, "manual");
        });
    });
});

describe("the same query twice against an unchanged database", () => {
    it("returns the identical ordering and the identical scores", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            const first = await run(db, {});
            const second = await run(db, {});

            assert.notEqual(first.retrievalId, second.retrievalId, "each run is its own trace");
            assert.deepEqual(
                first.results.map((result) => [result.memoryId, result.scores]),
                second.results.map((result) => [result.memoryId, result.scores]),
            );
        });
    });

    // The sharp edge of the determinism requirement: two memories that cannot
    // be told apart by any score in the pipeline.
    it("orders candidates tied on every score by memory id ascending", async () => {
        await withDb(async ({ db }) => {
            const twin = { project: PROJECT, title: "Worktree stash", body: "The stash stack is shared.", vector: [1, 0, 0, 0] };
            const first = insertMemory(db, twin);
            const second = insertMemory(db, twin);
            const third = insertMemory(db, twin);

            const answer = await search(
                { query: QUERY, project: PROJECT, origin: "manual" },
                // A reranker that scores every document the same leaves the tie
                // standing all the way to the final order.
                { db, client: fakeClient({ queryVector: QUERY_VECTOR, rerank: (_query, docs) => docs.map(() => 1) }) },
            );

            assert.deepEqual(answer.results.map((result) => result.memoryId), [first, second, third]);
        });
    });
});

describe("the metadata filters", () => {
    it("cannot return another project's memory, whatever it matches", async () => {
        await withDb(async ({ db }) => {
            const ids = seed(db);
            const answer = await search({ query: QUERY, project: OTHER, origin: "manual" }, { db, client: client() });
            const filters = JSON.parse(retrievalOf(db, answer.retrievalId).filters);

            assert.deepEqual(answer.results.map((result) => result.memoryId), [ids.wrongProject]);
            assert.equal(filters.project, OTHER);

            for (const row of candidatesOf(db, answer.retrievalId)) {
                assert.notEqual(row.memory_id, ids.both);
                assert.notEqual(row.memory_id, ids.lexical);
            }
        });
    });

    // status = 'active' is a filter, so a superseded memory does not come back.
    // Its successor does, which is what proves the chain is followed rather
    // than the fact being lost.
    it("drops a superseded memory and returns its successor", async () => {
        await withDb(async ({ db }) => {
            const ancestor = insertMemory(db, {
                project: PROJECT,
                title: "Worktree stash",
                body: "The stash stack is shared with every checkout.",
                vector: QUERY_VECTOR,
            });
            const successor = insertMemory(db, {
                project: PROJECT,
                title: "Worktree stash, corrected",
                body: "The stash stack is shared; use a WIP commit instead.",
                supersedes: ancestor,
                vector: QUERY_VECTOR,
            });

            db.query("UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ?").run("2026-09-17T00:00:00Z", ancestor);

            const answer = await run(db, {});

            assert.deepEqual(answer.results.map((result) => result.memoryId), [successor]);
        });
    });

    it("gives a candidate row with a reason to a memory the caller's type restriction excluded", async () => {
        await withDb(async ({ db }) => {
            const ids = seed(db);
            const user = insertMemory(db, {
                project: PROJECT,
                type: "user",
                title: "Worktree stash preference",
                body: "The operator never pops a stash.",
                vector: QUERY_VECTOR,
            });

            const answer = await run(db, { types: ["project"] });
            const rows = new Map(candidatesOf(db, answer.retrievalId).map((row) => [row.memory_id, row]));

            assert.ok(!answer.results.some((result) => result.memoryId === user));
            assert.match(String(rows.get(user).filtered_reason), /type not in the requested set/u);
            assert.equal(rows.get(user).final_rank, null);
            assert.equal(rows.get(ids.both).filtered_reason, null);
        });
    });
});

describe("what a caller gets when there is nothing to give", () => {
    it("returns nothing for a stopword-only query, and writes a trace saying why", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            const answer = await run(db, { query: "ok now do the same for it" });
            const row = retrievalOf(db, answer.retrievalId);
            const filters = JSON.parse(row.filters);

            assert.deepEqual(answer.results, []);
            assert.equal(row.returned_n, 0);
            assert.equal(row.degraded, null, "an unsearchable query is not a degradation");
            assert.match(String(filters.query_empty_reason), /stopword/u);
            assert.equal(candidatesOf(db, answer.retrievalId).length, 0);
        });
    });

    it("answers a fresh install with zero results, a trace row and no error", async () => {
        await withDb(async ({ db }) => {
            const answer = await run(db, {});

            assert.equal(answer.ok, true);
            assert.deepEqual(answer.results, []);
            assert.equal(retrievalOf(db, answer.retrievalId).returned_n, 0);
        });
    });

    it("returns what there is when there are fewer memories than k, without padding", async () => {
        await withDb(async ({ db }) => {
            insertMemory(db, { project: PROJECT, title: "Worktree stash", body: "Shared.", vector: QUERY_VECTOR });

            const answer = await run(db, { k: DEFAULT_K });

            assert.equal(answer.results.length, 1);
        });
    });

    it("refuses a request with no project rather than searching every project", async () => {
        await withDb(async ({ db }) => {
            const answer = await search({ query: QUERY, project: "  " }, { db, client: client() });

            assert.equal(answer.ok, false);
            assert.match(answer.reason, /project/u);
        });
    });
});

describe("the degradation ladder", () => {
    it("runs FTS5-only with degraded = vector: unavailable when the runtime cannot embed", async () => {
        await withDb(async ({ db }) => {
            const ids = seed(db);
            const answer = await search(
                { query: QUERY, project: PROJECT },
                { db, client: client({ embedFails: "runtime unreachable at http://127.0.0.1:8794" }) },
            );
            const row = retrievalOf(db, answer.retrievalId);

            assert.equal(row.degraded, "vector: unavailable");
            assert.ok(answer.results.length > 0, "never an empty list presented as no memories");
            assert.ok(answer.results.every((result) => result.scores.vector === null));
            assert.ok(!answer.results.some((result) => result.memoryId === ids.semantic), "the vector-only candidate is the one that is lost");
            assert.match(JSON.parse(row.filters).vector_unavailable_reason, /unreachable/u);
        });
    });

    it("returns the merged order with degraded set when only the reranker is down", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            const answer = await search(
                { query: QUERY, project: PROJECT },
                { db, client: client({ rerankFails: "runtime answered 503 on /rerank" }) },
            );
            const row = retrievalOf(db, answer.retrievalId);
            const rows = candidatesOf(db, answer.retrievalId);

            assert.equal(row.degraded, "rerank: unavailable");
            assert.ok(answer.results.length > 0);
            assert.ok(rows.every((candidate) => candidate.rerank_score === null));
            assert.deepEqual(
                answer.results.map((result) => result.memoryId),
                [...rows].sort((left, right) => right.merge_score - left.merge_score || left.memory_id - right.memory_id).map((row2) => row2.memory_id),
            );
        });
    });

    it("says both arms are missing when there is no runtime at all", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            const answer = await search({ query: QUERY, project: PROJECT }, { db, client: null });

            assert.equal(retrievalOf(db, answer.retrievalId).degraded, "vector: unavailable; rerank: unavailable");
            assert.ok(answer.results.length > 0);
        });
    });

    it("degrades without embedding when the runtime never became ready", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            const runtime = client();
            const answer = await search(
                { query: QUERY, project: PROJECT },
                { db, client: runtime, ensureRuntime: async () => ({ ready: false, reason: "the runtime did not come up within 5000 ms" }) },
            );

            assert.equal(runtime.calls.embed.length, 0, "a runtime that is not ready is not asked to embed");
            assert.match(retrievalOf(db, answer.retrievalId).degraded, /vector: unavailable/u);
        });
    });
});

describe("the trace is complete enough to explain the answer", () => {
    it("writes a candidate row for everything it considered, with the cuts and their reasons", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            const answer = await run(db, { k: 1 });
            const rows = candidatesOf(db, answer.retrievalId);
            const returned = rows.filter((row) => row.final_rank !== null);
            const cut = rows.filter((row) => row.filtered_reason !== null);

            assert.equal(rows.length, 3);
            assert.equal(returned.length, 1);
            assert.equal(returned[0].filtered_reason, null);
            assert.equal(cut.length, 2);
            assert.ok(cut.every((row) => row.final_rank === null));
            assert.ok(cut.every((row) => /below the top 1/u.test(row.filtered_reason)));
        });
    });

    it("counts every stage on the retrievals row", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            const answer = await run(db, {});
            const row = retrievalOf(db, answer.retrievalId);

            assert.equal(row.fts_n, 2);
            assert.equal(row.vector_n, 2);
            assert.equal(row.merged_n, 3);
            assert.equal(row.reranked_n, 3);
            assert.equal(row.returned_n, 3);
            assert.equal(typeof row.ms_total, "number");
        });
    });

    it("prices the retrieval as local inference rather than as free", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            const answer = await run(db, {});
            const row = retrievalOf(db, answer.retrievalId);
            const costs = db.query("SELECT * FROM costs ORDER BY id ASC").all();

            assert.notEqual(row.cost_id, null);
            assert.deepEqual(costs.map((cost) => cost.kind).sort(), ["query-embed", "rerank", "retrieval"]);
            assert.ok(costs.every((cost) => cost.basis === "local: no API spend"));
            assert.ok(costs.every((cost) => cost.usd === 0 && typeof cost.cost_note === "string"));
        });
    });

    it("records a real zero with a note when no model call was made at all", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            await search({ query: QUERY, project: PROJECT }, { db, client: null });

            const costs = db.query("SELECT * FROM costs ORDER BY id ASC").all();

            assert.ok(costs.every((cost) => cost.basis === "no model call"));
            assert.ok(costs.every((cost) => cost.usd === 0 && typeof cost.cost_note === "string"));
        });
    });

    it("explains the retrieval from the database alone", async () => {
        await withDb(async ({ db }) => {
            const ids = seed(db);
            const answer = await run(db, { k: 1 });
            const rendered = explain(db, answer.retrievalId);

            assert.equal(rendered.ok, true);
            assert.match(rendered.text, /"worktree" OR "stash" OR "collides"/u);
            assert.match(rendered.text, new RegExp(`project=${PROJECT}`, "u"));
            assert.match(rendered.text, /candidates \(3\)/u);
            assert.match(rendered.text, /below the top 1/u);
            assert.match(rendered.text, /vectors_scanned=2/u);
            assert.equal(rendered.candidates.length, candidatesOf(db, answer.retrievalId).length);

            // The vector-only candidate, read off the rendered table the way a
            // human checks it: the vector arm as its origin and no fts rank.
            const line = rendered.text.split("\n").find((text) => text.includes("Parallel checkouts"));

            assert.match(String(line), /\bvec\b/u);
            assert.equal(rendered.candidates.find((row) => row.memory_id === ids.semantic).fts_rank, null);
        });
    });

    it("says so rather than throwing when the retrieval id is not in the database", async () => {
        await withDb(async ({ db }) => {
            const rendered = explain(db, 4242);

            assert.equal(rendered.ok, false);
            assert.match(rendered.reason, /no retrieval 4242/u);
        });
    });
});

describe("a runtime that answers and then does not", () => {
    // /health reports a load that has *begun* as ready, so a daemon can pass
    // the autostart and then sit on the first /embed for as long as its ONNX
    // sessions take. Measured on this box: ready at 701 ms uptime, embedding
    // long after. Without a call timeout the prompt waits on the client's own
    // twenty seconds.
    it("bounds an embed that never answers and degrades with the timeout as the reason", async () => {
        await withDb(async ({ db }) => {
            const ids = seed(db);
            const answer = await search(
                { query: QUERY, project: PROJECT, runtimeTimeoutMs: 25 },
                { db, client: client({ embedHangs: true }) },
            );
            const row = retrievalOf(db, answer.retrievalId);

            assert.match(row.degraded, /vector: unavailable/u);
            assert.match(JSON.parse(row.filters).vector_unavailable_reason, /did not answer within 25 ms/u);
            assert.ok(answer.results.length > 0, "the lexical arm still answers");
            assert.ok(!answer.results.some((result) => result.memoryId === ids.semantic));
        });
    });

    it("bounds a rerank that never answers and keeps the merged order", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            const answer = await search(
                { query: QUERY, project: PROJECT, runtimeTimeoutMs: 25 },
                { db, client: client({ rerankHangs: true }) },
            );
            const row = retrievalOf(db, answer.retrievalId);

            assert.match(row.degraded, /rerank: unavailable/u);
            assert.match(JSON.parse(row.filters).rerank_unavailable_reason, /did not answer within 25 ms/u);
            assert.ok(answer.results.length > 0);
        });
    });

    // The reranker is behind the same daemon the autostart just gave up on.
    // Posting to it anyway buys a second full timeout for an answer already
    // known.
    it("does not call the reranker after the autostart said the runtime is not there", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            const runtime = client();
            const answer = await search(
                { query: QUERY, project: PROJECT },
                { db, client: runtime, ensureRuntime: async () => ({ ready: false, reason: "runtime: autostart attempted 12s ago, not ready" }) },
            );
            const filters = JSON.parse(retrievalOf(db, answer.retrievalId).filters);

            assert.equal(runtime.calls.rerank.length, 0, "the reranker is on the daemon that is not there");
            assert.equal(runtime.calls.embed.length, 0);
            assert.equal(retrievalOf(db, answer.retrievalId).degraded, "vector: unavailable; rerank: unavailable");
            assert.equal(filters.rerank_unavailable_reason, "runtime: autostart attempted 12s ago, not ready");
            assert.equal(filters.vector_unavailable_reason, "runtime: autostart attempted 12s ago, not ready");
        });
    });

    // The marketplace-install case: the copy has no `node_modules`, so the
    // trace has to say that rather than "the runtime was not ready", which
    // names nothing anybody can act on.
    it("carries the missing-dependency reason onto the row", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            const answer = await search(
                { query: QUERY, project: PROJECT },
                { db, client: client(), ensureRuntime: async () => ({ ready: false, reason: DEPENDENCY_MISSING_REASON }) },
            );
            const row = retrievalOf(db, answer.retrievalId);

            assert.ok(answer.results.length > 0, "FTS5 still answers");
            assert.match(row.degraded, /vector: unavailable/u);
            assert.equal(JSON.parse(row.filters).vector_unavailable_reason, DEPENDENCY_MISSING_REASON);
        });
    });
});

describe("vectors that cannot be compared", () => {
    // Renaming or upgrading the embedding model empties the vector arm on a
    // database full of vectors, and nothing else says so: the results simply
    // get quietly worse.
    it("names the model when the corpus has embeddings and none of them are this model's", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            const answer = await search(
                { query: QUERY, project: PROJECT },
                { db, client: client({ embedModel: "bge-small-en-v1.5/fp32@rev2" }) },
            );
            const row = retrievalOf(db, answer.retrievalId);

            assert.equal(row.vector_n, 0);
            assert.equal(JSON.parse(row.filters).vector_no_rows_for_model, "bge-small-en-v1.5/fp32@rev2");
            assert.equal(row.degraded, null, "an empty arm is not a degradation; the runtime answered");
            assert.match(explain(db, answer.retrievalId).text, /no stored embedding matches the model that answered/u);
        });
    });

    // A dot product over the shorter of two widths is a number that looks like
    // a similarity and is not one, so a 384-wide corpus with one 768-wide row
    // must drop the row rather than score it on its first 384 dimensions.
    it("skips a stored vector of another width and counts it on the trace", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            const narrow = insertMemory(db, { project: PROJECT, title: "Stash and worktree", body: "Another matching memory." });

            insertEmbedding(db, narrow, [1, 0], FAKE_EMBED_MODEL);

            const answer = await search({ query: QUERY, project: PROJECT }, { db, client: client() });
            const row = retrievalOf(db, answer.retrievalId);
            const candidate = candidatesOf(db, answer.retrievalId).find((each) => each.memory_id === narrow);

            assert.equal(JSON.parse(row.filters).vectors_skipped_dim, 1);
            assert.equal(candidate.from_vector, 0, "the mismatched row is a lexical candidate and nothing more");
            assert.equal(candidate.vector_score, null);
            assert.match(explain(db, answer.retrievalId).text, /1 vector\(s\) skipped/u);
        });
    });
});

describe("k beyond what the reranker sees", () => {
    it("clamps k to the rerank cap and records what was asked for", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            const answer = await search({ query: QUERY, project: PROJECT, k: 100 }, { db, client: client() });
            const row = retrievalOf(db, answer.retrievalId);

            assert.equal(row.k, 30);
            assert.equal(JSON.parse(row.filters).k_clamped_from, 100);
            assert.ok(answer.results.length <= 30);
            assert.match(explain(db, answer.retrievalId).text, /k was 100, clamped to the rerank cap/u);
        });
    });
});

// #711: the reranker is a cross-encoder sharing one 512-token sequence between
// the query and the memory, so a pasted log both cost more than the 5 s ceiling
// a prompt gives one runtime call and crowded the memory out of the window.
describe("a long prompt reaching the reranker", () => {
    const paste = `${QUERY}\n${Array.from({ length: 400 }, (_unused, index) => `at frame${index} (/srv/app/file${index}.js:${index}:12)`).join("\n")}`;

    it("cuts the query to the rerank window and records the cut", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            const seen = [];
            const answer = await search(
                { query: paste, project: PROJECT },
                { db, client: fakeClient({ queryVector: QUERY_VECTOR, rerank: (query, docs) => { seen.push(query); return docs.map((doc) => doc.length / 100); } }) },
            );
            const filters = JSON.parse(retrievalOf(db, answer.retrievalId).filters);

            assert.equal(answer.ok, true);
            assert.equal(seen[0].length, MAX_RERANK_QUERY_CHARS);
            assert.equal(filters.rerank_query_truncated, true);
            assert.equal(filters.rerank_query_truncated_to, MAX_RERANK_QUERY_CHARS);
            assert.equal(filters.rerank_query_chars, MAX_RERANK_QUERY_CHARS);
            assert.match(explain(db, answer.retrievalId).text, /the reranker saw the first 600 characters/u);
        });
    });

    // The embedder's cut is the wider one and stays where it was; a prompt over
    // one window and under the other must not be reported as over both.
    it("is a different cut from the embedder's", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            const answer = await search({ query: paste.slice(0, 1000), project: PROJECT }, { db, client: client() });
            const filters = JSON.parse(retrievalOf(db, answer.retrievalId).filters);

            assert.equal(filters.query_truncated, false);
            assert.equal(filters.rerank_query_truncated, true);
        });
    });

    it("leaves a short prompt alone and says the reranker saw all of it", async () => {
        await withDb(async ({ db }) => {
            seed(db);

            const answer = await run(db, {});
            const filters = JSON.parse(retrievalOf(db, answer.retrievalId).filters);

            assert.equal(filters.rerank_query_truncated, false);
            assert.equal(filters.rerank_query_truncated_to, null);
            assert.doesNotMatch(explain(db, answer.retrievalId).text, /the reranker saw the first/u);
        });
    });
});

const SEARCH_CLI = join(fileURLToPath(import.meta.url), "..", "..", "retrieval", "search-cli.js");

// The hooks pass the query over stdin because a prompt-time query is the prompt
// the person typed and an argv is readable in `ps`. That is only safe if the
// two ways of handing the CLI a query are the same retrieval.
describe("the CLI takes its query off stdin as well as off the argv", () => {
    const cli = (path, args, input) =>
        spawnSync("bun", [SEARCH_CLI, path, "--project", PROJECT, "--no-runtime", ...args], { input, encoding: "utf8" });

    it("answers a --query-stdin query exactly as it answers --query", async () => {
        await withDb(async ({ db, path }) => {
            seed(db);

            const onArgv = cli(path, ["--query", QUERY]);
            const onStdin = cli(path, ["--query-stdin"], QUERY);
            const withNewline = cli(path, ["--query-stdin"], `${QUERY}\n`);

            assert.equal(onArgv.status, 0, onArgv.stderr);
            assert.equal(onStdin.status, 0, onStdin.stderr);
            assert.ok(JSON.parse(onArgv.stdout).results.length > 0, "the fixture answers this query at all");

            // Byte-identical: the retrieval id is the one thing that differs
            // between two runs, and it is on stderr unless --with-id is given.
            assert.equal(onStdin.stdout, onArgv.stdout);
            assert.equal(withNewline.stdout, onArgv.stdout, "one trailing newline is the shell's, not the query's");
        });
    });

    it("refuses a call with neither a query nor a stdin one", async () => {
        await withDb(async ({ db, path }) => {
            seed(db);

            const missing = cli(path, []);
            const empty = cli(path, ["--query-stdin"], "   \n");

            assert.equal(missing.status, 1);
            assert.match(missing.stderr, /--query-stdin/u);
            assert.equal(empty.status, 1);
            assert.match(empty.stderr, /the query is empty/u);
        });
    });
});
