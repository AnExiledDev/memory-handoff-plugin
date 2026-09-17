#!/usr/bin/env bun
/**
 * One generation, written to SQLite in one transaction.
 *
 * This is a CLI rather than a function the hook calls because the hook has no
 * SQLite: a plugin module runs in a sandbox that imports relative files and
 * nothing else, so the hook shells `bun schema/write-generation.js` through
 * `$.process.run` and hands the whole generation over on stdin.
 *
 *     echo '{"dbPath":"/tmp/m.sqlite", ...}' | bun schema/write-generation.js
 *
 * Failure is a value: the answer on stdout is `{ ok: false, reason }` and the
 * exit status is still 0, because the caller is a compaction hook that must
 * record what happened rather than raise.
 *
 * stdin is one JSON document:
 *
 * - `dbPath`      where the database is; the default path when absent.
 * - `project`     the key, when the caller already worked it out. Otherwise it
 *                 is derived from `remoteUrl`, `toplevel` and `cwd`.
 * - `source`      extra fields folded into every memory's `source` JSON.
 * - `rows`        the parser's rows.
 * - `generation`  the `generations` row's own fields (outcome, counts, timings).
 * - `usage`       the fork's `ModelForkUsage`, for pricing.
 * - `model`       the model the fork ran on.
 * - `costNote`    set instead of `usage` when no model call was made at all.
 */

import { openMemoryDb, withRetry } from "./bun-sqlite.js";
import { costRow, generationRow, memoryRow, projectKey } from "./generation-rows.js";

const MEMORY_COLUMNS = [
    "uuid",
    "project",
    "type",
    "title",
    "body",
    "importance",
    "status",
    "supersedes",
    "source",
    "created_at",
    "updated_at",
];

const main = async () => {
    const doc = await readDocument();
    const answer = write(doc);

    process.stdout.write(`${JSON.stringify(answer)}\n`);
};

/** Everything on stdin, as a document, or a reason it is not one. */
const readDocument = async () => {
    const text = await new Response(Bun.stdin.stream()).text();

    try {
        const parsed = JSON.parse(text);

        return parsed !== null && typeof parsed === "object" ? parsed : { badInput: "stdin is not a JSON object" };
    } catch (error) {
        return { badInput: `stdin is not JSON: ${String(error).slice(0, 200)}` };
    }
};

/** @param {Record<string, any>} doc */
const write = (doc) => {
    if (typeof doc.badInput === "string") {
        return { ok: false, reason: doc.badInput };
    }

    const keyed = keyOf(doc);

    if (keyed.project === null) {
        return { ok: false, reason: "no project key: neither a git remote, a toplevel nor a cwd was given" };
    }

    let opened = null;

    try {
        opened = doc.dbPath ? openMemoryDb(doc.dbPath) : openMemoryDb();

        return withRetry(() => insertAll(opened.db, doc, keyed));
    } catch (error) {
        return { ok: false, reason: String(error).slice(0, 500) };
    } finally {
        opened?.close();
    }
};

const keyOf = (doc) =>
    typeof doc.project === "string" && doc.project.trim() !== ""
        ? { project: doc.project.trim(), projectKind: doc.projectKind ?? null }
        : projectKey(doc.remoteUrl, doc.toplevel, doc.cwd);

/**
 * The cost, the generation and its memories, all or none.
 *
 * All three in one transaction because a `generations` row claiming memories
 * that are not there, or memories with no generation to explain where they came
 * from, is worse than a generation nobody recorded.
 */
const insertAll = (db, doc, keyed) => {
    const now = new Date().toISOString();
    const rows = Array.isArray(doc.rows) ? doc.rows : [];
    const generation = { at: now, ...(doc.generation ?? {}) };

    return db.transaction(() => {
        const costId = insertRow(db, "costs", costRow({
            at: generation.at,
            model: doc.model ?? null,
            usage: doc.usage ?? null,
            note: typeof doc.costNote === "string" ? doc.costNote : null,
        }));

        const generationId = insertRow(
            db,
            "generations",
            generationRow({ ...generation, memoriesWritten: rows.length }, keyed.project, costId),
        );

        const source = {
            kind: "compaction",
            ...(doc.source ?? {}),
            projectKind: keyed.projectKind,
            cwd: doc.cwd ?? null,
        };
        const ids = rows.map((row) =>
            insertMemory(db, memoryRow({ row, project: keyed.project, uuid: crypto.randomUUID(), now, source }), generationId),
        );

        return {
            ok: true,
            memoriesWritten: ids.length,
            ids,
            generationId,
            costId,
            project: keyed.project,
            projectKind: keyed.projectKind,
        };
    })();
};

/** @param {import("bun:sqlite").Database} db */
const insertRow = (db, table, row) => {
    const columns = Object.keys(row);
    const statement = db.query(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    );

    return Number(statement.run(...columns.map((column) => row[column])).lastInsertRowid);
};

const insertMemory = (db, row, generationId) =>
    insertRow(db, "memories", { ...pick(row, MEMORY_COLUMNS), generation_id: generationId });

const pick = (row, columns) => Object.fromEntries(columns.map((column) => [column, row[column]]));

await main();
