#!/usr/bin/env bun
/**
 * The reads and writes the hooks need that are not a generation or a retrieval.
 *
 *     echo '{"limit":20}' | bun schema/memory-admin.js <db> list
 *
 * A CLI for the same reason `write-generation.js` is one: a plugin module runs
 * in a sandbox that can import its own files and `claude-code` and nothing
 * else, so it cannot open SQLite at all. The hook shells this and reads one
 * JSON document off stdout.
 *
 * The argument document goes over **stdin**, never the argv, because an
 * injection's failure row carries the prompt the person typed and an argv is
 * readable in `ps`.
 *
 * Failure is a value: the answer is `{ ok: false, reason }` and the exit status
 * is still 0, because every caller is a hook that must record what happened
 * rather than raise. An unknown op is the same shape.
 *
 * Four ops:
 *
 * - `counts`    what `memory_status` reports: the corpus, the logs, the spend.
 * - `list`      this project's memories, newest first, paged.
 * - `delete`    tombstone by default; `{ "purge": true }` removes the row.
 * - `injection` the `injections` row, and the `retrievals` row for a retrieval
 *               that never answered.
 */

import { openMemoryDb, purge, tombstone, withRetry } from "./bun-sqlite.js";

const OPS = ["counts", "list", "delete", "injection"];

/** How many memories `list` returns when the caller does not say. */
const DEFAULT_LIMIT = 20;

/** The most any one call returns, so a tool result cannot become a corpus dump. */
const MAX_LIMIT = 100;

/** How much of a body `list` carries; the whole of it is what `memory_explain` and retrieval are for. */
const BODY_PREVIEW = 400;

const main = async () => {
    const [dbPath, op] = process.argv.slice(2);
    const doc = await readDocument();

    process.stdout.write(`${JSON.stringify(run(dbPath, op, doc))}\n`);
};

/** Everything on stdin, as a document. No stdin at all is an empty one. */
const readDocument = async () => {
    const text = (await new Response(Bun.stdin.stream()).text()).trim();

    if (text === "") {
        return {};
    }

    try {
        const parsed = JSON.parse(text);

        return parsed !== null && typeof parsed === "object" ? parsed : { badInput: "stdin is not a JSON object" };
    } catch (error) {
        return { badInput: `stdin is not JSON: ${String(error).slice(0, 200)}` };
    }
};

const run = (dbPath, op, doc) => {
    if (typeof dbPath !== "string" || dbPath === "" || dbPath.startsWith("-")) {
        return { ok: false, reason: `usage: bun schema/memory-admin.js <db> <${OPS.join("|")}>` };
    }

    if (!OPS.includes(op)) {
        return { ok: false, reason: `no op named ${String(op)}; the ops are ${OPS.join(", ")}` };
    }

    if (typeof doc.badInput === "string") {
        return { ok: false, reason: doc.badInput };
    }

    let opened = null;

    try {
        opened = openMemoryDb(dbPath);

        return withRetry(() => apply(opened, op, doc));
    } catch (error) {
        return { ok: false, reason: String(error).slice(0, 500) };
    } finally {
        opened?.close();
    }
};

const apply = (opened, op, doc) => {
    if (op === "counts") {
        return counts(opened.db);
    }

    if (op === "list") {
        return list(opened.db, doc);
    }

    if (op === "delete") {
        return remove(opened, doc);
    }

    return injection(opened.db, doc);
};

/**
 * What this database holds and what it has cost.
 *
 * The spend is split three ways on purpose: what was priced, what is waived
 * (cache reads on a subscription), and how many rows carry no price at all. A
 * total that silently folded the unpriced rows in as zero is the one number the
 * `costs` table's own CHECK exists to prevent.
 */
const counts = (db) => {
    const one = (sql, ...params) => db.query(sql).get(...params);
    const memories = one(
        `SELECT count(*) AS total,
                sum(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
                sum(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END) AS deleted
           FROM memories`,
    );
    const spend = one(
        `SELECT count(*) AS rows_all,
                sum(CASE WHEN usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
                sum(CASE WHEN usd IS NULL THEN 0 ELSE usd END) AS usd,
                sum(CASE WHEN cache_read_waived_usd IS NULL THEN 0 ELSE cache_read_waived_usd END) AS waived
           FROM costs`,
    );

    return {
        ok: true,
        memories: { total: memories.total ?? 0, active: memories.active ?? 0, deleted: memories.deleted ?? 0 },
        projects: one("SELECT count(DISTINCT project) AS n FROM memories").n ?? 0,
        generations: one("SELECT count(*) AS n FROM generations").n ?? 0,
        retrievals: one("SELECT count(*) AS n FROM retrievals").n ?? 0,
        injections: one("SELECT count(*) AS n FROM injections").n ?? 0,
        spend: {
            rows: spend.rows_all ?? 0,
            usd: round6(spend.usd ?? 0),
            cacheReadWaivedUsd: round6(spend.waived ?? 0),
            unpricedRows: spend.unpriced ?? 0,
        },
    };
};

