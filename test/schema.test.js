import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Database } from "bun:sqlite";

import { migrate, readVersion } from "../schema/migrate.js";
import { openMemoryDb, purge, readMigrations, rebuildFts, tombstone } from "../schema/bun-sqlite.js";

const HERE = join(fileURLToPath(import.meta.url), "..");
const SQLITE3 = "/usr/bin/sqlite3";
const NOW = "2026-09-16T12:00:00Z";
const SOURCE = JSON.stringify({ kind: "compaction", sessionId: "s", n: 0, projectKind: "remote", cwd: "/tmp" });

/** Every table the schema is allowed to have, and nothing else. */
const TABLES = [
    "costs",
    "embeddings",
    "generations",
    "injections",
    "memories",
    "memories_fts",
    "retrieval_candidates",
    "retrievals",
    "schema_meta",
];

/** A fresh database in its own temp directory, removed whatever the test does. */
const withDb = (run) => {
    const dir = mkdtempSync(join(tmpdir(), "memory-handoff-schema-"));
    const opened = openMemoryDb(join(dir, "memory.sqlite"));

    try {
        return run({ ...opened, dir, path: join(dir, "memory.sqlite") });
    } finally {
        opened.close();
        rmSync(dir, { recursive: true, force: true });
    }
};

const insertMemory = (db, row = {}) => {
    db.query(
        `INSERT INTO memories (uuid, project, type, title, body, importance, status, supersedes, source,
                               created_at, updated_at, generation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        row.uuid ?? "u-1",
        row.project ?? "host/owner/repo",
        row.type ?? "project",
        row.title ?? "A title",
        row.body ?? "The monitor tick pulls the checkout every five minutes.",
        row.importance ?? 3,
        row.status ?? "active",
        row.supersedes ?? null,
        row.source ?? SOURCE,
        row.createdAt ?? NOW,
        row.updatedAt ?? NOW,
        row.generationId ?? null,
    );

    return db.query("SELECT last_insert_rowid() AS id").get().id;
};

const insertCost = (db, row) => {
    db.query(
        `INSERT INTO costs (at, kind, model, usd, basis, cost_unknown_reason, cost_note)
         VALUES (?, 'generation', 'claude-opus-5', ?, ?, ?, ?)`,
    ).run(NOW, row.usd ?? null, row.basis ?? "measured: $.model.fork usage", row.reason ?? null, row.note ?? null);
};

const matches = (db, term) =>
    db
        .query("SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ?")
        .all(term)
        .map((found) => found.id);

const count = (db, table) => db.query(`SELECT count(*) AS n FROM ${table}`).get().n;

describe("the schema applies to an empty file", () => {
    it("creates exactly the documented tables and leaves the journal in wal", () => {
        withDb(({ db }) => {
            const found = db
                .query(
                    `SELECT name FROM sqlite_master
                     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memories_fts_%'
                     ORDER BY name`,
                )
                .all()
                .map((row) => row.name);

            assert.deepEqual(found, TABLES);
            assert.equal(db.query("PRAGMA journal_mode").get().journal_mode, "wal");
        });
    });

    it("ends at schema version 1", () => {
        withDb(({ exec, migrated }) => {
            assert.equal(readVersion(exec), 1);
            assert.deepEqual(migrated, { from: 0, to: 1, applied: ["001-initial.sql"] });
        });
    });

    it("applies nothing the second time", () => {
        withDb(({ exec }) => {
            assert.deepEqual(migrate(exec, readMigrations()), { from: 1, to: 1, applied: [] });
        });
    });

    it("refuses a database newer than the newest migration", () => {
        const dir = mkdtempSync(join(tmpdir(), "memory-handoff-future-"));
        const db = new Database(join(dir, "future.sqlite"), { create: true });

        try {
            db.exec("CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, applied_at TEXT NOT NULL)");
            db.exec("INSERT INTO schema_meta (id, version, applied_at) VALUES (1, 99, '2026-09-16T12:00:00Z')");

            const exec = { run: (sql) => db.exec(sql), get: (sql) => db.query(sql).get() ?? undefined };

            assert.throws(() => migrate(exec, readMigrations()), /version 99/u);
        } finally {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("FTS5 tracks the memories table through its triggers", () => {
    it("indexes an inserted memory and forgets a deleted one", () => {
        withDb(({ db, exec }) => {
            const id = insertMemory(db, { body: "The astdiff fork is six times faster on these inputs." });

            assert.deepEqual(matches(db, "astdiff"), [id]);

            purge(exec, id);

            assert.deepEqual(matches(db, "astdiff"), []);
        });
    });

    it("keeps the row findable across the one update the schema allows", () => {
        withDb(({ db, exec }) => {
            const id = insertMemory(db, { body: "Cron died in an OOM sweep and nothing said so." });

            tombstone(exec, id);

            assert.deepEqual(matches(db, "OOM"), [id]);
            assert.equal(db.query("SELECT status, body FROM memories WHERE id = ?").get(id).status, "deleted");
        });
    });

    it("rebuilds the index from the memories table", () => {
        withDb(({ db, exec }) => {
            const id = insertMemory(db, { body: "A rebuild is for a database restored from a backup." });

            rebuildFts(exec);

            assert.deepEqual(matches(db, "backup"), [id]);
        });
    });
});

describe("embeddings", () => {
    it("round-trips a 1536-byte float32 vector byte for byte", () => {
        withDb(({ db }) => {
            const id = insertMemory(db);
            const floats = Float32Array.from({ length: 384 }, (_, n) => (n - 192) / 384);
            const bytes = new Uint8Array(floats.buffer);

            db.query(
                "INSERT INTO embeddings (memory_id, model, dim, dtype, normalised, vector, created_at) VALUES (?, 'bge-small-en-v1.5', 384, 'f32', 1, ?, ?)",
            ).run(id, bytes, NOW);

            const row = db.query("SELECT length(vector) AS bytes, dim, vector FROM embeddings WHERE memory_id = ?").get(id);

            assert.equal(row.bytes, 1536);
            assert.equal(row.dim, 384);
            assert.deepEqual(new Uint8Array(row.vector), bytes);
        });
    });

    it("takes an i8 vector for the same memory and a different model", () => {
        withDb(({ db }) => {
            const id = insertMemory(db);

            db.query(
                "INSERT INTO embeddings (memory_id, model, dim, dtype, normalised, vector, created_at) VALUES (?, 'bge-small-en-v1.5-i8', 384, 'i8', 1, ?, ?)",
            ).run(id, new Uint8Array(384).fill(3), NOW);

            assert.equal(count(db, "embeddings"), 1);
            assert.equal(db.query("SELECT length(vector) AS bytes FROM embeddings").get().bytes, 384);
        });
    });
});

describe("the lifecycle is insert-plus-supersede", () => {
    it("keeps the ancestor and points the successor at it", () => {
        withDb(({ db }) => {
            const ancestor = insertMemory(db, { uuid: "u-old" });
            const successor = insertMemory(db, { uuid: "u-new", supersedes: ancestor });

            db.query("UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ?").run(NOW, ancestor);

            assert.equal(db.query("SELECT status FROM memories WHERE id = ?").get(ancestor).status, "superseded");
            assert.equal(db.query("SELECT supersedes FROM memories WHERE id = ?").get(successor).supersedes, ancestor);
        });
    });

    it("refuses a second successor for one ancestor", () => {
        withDb(({ db }) => {
            const ancestor = insertMemory(db, { uuid: "u-old" });

            insertMemory(db, { uuid: "u-new", supersedes: ancestor });

            assert.throws(() => insertMemory(db, { uuid: "u-newer", supersedes: ancestor }), /UNIQUE|constraint/iu);
        });
    });

    it("refuses an update to anything but status, updated_at and supersedes", () => {
        withDb(({ db }) => {
            const id = insertMemory(db);

            assert.throws(() => db.query("UPDATE memories SET body = 'rewritten' WHERE id = ?").run(id), /immutable/u);
            assert.throws(() => db.query("UPDATE memories SET importance = 5 WHERE id = ?").run(id), /immutable/u);

            db.query("UPDATE memories SET status = 'invalidated', updated_at = ? WHERE id = ?").run("2026-09-17T00:00:00Z", id);

            assert.equal(db.query("SELECT status FROM memories WHERE id = ?").get(id).status, "invalidated");
        });
    });
});

describe("the schema refuses a row it cannot mean", () => {
    const refused = {
        "importance below the range": { importance: 0 },
        "importance above the range": { importance: 6 },
        "a status nothing defines": { status: "archived" },
        "a type outside the vocabulary": { type: "decision" },
        "an empty project key": { project: "" },
        "a title over 200 characters": { title: "t".repeat(201) },
        "a body over 4000 characters": { body: "b".repeat(4001) },
        "a source that is not JSON": { source: "not json" },
    };

    for (const [what, row] of Object.entries(refused)) {
        it(`refuses ${what}`, () => {
            withDb(({ db }) => {
                assert.throws(() => insertMemory(db, row), /constraint/iu);
            });
        });
    }

    it("takes a title and a body at the cap", () => {
        withDb(({ db }) => {
            const id = insertMemory(db, { title: "t".repeat(200), body: "b".repeat(4000) });

            assert.equal(id, 1);
        });
    });
});

describe("a cost is never an unexplained zero", () => {
    it("refuses usd = 0 with no cost_note", () => {
        withDb(({ db }) => {
            assert.throws(() => insertCost(db, { usd: 0 }), /constraint/iu);
        });
    });

    it("takes a real zero that says why it is one", () => {
        withDb(({ db }) => {
            insertCost(db, { usd: 0, basis: "local: no API spend", note: "no model call was made" });

            assert.equal(count(db, "costs"), 1);
        });
    });

    it("takes an unknown price with a reason", () => {
        withDb(({ db }) => {
            insertCost(db, { usd: null, reason: "no usage on the result" });

            const row = db.query("SELECT usd, cost_unknown_reason FROM costs").get();

            assert.equal(row.usd, null);
            assert.equal(row.cost_unknown_reason, "no usage on the result");
        });
    });
});

describe("a retrieval keeps every candidate it considered", () => {
    const traced = (db) => {
        const kept = insertMemory(db, { uuid: "u-kept", body: "The monitor tick pulls the checkout every five minutes." });
        const dropped = insertMemory(db, { uuid: "u-dropped", status: "superseded", body: "An unrelated sentence about vendored forks." });

        db.query(
            `INSERT INTO retrievals (at, origin, query_text, query_source, filters, k, returned_n, fts_n, vector_n)
             VALUES (?, 'prompt', 'what pulls the checkout', 'raw-prompt', '{"k":5}', 5, 1, 2, 0)`,
        ).run(NOW);

        const retrievalId = db.query("SELECT last_insert_rowid() AS id").get().id;

        db.query(
            "INSERT INTO retrieval_candidates (retrieval_id, memory_id, from_fts, fts_rank, fts_score, final_rank) VALUES (?, ?, 1, 1, -2.4, 1)",
        ).run(retrievalId, kept);
        db.query(
            "INSERT INTO retrieval_candidates (retrieval_id, memory_id, from_fts, fts_rank, fts_score, filtered_reason) VALUES (?, ?, 1, 2, -1.1, 'status: superseded')",
        ).run(retrievalId, dropped);

        return { retrievalId, kept, dropped };
    };

    it("writes one row per candidate including the filtered one", () => {
        withDb(({ db }) => {
            const { dropped } = traced(db);

            assert.equal(count(db, "retrievals"), 1);
            assert.equal(count(db, "retrieval_candidates"), 2);

            const filtered = db.query("SELECT final_rank, filtered_reason FROM retrieval_candidates WHERE memory_id = ?").get(dropped);

            assert.equal(filtered.final_rank, null);
            assert.equal(filtered.filtered_reason, "status: superseded");
        });
    });

    it("records an injection against the retrieval that fed it", () => {
        withDb(({ db }) => {
            const { retrievalId, kept } = traced(db);

            db.query(
                `INSERT INTO injections (retrieval_id, at, memory_ids, entries, chars, approx_tokens, cap_chars, cap_entries)
                 VALUES (?, ?, ?, 1, 120, 30, 2000, 5)`,
            ).run(retrievalId, NOW, JSON.stringify([kept]));

            assert.deepEqual(JSON.parse(db.query("SELECT memory_ids FROM injections").get().memory_ids), [kept]);
        });
    });

    it("purges a memory out of its embeddings and candidates and leaves the trace", () => {
        withDb(({ db, exec }) => {
            const { kept } = traced(db);

            db.query(
                "INSERT INTO embeddings (memory_id, model, dim, dtype, vector, created_at) VALUES (?, 'bge-small-en-v1.5', 384, 'f32', ?, ?)",
            ).run(kept, new Uint8Array(1536), NOW);

            purge(exec, kept);

            assert.equal(count(db, "memories"), 1);
            assert.equal(count(db, "embeddings"), 0);
            assert.equal(count(db, "retrieval_candidates"), 1);
            assert.equal(count(db, "retrievals"), 1);
            assert.deepEqual(matches(db, "checkout"), []);
        });
    });

    it("keeps the text and the index when the delete is a tombstone", () => {
        withDb(({ db, exec }) => {
            const { kept } = traced(db);

            tombstone(exec, kept);

            assert.equal(count(db, "memories"), 2);
            assert.deepEqual(matches(db, "checkout"), [kept]);
        });
    });
});

describe("two writers on one file", () => {
    it("loses nothing when two processes insert at once", async () => {
        const dir = mkdtempSync(join(tmpdir(), "memory-handoff-concurrent-"));
        const path = join(dir, "memory.sqlite");

        try {
            openMemoryDb(path).close();

            const writers = ["alpha", "beta"].map((tag) =>
                Bun.spawn(["bun", join(HERE, "concurrent-writer.js"), path, tag, "50"], { stdout: "pipe", stderr: "pipe" }),
            );
            const exits = await Promise.all(writers.map((writer) => writer.exited));
            const errors = await Promise.all(writers.map((writer) => new Response(writer.stderr).text()));

            assert.deepEqual(exits, [0, 0]);
            assert.deepEqual(
                errors.map((text) => text.trim()),
                ["", ""],
            );

            const reader = new Database(path);

            try {
                assert.equal(reader.query("SELECT count(*) AS n FROM memories").get().n, 100);
                assert.equal(reader.query("SELECT count(DISTINCT uuid) AS n FROM memories").get().n, 100);
            } finally {
                reader.close();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("the same file under both SQLite builds", () => {
    const crossVersion = existsSync(SQLITE3) ? it : it.skip;

    crossVersion("agrees with the 3.37.2 CLI on a count and an FTS match", () => {
        withDb(({ db, path, close }) => {
            const id = insertMemory(db, { body: "The prompt corpus capture tick runs hourly." });

            insertMemory(db, { uuid: "u-2", body: "Nothing about this one mentions the same word." });
            close();

            const read = (sql) => {
                const result = spawnSync(SQLITE3, [path, sql], { encoding: "utf8" });

                assert.equal(result.status, 0, result.stderr);

                return result.stdout.trim();
            };

            assert.equal(read("SELECT count(*) FROM memories"), "2");
            assert.equal(read("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'corpus'"), String(id));
            assert.equal(read("PRAGMA journal_mode"), "wal");
        });
    });
});
