#!/usr/bin/env bun
/**
 * The vectors for every active memory that has none, written behind the
 * compaction that wrote the memory.
 *
 *     bun retrieval/embed-missing.js <db> [--timeout-ms N]
 *
 * `schema/write-generation.js` starts this detached after a write and does not
 * wait for it, so a compaction is never held on the runtime: the memory is
 * findable by FTS5 alone the moment it is written, and by the vector arm once
 * this has run. It is not a prompt, so it waits the whole runtime window and
 * ignores the autostart cooldown, and it embeds the same `title\n\nbody` text
 * the retrieval side scores.
 *
 * The answer on stdout is `{ ok, model, embedded, reason? }` and the exit
 * status is 0 either way: nothing waits for it, so there is nothing to fail.
 */

import { openMemoryDb } from "../schema/bun-sqlite.js";
import { bunFetchText, createClient } from "../runtime/client.js";
import { ensureRuntime } from "./ensure-runtime.js";
import { vectorToBlob } from "./store.js";

/** How many memories go to `/embed` in one call. */
export const BATCH = 16;

/** How long the runtime is given to come up before this gives up. */
export const RUNTIME_TIMEOUT_MS = 30_000;

/**
 * Embeds every active memory without a vector for the runtime's model.
 *
 * The model's name is only known from the runtime's first answer, so the first
 * batch is "memories with no vector at all" and every batch after it is
 * "memories with no vector for this model": a model change then re-embeds the
 * corpus one run at a time instead of never.
 *
 * @param {import("bun:sqlite").Database} db
 * @param {{ embed: (texts: string[], init?: { kind?: "query" | "document" }) => Promise<{ ok: true, vectors: number[][], dim: number, model: string } | { ok: false, reason: string }> }} client
 * @param {{ now?: () => string, batch?: number }} [options]
 * @returns {Promise<{ ok: true, model: string | null, embedded: number } | { ok: false, model: string | null, embedded: number, reason: string }>}
 */
export const embedMissing = async (db, client, options = {}) => {
    const batch = options.batch ?? BATCH;
    const now = options.now ?? (() => new Date().toISOString());
    const insert = db.query(`
        INSERT INTO embeddings (memory_id, model, dim, dtype, normalised, vector, created_at)
        VALUES (?, ?, ?, 'f32', 1, ?, ?)
    `);

    let model = null;
    let embedded = 0;

    for (;;) {
        const rows = missingRows(db, model, batch);

        if (rows.length === 0) {
            return { ok: true, model, embedded };
        }

        const answer = await client.embed(rows.map((row) => `${row.title}\n\n${row.body}`), { kind: "document" });

        if (!answer.ok) {
            return { ok: false, model, embedded, reason: answer.reason };
        }

        model = answer.model;

        db.transaction(() => {
            answer.vectors.forEach((vector, offset) => {
                insert.run(rows[offset].id, answer.model, answer.dim, vectorToBlob(vector), now());
            });
        })();

        embedded += rows.length;
    }
};

/**
 * @param {import("bun:sqlite").Database} db
 * @param {string | null} model
 * @param {number} limit
 * @returns {{ id: number, title: string, body: string }[]}
 */
const missingRows = (db, model, limit) =>
    model === null
        ? db
              .query(
                  `SELECT m.id, m.title, m.body FROM memories m
                   WHERE m.status = 'active' AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.memory_id = m.id)
                   ORDER BY m.id LIMIT ?`,
              )
              .all(limit)
        : db
              .query(
                  `SELECT m.id, m.title, m.body FROM memories m
                   WHERE m.status = 'active' AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.memory_id = m.id AND e.model = ?)
                   ORDER BY m.id LIMIT ?`,
              )
              .all(model, limit);

const main = async () => {
    const argv = process.argv.slice(2);
    const dbPath = argv[0];
    const flagAt = argv.indexOf("--timeout-ms");
    const timeoutMs = flagAt === -1 ? RUNTIME_TIMEOUT_MS : Number.parseInt(argv[flagAt + 1] ?? "", 10) || RUNTIME_TIMEOUT_MS;

    if (dbPath === undefined || dbPath.startsWith("--")) {
        console.log(JSON.stringify({ ok: false, model: null, embedded: 0, reason: "usage: bun retrieval/embed-missing.js <db> [--timeout-ms N]" }));

        return;
    }

    const client = createClient({ fetchText: bunFetchText });
    const runtime = await ensureRuntime({ client, cooldownMs: 0, timeoutMs, stampPath: `${dbPath}.autostart` });

    if (!runtime.ready) {
        console.log(JSON.stringify({ ok: false, model: null, embedded: 0, reason: runtime.reason }));

        return;
    }

    const opened = openMemoryDb(dbPath);

    try {
        console.log(JSON.stringify(await embedMissing(opened.db, client)));
    } finally {
        opened.close();
    }
};

if (import.meta.main) {
    await main();
}
