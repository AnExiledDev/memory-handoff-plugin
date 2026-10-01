/**
 * Forward-only migrations, with no driver and no filesystem in them.
 *
 * The runtime sub-issue picks what executes SQL, so this core takes a port
 * instead: `{ run(sql), get(sql) }`. `schema/bun-sqlite.js` is one
 * implementation of it and reads the `.sql` files off disk; anything else that
 * can run a statement and read one row is another.
 *
 * The version lives in `schema_meta`, one row, written by the migration that
 * was last applied, beside `min_reader`: the oldest schema version whose build
 * can still read and write the store. A database newer than the newest file on
 * disk is never downgraded. It is opened as it is when this build is at or
 * above its `min_reader`, and refused otherwise, because a session keeps the
 * plugin build it started with and an additive migration from a newer session
 * must not switch an older one off.
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
 * @property {number} minReader The oldest schema version whose build can still
 *   read and write the store once this migration has run.
 */

/**
 * Every migration file, in order. A new one is appended here and nowhere else.
 *
 * `minReader` is the migration's own claim about what it breaks. A migration
 * that only adds (a table, an index, a nullable or defaulted column) leaves
 * every older build working and keeps it low; one that renames, drops, or adds
 * something an older writer would violate sets it to its own version. The
 * README's Storage section has the full rule.
 *
 * @type {{ name: string, minReader: number }[]}
 */
export const MIGRATION_FILES = [
    { name: "001-initial.sql", minReader: 1 },
    { name: "002-injection-echoes.sql", minReader: 1 },
];

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
 * A database newer than every migration here is opened untouched, `to` equal
 * to `from`, when its `min_reader` allows this build, and refused when not.
 *
 * @param {Exec} exec
 * @param {Migration[]} migrations
 * @returns {{ from: number, to: number, applied: string[] }}
 */
export const migrate = (exec, migrations) => {
    const ordered = [...migrations].sort((left, right) => left.version - right.version);
    const newest = ordered.at(-1)?.version ?? 0;

    ordered.forEach(assertMinReader);

    const from = readVersion(exec);

    if (from > newest) {
        assertReadable(exec, from, newest);

        return { from, to: from, applied: [] };
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

/**
 * The oldest schema version whose build can still use the database.
 *
 * A store from before `min_reader` existed, or one whose row never had it
 * written, answers its own version: nobody vouched for an older reader, so
 * only a build that knows the whole schema opens it.
 *
 * @param {Exec} exec
 * @returns {number}
 */
export const readMinReader = (exec) => {
    const version = readVersion(exec);

    if (!hasMinReaderColumn(exec)) {
        return version;
    }

    const minReader = exec.get("SELECT min_reader FROM schema_meta WHERE id = 1")?.min_reader;

    return typeof minReader === "number" ? minReader : version;
};

/** @param {Exec} exec @returns {boolean} */
const hasMinReaderColumn = (exec) => {
    const column = exec.get("SELECT name FROM pragma_table_info('schema_meta') WHERE name = 'min_reader'");

    return column !== undefined && column !== null;
};

/**
 * Refuses a newer database this build is too old for, in the words the refusal
 * has always used, plus the version it would take.
 *
 * @param {Exec} exec
 * @param {number} from
 * @param {number} newest
 * @returns {void}
 */
const assertReadable = (exec, from, newest) => {
    const minReader = readMinReader(exec);

    if (newest >= minReader) {
        return;
    }

    throw new Error(
        `memory-handoff: the database is at schema version ${from} and the newest migration here is ${newest}; ` +
            "migrations are forward-only, so this is a newer install's database and it is left alone " +
            `(it needs a build that knows schema version ${minReader} or later)`,
    );
};

/**
 * A migration that vouches for no reader, or for one newer than itself, is a
 * mistake in this file rather than a database to open.
 *
 * @param {Migration} migration
 * @returns {void}
 */
const assertMinReader = ({ name, version, minReader }) => {
    if (Number.isInteger(minReader) && minReader >= 1 && minReader <= version) {
        return;
    }

    throw new Error(
        `memory-handoff: migration "${name}" claims minimum reader ${minReader}, which is not a schema version from 1 to ${version}`,
    );
};

/**
 * The store's minimum only ever rises: an additive migration on top of a
 * breaking one does not make the store readable by the builds the break
 * already shut out.
 *
 * @param {Exec} exec @param {Migration} migration @returns {void}
 */
const applyOne = (exec, migration) => {
    exec.run("BEGIN");

    try {
        exec.run(migration.sql);
        ensureMinReaderColumn(exec);
        exec.run(stamp(migration.version, Math.max(readMinReader(exec), migration.minReader)));
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
 * Gives `schema_meta` its `min_reader` column on a store from before it.
 *
 * Done inside the migration's transaction, after its SQL, so the check reads
 * the same state the write lands on; a second build racing this one waits on
 * the lock or retries through `withRetry`, and finds the column already there.
 * Older builds select `version` by name and never see it.
 *
 * @param {Exec} exec
 * @returns {void}
 */
const ensureMinReaderColumn = (exec) => {
    if (hasMinReaderColumn(exec)) {
        return;
    }

    exec.run("ALTER TABLE schema_meta ADD COLUMN min_reader INTEGER");
};

/**
 * Records the version and the minimum reader, whether or not the file seeded
 * the row itself.
 *
 * @param {number} version
 * @param {number} minReader
 * @returns {string}
 */
const stamp = (version, minReader) => {
    for (const value of [version, minReader]) {
        if (!Number.isInteger(value) || value < 1) {
            throw new Error(`memory-handoff: ${value} is not a schema version`);
        }
    }

    return `INSERT INTO schema_meta (id, version, applied_at, min_reader)
              VALUES (1, ${version}, strftime('%Y-%m-%dT%H:%M:%SZ','now'), ${minReader})
            ON CONFLICT(id) DO UPDATE
              SET version = excluded.version, applied_at = excluded.applied_at, min_reader = excluded.min_reader`;
};
