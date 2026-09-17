/**
 * A database and a runtime for the retrieval tests, both fake enough to run
 * anywhere and real enough to prove something.
 *
 * The database is real SQLite with the real schema: FTS5, the triggers and the
 * CHECK constraints all apply, because half of what retrieval has to get right
 * is the SQL.
 *
 * The runtime is not real, and deliberately. The weights are 166 MB and a
 * checkout that has never run `bun runtime/install.js` must still be able to
 * prove that a vector-only candidate is traced, that a tie breaks by
 * `memory_id` and that a failed embed degrades. So the fake hands out vectors
 * the test chose itself, in a vector space of its own with a model name of its
 * own — which is also what proves retrieval filters `embeddings.model` rather
 * than assuming one space.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openMemoryDb } from "../schema/bun-sqlite.js";
import { vectorToBlob } from "../retrieval/store.js";

export const FAKE_EMBED_MODEL = "fake-bge/test";

export const FAKE_RERANK_MODEL = "fake-reranker/test";

const NOW = "2026-09-16T12:00:00Z";

/** A fresh database in a temp directory, removed whatever the test does. */
export const withDb = async (run) => {
    const dir = mkdtempSync(join(tmpdir(), "memory-handoff-retrieval-"));
    const path = join(dir, "memory.sqlite");
    const opened = openMemoryDb(path);

    try {
        return await run({ db: opened.db, path, dir });
    } finally {
        opened.close();
        rmSync(dir, { recursive: true, force: true });
    }
};

/**
 * One memory, and its embedding when the test gave one.
 *
 * @param {import("bun:sqlite").Database} db
 * @param {{ project?: string, type?: string, title?: string, body?: string, status?: string, supersedes?: number | null, importance?: number, createdAt?: string, vector?: number[] }} row
 * @returns {number}
 */
export const insertMemory = (db, row = {}) => {
    db.query(
        `INSERT INTO memories (uuid, project, type, title, body, importance, status, supersedes, source,
                               created_at, updated_at, generation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
        row.uuid ?? crypto.randomUUID(),
        row.project ?? "host/owner/repo",
        row.type ?? "project",
        row.title ?? "A title",
        row.body ?? "A body.",
        row.importance ?? 3,
        row.status ?? "active",
        row.supersedes ?? null,
        JSON.stringify({ kind: "test" }),
        row.createdAt ?? NOW,
        row.createdAt ?? NOW,
    );

    const id = Number(db.query("SELECT last_insert_rowid() AS id").get().id);

    if (row.vector !== undefined) {
        insertEmbedding(db, id, row.vector);
    }

    return id;
};

/** @param {import("bun:sqlite").Database} db @param {number} memoryId @param {number[]} vector */
export const insertEmbedding = (db, memoryId, vector, model = FAKE_EMBED_MODEL) => {
    db.query(
        `INSERT INTO embeddings (memory_id, model, dim, dtype, normalised, vector, created_at)
         VALUES (?, ?, ?, 'f32', 1, ?, ?)`,
    ).run(memoryId, model, vector.length, vectorToBlob(unit(vector)), NOW);
};

/** Vectors are compared with a dot product, which is only cosine when both sides are unit length. */
export const unit = (vector) => {
    const norm = Math.hypot(...vector) || 1;

    return vector.map((value) => value / norm);
};

/**
 * The runtime, as a value the test chooses.
 *
 * @param {{ queryVector?: number[], rerank?: (query: string, docs: string[]) => number[], embedFails?: string, rerankFails?: string, ready?: boolean }} options
 */
export const fakeClient = (options = {}) => {
    const calls = { embed: [], rerank: [] };

    return {
        calls,
        health: async () => (options.ready === false ? { ready: false, reason: "test says not ready" } : { ready: true }),
        embed: async (texts, init = {}) => {
            calls.embed.push({ texts, kind: init.kind });

            if (options.embedFails !== undefined) {
                return { ok: false, reason: options.embedFails };
            }

            return {
                ok: true,
                vectors: texts.map(() => unit(options.queryVector ?? [1, 0, 0, 0])),
                dim: (options.queryVector ?? [1, 0, 0, 0]).length,
                model: FAKE_EMBED_MODEL,
                ms: 1,
                truncated: texts.map(() => false),
            };
        },
        rerank: async (query, docs) => {
            calls.rerank.push({ query, docs });

            if (options.rerankFails !== undefined) {
                return { ok: false, reason: options.rerankFails };
            }

            return {
                ok: true,
                scores: options.rerank === undefined ? docs.map(() => 0) : options.rerank(query, docs),
                model: FAKE_RERANK_MODEL,
                ms: 1,
                truncated: docs.map(() => false),
            };
        },
    };
};