/** This project's memories, newest first. Bodies are cut; the store is not a listing. */
const list = (db, doc) => {
    const limit = Math.min(MAX_LIMIT, Math.max(1, integerOr(doc.limit, DEFAULT_LIMIT)));
    const offset = Math.max(0, integerOr(doc.offset, 0));
    const status = listOf(doc.status) ?? ["active"];
    const project = typeof doc.project === "string" ? doc.project.trim() : "";
    const where = [`status IN (${status.map(() => "?").join(", ")})`];
    const params = [...status];

    if (project !== "") {
        where.push("project = ?");
        params.push(project);
    }

    const rows = db
        .query(
            `SELECT id, project, type, title, body, importance, status, created_at AS createdAt,
                    updated_at AS updatedAt, generation_id AS generationId
               FROM memories
              WHERE ${where.join(" AND ")}
              ORDER BY created_at DESC, id DESC
              LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset);

    const total = db
        .query(`SELECT count(*) AS n FROM memories WHERE ${where.join(" AND ")}`)
        .get(...params).n;

    return {
        ok: true,
        total,
        limit,
        offset,
        status,
        project: project === "" ? null : project,
        memories: rows.map((row) => ({
            ...row,
            body: row.body.length > BODY_PREVIEW ? `${row.body.slice(0, BODY_PREVIEW)}…` : row.body,
            bodyChars: row.body.length,
        })),
    };
};

/**
 * A memory the person disagrees with.
 *
 * The tombstone is the default: `status = 'deleted'` keeps the text, and
 * retrieval's status filter stops returning it, so a memory somebody removed is
 * still evidence of what a generation wrote. `purge` is the real delete for
 * text that has to go; `injections.memory_ids` keeps the id either way, so the
 * record that it was once injected survives the text.
 */
const remove = (opened, doc) => {
    const id = integerOr(doc.id, 0);

    if (id < 1) {
        return { ok: false, reason: `${JSON.stringify(doc.id ?? null)} is not a memory id` };
    }

    const before = opened.db.query("SELECT id, title, status FROM memories WHERE id = ?").get(id);

    if (before === null || before === undefined) {
        return { ok: false, reason: `no memory ${id} in this database` };
    }

    const purged = doc.purge === true;

    if (purged) {
        purge(opened.exec, id);
    } else {
        tombstone(opened.exec, id);
    }

    return { ok: true, id, mode: purged ? "purged" : "tombstoned", title: before.title, wasStatus: before.status };
};

/**
 * What was put in front of the model, and what happened when nothing was.
 *
 * A retrieval that timed out or died has no `retrievals` row of its own — the
 * child never got to write one — and `injections.retrieval_id` is NOT NULL. So
 * the failure is recorded as the retrieval it was: a row with `returned_n = 0`
 * and the reason in `degraded`, which is the column that already means "this
 * retrieval did not run whole". The `injections` row then hangs off it with
 * zero entries, and the pair reads as one fact.
 */
const injection = (db, doc) => {
    const at = typeof doc.at === "string" ? doc.at : new Date().toISOString();
    const memoryIds = Array.isArray(doc.memoryIds) ? doc.memoryIds : [];

    return db.transaction(() => {
        const retrievalId = doc.retrievalId ?? insertFailedRetrieval(db, doc, at);

        if (!Number.isInteger(retrievalId)) {
            return { ok: false, reason: "an injection row needs a retrieval id or a failure to record" };
        }

        const id = insertRow(db, "injections", {
            retrieval_id: retrievalId,
            at,
            session_id: doc.sessionId ?? null,
            turn_id: doc.turnId ?? null,
            memory_ids: JSON.stringify(memoryIds),
            entries: memoryIds.length,
            chars: integerOr(doc.chars, 0),
            approx_tokens: integerOr(doc.approxTokens, 0),
            cap_chars: integerOr(doc.capChars, 0),
            cap_entries: integerOr(doc.capEntries, 0),
            dropped: integerOr(doc.dropped, 0),
            clipped_chars: integerOr(doc.clippedChars, 0),
        });

        return { ok: true, injectionId: id, retrievalId };
    })();
};

/** The trace for a retrieval that never answered, so the injection has something to point at. */
const insertFailedRetrieval = (db, doc, at) => {
    const failure = doc.failure ?? null;

    if (failure === null || typeof failure !== "object") {
        return null;
    }

    return insertRow(db, "retrievals", {
        at,
        session_id: doc.sessionId ?? null,
        turn_id: doc.turnId ?? null,
        origin: typeof failure.origin === "string" ? failure.origin : "prompt",
        query_text: String(failure.query ?? ""),
        query_source: "raw-prompt",
        filters: JSON.stringify({
            project: failure.project ?? null,
            status: ["active"],
            types: null,
            since: null,
            until: null,
            failure_reason: String(failure.reason ?? "the retrieval did not answer"),
        }),
        k: integerOr(failure.k, 0),
        returned_n: 0,
        ms_total: failure.msTotal === null || failure.msTotal === undefined ? null : integerOr(failure.msTotal, 0),
        degraded: String(failure.reason ?? "the retrieval did not answer").slice(0, 500),
    });
};

/** @param {import("bun:sqlite").Database} db */
const insertRow = (db, table, row) => {
    const columns = Object.keys(row);
    const statement = db.query(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    );

    return Number(statement.run(...columns.map((column) => row[column])).lastInsertRowid);
};

const integerOr = (value, fallback) => (Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback);

const listOf = (raw) => {
    const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;
    const cleaned = values === null ? [] : values.map((part) => String(part).trim()).filter((part) => part !== "");

    return cleaned.length === 0 ? null : cleaned;
};

const round6 = (value) => Math.round(value * 1_000_000) / 1_000_000;

await main();
