/**
 * The documented smoke run: `bun schema/smoke.js [path]`.
 *
 * One pass over everything the schema promises, on a fresh file: two memories,
 * an FTS5 match, both vector dtypes, a supersede, a generation with its cost, a
 * retrieval with three candidates including one that was filtered out, and an
 * injection. Every count is asserted here rather than eyeballed, and anything
 * that fails exits non-zero.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openMemoryDb } from "./bun-sqlite.js";

const NOW = "2026-09-16T12:00:00Z";
const MODEL = "bge-small-en-v1.5@refs/pr/1";
const PROJECT = "github.com/anexileddev/memory-handoff-plugin";

const path = process.argv[2] ?? join(tmpdir(), `memory-handoff-smoke-${process.pid}.sqlite`);

for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true });
}

const { db, exec, migrated, close } = openMemoryDb(path);

try {
    run();
} finally {
    close();
}

function run() {
    const costId = insertCost();
    const generationId = insertGeneration(costId);
    const first = insertMemory("m-1", "The box OOMs", "An OOM here killed cron for eight hours.", generationId);
    const second = insertMemory("m-2", "Prices are a dated read", "Every cost row records when the price page was read.", generationId);

    assert(matches("cron").includes(first), "FTS5 finds the first memory by a word from its body");
    assert(matches("price").includes(second), "the porter stemmer matches 'price' against 'prices'");

    insertVector(first, "f32", new Uint8Array(new Float32Array(384).fill(0.05).buffer));
    insertVector(second, "i8", new Uint8Array(384).fill(7));

    const successor = supersede(first, "m-3", "The box OOMs, and takes rsyslog with it", "An OOM here killed cron and rsyslog for eight hours.", generationId);

    const retrievalId = insertRetrieval();

    insertCandidate(retrievalId, successor, { fromFts: 1, ftsRank: 1, ftsScore: -3.2, finalRank: 1 });
    insertCandidate(retrievalId, second, { fromVector: 1, vectorRank: 1, vectorScore: 0.81, finalRank: 2 });
    insertCandidate(retrievalId, first, { fromFts: 1, ftsRank: 2, ftsScore: -1.1, filteredReason: "status: superseded" });

    insertInjection(retrievalId, [successor, second]);

    const counts = {
        memories: count("memories"),
        memories_fts: count("memories_fts"),
        embeddings: count("embeddings"),
        generations: count("generations"),
        costs: count("costs"),
        retrievals: count("retrievals"),
        retrieval_candidates: count("retrieval_candidates"),
        injections: count("injections"),
    };

    assertCounts(counts, {
        memories: 3,
        memories_fts: 3,
        embeddings: 2,
        generations: 1,
        costs: 1,
        retrievals: 1,
        retrieval_candidates: 3,
        injections: 1,
    });

    const vector = db.query("SELECT length(vector) AS bytes, dim FROM embeddings WHERE dtype = 'f32'").get();

    assert(vector?.bytes === 1536 && vector?.dim === 384, "the f32 vector is 1536 bytes over 384 dimensions");
    assert(readVersion() === 1, "the database is at schema version 1");
    assert(journalMode() === "wal", "the journal mode is wal");
    assert(status(first) === "superseded", "the superseded ancestor is still there, with its new status");

    refuses("a second successor for one ancestor", () =>
        insertMemory("m-4", "Another successor", "Refused by memories_one_successor.", generationId, first),
    );
    refuses("importance 6", () => insertRow({ uuid: "m-5", importance: 6 }));
    refuses("a status nothing defines", () => insertRow({ uuid: "m-6", status: "archived" }));
    refuses("usd = 0 with no cost_note", () =>
        db.query("INSERT INTO costs (at, kind, basis, usd) VALUES (?, 'generation', 'local: no API spend', 0)").run(NOW),
    );

    console.log(
        `smoke ok: ${path} schema v${migrated.to} (${migrated.applied.join(", ") || "already current"}), ` +
            Object.entries(counts)
                .map(([table, n]) => `${table}=${n}`)
                .join(" "),
    );
}

function insertCost() {
    db.query(
        `INSERT INTO costs (at, kind, model, usd, cache_read_waived_usd, input_tokens, output_tokens,
                            cache_read_input_tokens, cache_creation_input_tokens, basis, priced, prices_taken)
         VALUES (?, 'generation', 'claude-opus-5', 0.0012, 0.0144, 412, 260, 50630, 331,
                 'measured: $.model.fork usage', 'list', '2026-09-16')`,
    ).run(NOW);

    return lastId();
}

function insertGeneration(costId) {
    db.query(
        `INSERT INTO generations (at, session_id, compaction_n, trigger, project, messages_in, transcript_chars,
                                  outcome, memories_written, parsed_rows, rejected_rows, elapsed_ms, cost_id,
                                  plugin, engine)
         VALUES (?, 'session-smoke', 0, 'auto', ?, 118, 57000, 'wrote', 2, 2, 0, 2100, ?, '0.2.0', '2.1.273')`,
    ).run(NOW, PROJECT, costId);

    return lastId();
}

function insertMemory(uuid, title, body, generationId, supersedes = null) {
    insertRow({ uuid, title, body, generationId, supersedes });

    return lastId();
}

function insertRow(row) {
    db.query(
        `INSERT INTO memories (uuid, project, type, title, body, importance, status, supersedes, source,
                               created_at, updated_at, generation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        row.uuid,
        row.project ?? PROJECT,
        row.type ?? "project",
        row.title ?? "A title",
        row.body ?? "A body.",
        row.importance ?? 3,
        row.status ?? "active",
        row.supersedes ?? null,
        row.source ?? JSON.stringify({ kind: "compaction", sessionId: "session-smoke", n: 0, projectKind: "remote", cwd: "/tmp" }),
        row.createdAt ?? NOW,
        row.updatedAt ?? NOW,
        row.generationId ?? null,
    );
}

function supersede(ancestorId, uuid, title, body, generationId) {
    const successor = insertMemory(uuid, title, body, generationId, ancestorId);

    db.query("UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ?").run(NOW, ancestorId);

    return successor;
}

function insertVector(memoryId, dtype, bytes) {
    db.query(
        "INSERT INTO embeddings (memory_id, model, dim, dtype, normalised, vector, created_at) VALUES (?, ?, 384, ?, 1, ?, ?)",
    ).run(memoryId, MODEL, dtype, bytes, NOW);
}

function insertRetrieval() {
    db.query(
        `INSERT INTO retrievals (at, session_id, origin, query_text, query_source, filters, k,
                                 fts_n, vector_n, merged_n, reranked_n, returned_n,
                                 ms_total, ms_embed, ms_fts, ms_vector, ms_rerank)
         VALUES (?, 'session-smoke', 'prompt', 'what killed cron', 'raw-prompt', ?, 5, 2, 1, 3, 3, 2, 41, 12, 3, 9, 17)`,
    ).run(NOW, JSON.stringify({ project: PROJECT, types: ["project"], status: ["active"], k: 5 }));

    return lastId();
}

function insertCandidate(retrievalId, memoryId, scores) {
    db.query(
        `INSERT INTO retrieval_candidates (retrieval_id, memory_id, from_fts, from_vector, fts_rank, fts_score,
                                           vector_rank, vector_score, merge_score, merge_rank, rerank_score,
                                           final_rank, filtered_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        retrievalId,
        memoryId,
        scores.fromFts ?? 0,
        scores.fromVector ?? 0,
        scores.ftsRank ?? null,
        scores.ftsScore ?? null,
        scores.vectorRank ?? null,
        scores.vectorScore ?? null,
        scores.mergeScore ?? null,
        scores.mergeRank ?? null,
        scores.rerankScore ?? null,
        scores.finalRank ?? null,
        scores.filteredReason ?? null,
    );
}

function insertInjection(retrievalId, memoryIds) {
    db.query(
        `INSERT INTO injections (retrieval_id, at, session_id, memory_ids, entries, chars, approx_tokens,
                                 cap_chars, cap_entries, dropped, clipped_chars)
         VALUES (?, ?, 'session-smoke', ?, ?, 240, 60, 2000, 5, 1, 0)`,
    ).run(retrievalId, NOW, JSON.stringify(memoryIds), memoryIds.length);
}

function matches(term) {
    return db
        .query("SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ?")
        .all(term)
        .map((row) => row.id);
}

function count(table) {
    return db.query(`SELECT count(*) AS n FROM ${table}`).get().n;
}

function status(id) {
    return db.query("SELECT status FROM memories WHERE id = ?").get(id).status;
}

function readVersion() {
    return exec.get("SELECT version FROM schema_meta WHERE id = 1").version;
}

function journalMode() {
    return db.query("PRAGMA journal_mode").get().journal_mode;
}

function lastId() {
    return db.query("SELECT last_insert_rowid() AS id").get().id;
}

function assertCounts(actual, expected) {
    for (const [table, n] of Object.entries(expected)) {
        assert(actual[table] === n, `${table} holds ${n} rows, not ${actual[table]}`);
    }
}

function refuses(what, write) {
    try {
        write();
    } catch {
        return;
    }

    fail(`the schema accepted ${what}`);
}

function assert(ok, what) {
    if (!ok) {
        fail(what);
    }
}

function fail(what) {
    console.error(`smoke FAILED: ${what}`);
    close();
    process.exit(1);
}
