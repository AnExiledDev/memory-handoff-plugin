/**
 * The one adapter: `bun:sqlite` behind the port `schema/migrate.js` takes.
 *
 * Everything that touches a driver or a file is here, so the runtime sub-issue
 * can replace this file with a child process, a `node:sqlite` build or anything
 * else that can run a statement, and the migration core does not change.
 *
 * The three pragmas are set here rather than in the DDL because two of them do
 * not survive the connection anyway, and because a schema file that sets them
 * hides from the next adapter that they are its job. WAL and a busy timeout are
 * how two sessions compacting in the same minute both get to write.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MIGRATION_FILES, migrate, migrationVersion } from "./migrate.js";

/** How long SQLite itself waits for the write lock before it gives up. */
const BUSY_TIMEOUT_MS = 5000;

/** How many times a caller-level retry re-runs a statement SQLite refused. */
const RETRY_ATTEMPTS = 5;

/** The first backoff; attempt N waits N times this. */
const RETRY_SLEEP_MS = 40;

/**
 * Where the database lives: beside the plugin's rows, outside any repository,
 * because the plugin's own root is a worktree somebody may delete.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export const defaultDbPath = (env = process.env) => {
    const override = (env.MEMORY_HANDOFF_DIR ?? "").trim();
    const home = (env.HOME ?? "").trim();
    const dir = override !== "" ? override.replace(/\/+$/u, "") : `${home}/.claude/memory-handoff`;

    return join(dir, "memory.sqlite");
};

/** Every migration file, read off disk beside this module. @returns {import("./migrate.js").Migration[]} */
export const readMigrations = () => {
    const here = dirname(fileURLToPath(import.meta.url));

    return MIGRATION_FILES.map((name) => ({
        name,
        version: migrationVersion(name),
        sql: readFileSync(join(here, name), "utf8"),
    }));
};

/**
 * Opens the database, migrates it, and hands back both the driver and the port.
 *
 * @param {string} [path]
 * @returns {{ db: Database, exec: import("./migrate.js").Exec, migrated: { from: number, to: number, applied: string[] }, close: () => void }}
 */
export const openMemoryDb = (path = defaultDbPath()) => {
    mkdirSync(dirname(path), { recursive: true });

    const db = new Database(path, { create: true });

    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

    const exec = execPort(db);
    const migrated = withRetry(() => migrate(exec, readMigrations()));

    return { db, exec, migrated, close: () => db.close() };
};

/** @param {Database} db @returns {import("./migrate.js").Exec} */
const execPort = (db) => ({
    // `exec` rather than `run`, because a migration hands over a whole file and
    // a prepared statement would run only the first statement in it.
    run: (sql) => {
        db.exec(sql);
    },
    get: (sql) => db.query(sql).get() ?? undefined,
});

/**
 * Rebuilds the FTS index from `memories`.
 *
 * The immutability trigger makes index drift through a bypassing UPDATE
 * impossible, so this is for a database restored from a backup or copied out
 * from under a writer, and not part of normal writing.
 *
 * @param {import("./migrate.js").Exec} exec
 * @returns {void}
 */
export const rebuildFts = (exec) => {
    exec.run("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
};

/**
 * The tombstone, which is the default delete: the text stays, retrieval's
 * status filter stops returning it. A memory the user disagrees with is
 * evidence.
 *
 * @param {import("./migrate.js").Exec} exec
 * @param {number} id
 * @returns {void}
 */
export const tombstone = (exec, id) => {
    exec.run(
        `UPDATE memories SET status = 'deleted', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ${rowId(id)}`,
    );
};

/**
 * The real delete, for a memory that captured something that has to go.
 *
 * Cascades to `embeddings` and `retrieval_candidates` and takes the FTS row
 * with it through the `ad` trigger. `retrievals` and `injections` stay: they
 * hold ids and scores, no text.
 *
 * @param {import("./migrate.js").Exec} exec
 * @param {number} id
 * @returns {void}
 */
export const purge = (exec, id) => {
    exec.run(`DELETE FROM memories WHERE id = ${rowId(id)}`);
};

/**
 * Re-runs a call SQLite refused because another connection held the write lock.
 *
 * `busy_timeout` already covers most of it; this covers the rest, and exists
 * because a generation that cannot write must log and drop its memories rather
 * than block a compaction.
 *
 * @template T
 * @param {() => T} fn
 * @param {number} [attempts]
 * @returns {T}
 */
export const withRetry = (fn, attempts = RETRY_ATTEMPTS) => {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return fn();
        } catch (error) {
            if (!isBusy(error)) {
                throw error;
            }

            lastError = error;

            Bun.sleepSync(RETRY_SLEEP_MS * attempt);
        }
    }

    throw lastError;
};

/** @param {unknown} error @returns {boolean} */
const isBusy = (error) => {
    const code = /** @type {{ code?: unknown }} */ (error)?.code;
    const message = error instanceof Error ? error.message : String(error);

    return code === "SQLITE_BUSY" || /SQLITE_BUSY|database is locked|database table is locked/iu.test(message);
};

/** Ids reach these helpers as numbers, and only an integer is interpolated. */
const rowId = (id) => {
    if (!Number.isInteger(id) || id < 1) {
        throw new Error(`memory-handoff: ${id} is not a memory id`);
    }

    return id;
};
