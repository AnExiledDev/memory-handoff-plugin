/**
 * Forward-only migrations, with no driver and no filesystem in them.
 *
 * The runtime sub-issue picks what executes SQL, so this core takes a port
 * instead: `{ run(sql), get(sql) }`. `schema/bun-sqlite.js` is one
 * implementation of it and reads the `.sql` files off disk; anything else that
 * can run a statement and read one row is another.
 *
 * The version lives in `schema_meta`, one row, written by the migration that
 * was last applied. A database newer than the newest file on disk is refused
 * rather than downgraded: v1 shipping without this would make the first schema
 * change a data loss event.
 */

/**
 * @typedef {object} Exec
 * @property {(sql: string) => void} run Runs SQL for its effect. Must accept a
 *   file's worth of statements in one call.
 * @property {(sql: string) => Record<string, unknown> | undefined} get Runs SQL
 *   and answers its first row, or undefined when there is none.
 */

/**
 * @typedef {object} Migration
 * @property {number} version
 * @property {string} name
 * @property {string} sql
 */

/** Every migration file, in order. A new one is appended here and nowhere else. */
export const MIGRATION_FILES = ["001-initial.sql"];

/**
 * The version a migration file's name claims, which is its leading digits.
 *
 * @param {string} name
 * @returns {number}
 */
export const migrationVersion = (name) => {
    const digits = /^(\d+)-/u.exec(name)?.[1];

    if (digits === undefined) {
        throw new Error(`memory-handoff: migration "${name}" does not start with a version number`);
    }

    return Number.parseInt(digits, 10);
};

/**
 * Applies every migration newer than the database, each in its own transaction.
 *
 * @param {Exec} exec
 * @param {Migration[]} migrations
 * @returns {{ from: number, to: number, applied: string[] }}
 */
export const migrate = (exec, migrations) => {
    const ordered = [...migrations].sort((left, right) => left.version - right.version);
    const newest = ordered.at(-1)?.version ?? 0;
    const from = readVersion(exec);

    if (from > newest) {
        throw new Error(
            `memory-handoff: the database is at schema version ${from} and the newest migration here is ${newest}; ` +
                "migrations are forward-only, so this is a newer install's database and it is left alone",
        );
    }

    const pending = ordered.filter((migration) => migration.version > from);

    for (const migration of pending) {
        applyOne(exec, migration);
    }

    return { from, to: readVersion(exec), applied: pending.map((migration) => migration.name) };
};

/**
 * The schema version on disk, 0 when nothing has ever been applied.
 *
 * The `sqlite_master` lookup is what makes "no `schema_meta` table" a version
 * rather than an error the caller has to recognise per driver.
 *
 * @param {Exec} exec
 * @returns {number}
 */
export const readVersion = (exec) => {
    const table = exec.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'");

    if (table === undefined || table === null) {
        return 0;
    }

    const row = exec.get("SELECT version FROM schema_meta WHERE id = 1");
    const version = row?.version;

    return typeof version === "number" ? version : 0;
};

/** @param {Exec} exec @param {Migration} migration @returns {void} */
const applyOne = (exec, migration) => {
    exec.run("BEGIN");

    try {
        exec.run(migration.sql);
        exec.run(stamp(migration.version));
        exec.run("COMMIT");
    } catch (error) {
        rollbackQuietly(exec);

        throw error;
    }
};

/**
 * The migration's own failure is the one worth reporting; a rollback that
 * throws on top of it would replace it with something less useful.
 *
 * @param {Exec} exec
 * @returns {void}
 */
const rollbackQuietly = (exec) => {
    try {
        exec.run("ROLLBACK");
    } catch {
        return;
    }
};

/**
 * Records the version, whether or not the file seeded it itself.
 *
 * @param {number} version
 * @returns {string}
 */
const stamp = (version) => {
    if (!Number.isInteger(version) || version < 1) {
        throw new Error(`memory-handoff: ${version} is not a schema version`);
    }

    return `INSERT INTO schema_meta (id, version, applied_at)
              VALUES (1, ${version}, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            ON CONFLICT(id) DO UPDATE
              SET version = excluded.version, applied_at = excluded.applied_at`;
};
