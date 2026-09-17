import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Database } from "bun:sqlite";

const HERE = join(fileURLToPath(import.meta.url), "..");
const ADMIN = join(HERE, "..", "schema", "memory-admin.js");
const WRITER = join(HERE, "..", "schema", "write-generation.js");

const PROJECT = "github.com/owner/repo";

const LONG_BODY = "the whole of a memory nobody wants in a listing. ".repeat(20);

const MEMORIES = [
    {
        type: "project",
        title: "the staging psql needs a TLS mode set",
        body: "connections hang forever without it",
        importance: 4,
        supersedesHint: null,
    },
    {
        type: "feedback",
        title: "one fix per pull request",
        body: LONG_BODY,
        importance: 3,
        supersedesHint: null,
    },
];

/**
 * A database with two memories, a generation and a cost in it, and the admin
 * script pointed at it. The writer seeds it because the writer is what writes
 * a real one; a hand-built fixture would be a second schema to keep honest.
 */
const withAdmin = (run) => {
    const dir = mkdtempSync(join(tmpdir(), "memory-handoff-admin-"));
    const dbPath = join(dir, "memory.sqlite");
    const admin = (op, doc = {}) => {
        const ran = spawnSync("bun", [ADMIN, dbPath, op], { input: JSON.stringify(doc), encoding: "utf8" });

        // Every failure is a value, so a non-zero exit is the bug this asserts.
        assert.equal(ran.status, 0, `the admin script exited ${ran.status}: ${ran.stderr}`);

        return JSON.parse(ran.stdout.trim().split("\n").at(-1));
    };
    const read = (sql) => {
        const db = new Database(dbPath, { readonly: true });

        try {
            return db.query(sql).all();
        } finally {
            db.close();
        }
    };

    const seeded = spawnSync("bun", [WRITER], {
        input: JSON.stringify({
            dbPath,
            remoteUrl: "git@github.com:owner/repo.git",
            cwd: "/work/repo",
            source: { sessionId: "s1", n: 0, via: "hook" },
            model: "claude-opus-5",
            usage: { input_tokens: 12, output_tokens: 800, cache_read_input_tokens: 57_000, cache_creation_input_tokens: 0 },
            rows: MEMORIES,
            generation: {
                at: "2026-09-16T12:00:00Z",
                sessionId: "s1",
                compactionN: 0,
                trigger: "manual",
                messagesIn: 42,
                outcome: "wrote",
                parsedRows: 2,
                rejectedRows: 0,
                elapsedMs: 2100,
                plugin: "0.4.0",
                engine: "2.1.273",
            },
        }),
        encoding: "utf8",
    });

    assert.equal(seeded.status, 0, `the writer exited ${seeded.status}: ${seeded.stderr}`);

    const ids = JSON.parse(seeded.stdout.trim().split("\n").at(-1)).ids;

    try {
        return run({ admin, read, ids, dbPath });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

describe("memory-admin counts", () => {
    it("reports the corpus, the logs and the spend split three ways", () => {
        withAdmin(({ admin }) => {
            const answer = admin("counts");

            assert.equal(answer.ok, true);
            assert.deepEqual(answer.memories, { total: 2, active: 2, deleted: 0 });
            assert.equal(answer.projects, 1);
            assert.equal(answer.unembedded, 2, "both memories have no vector until the embedder has run");
            assert.equal(answer.generations, 1);
            assert.equal(answer.injections, 0);

            // Priced, waived and unpriced are three numbers because folding the
            // unpriced rows in as zero reads as "this was free".
            assert.equal(answer.spend.rows, 1);
            assert.ok(answer.spend.usd > 0);
            assert.ok(answer.spend.cacheReadWaivedUsd > 0);
            assert.equal(answer.spend.unpricedRows, 0);
        });
    });
});

describe("memory-admin list", () => {
    it("answers this project's memories newest first, with the bodies cut", () => {
        withAdmin(({ admin }) => {
            const answer = admin("list", { project: PROJECT });

            assert.equal(answer.ok, true);
            assert.equal(answer.total, 2);
            assert.equal(answer.project, PROJECT);
            assert.deepEqual(answer.status, ["active"]);
            assert.deepEqual(answer.memories.map((row) => row.title), [
                "one fix per pull request",
                "the staging psql needs a TLS mode set",
            ]);

            const long = answer.memories[0];

            assert.equal(long.bodyChars, LONG_BODY.length);
            assert.equal(long.body.length, 401);
            assert.ok(long.body.endsWith("…"));
        });
    });

    it("pages with limit and offset", () => {
        withAdmin(({ admin }) => {
            const first = admin("list", { limit: 1 });
            const second = admin("list", { limit: 1, offset: 1 });

            assert.equal(first.total, 2);
            assert.equal(first.memories.length, 1);
            assert.equal(second.memories.length, 1);
            assert.notEqual(first.memories[0].id, second.memories[0].id);
        });
    });

    it("leaves a tombstoned memory out until the caller asks for it", () => {
        withAdmin(({ admin, ids }) => {
            admin("delete", { id: ids[0] });

            assert.deepEqual(admin("list").memories.map((row) => row.id), [ids[1]]);
            assert.deepEqual(admin("list", { status: ["deleted"] }).memories.map((row) => row.id), [ids[0]]);
        });
    });
});

describe("memory-admin delete", () => {
    it("tombstones by default, keeping the text and the row", () => {
        withAdmin(({ admin, read, ids }) => {
            const answer = admin("delete", { id: ids[0] });

            assert.equal(answer.ok, true);
            assert.equal(answer.mode, "tombstoned");
            assert.equal(answer.wasStatus, "active");

            const [row] = read(`SELECT status, body FROM memories WHERE id = ${ids[0]}`);

            assert.equal(row.status, "deleted");
            assert.equal(row.body, MEMORIES[0].body);
        });
    });

    it("purges the row outright when asked", () => {
        withAdmin(({ admin, read, ids }) => {
            const answer = admin("delete", { id: ids[0], purge: true });

            assert.equal(answer.mode, "purged");
            assert.deepEqual(read(`SELECT id FROM memories WHERE id = ${ids[0]}`), []);
            assert.equal(read("SELECT id FROM memories").length, 1);
        });
    });

    it("refuses an id that is not in this database, as a value", () => {
        withAdmin(({ admin }) => {
            const answer = admin("delete", { id: 9_999 });

            assert.equal(answer.ok, false);
            assert.match(answer.reason, /no memory 9999/u);
        });
    });
});

describe("memory-admin injection", () => {
    it("records what went in front of the model, against a retrieval that ran", () => {
        withAdmin(({ admin, read, ids }) => {
            // The first call has no retrieval id, so it makes one; the second
            // points at that row the way a real injection points at its search.
            const failed = admin("injection", {
                sessionId: "s1",
                failure: { query: "why did the cron job stop", project: PROJECT, k: 5, reason: "timed out after 1500ms" },
            });
            const answer = admin("injection", {
                retrievalId: failed.retrievalId,
                sessionId: "s1",
                turnId: "t1",
                memoryIds: ids,
                chars: 1200,
                approxTokens: 300,
                capChars: 4000,
                capEntries: 5,
                dropped: 1,
                clippedChars: 0,
            });

            assert.equal(answer.ok, true);

            const [row] = read(`SELECT * FROM injections WHERE id = ${answer.injectionId}`);

            assert.equal(row.retrieval_id, failed.retrievalId);
            assert.equal(row.session_id, "s1");
            assert.equal(row.turn_id, "t1");
            assert.deepEqual(JSON.parse(row.memory_ids), ids);
            assert.equal(row.entries, 2);
            assert.equal(row.chars, 1200);
            assert.equal(row.approx_tokens, 300);
            assert.equal(row.cap_chars, 4000);
            assert.equal(row.cap_entries, 5);
            assert.equal(row.dropped, 1);
            assert.equal(row.clipped_chars, 0);
        });
    });

    it("writes a retrieval of its own for a search that never answered", () => {
        withAdmin(({ admin, read }) => {
            const answer = admin("injection", {
                sessionId: "s1",
                failure: { query: "why did the cron job stop", project: PROJECT, k: 5, reason: "timed out after 1500ms" },
            });

            assert.equal(answer.ok, true);
            assert.equal(Number.isInteger(answer.retrievalId), true);

            const [retrieval] = read(`SELECT * FROM retrievals WHERE id = ${answer.retrievalId}`);

            assert.equal(retrieval.origin, "prompt");
            assert.equal(retrieval.returned_n, 0);
            assert.equal(retrieval.degraded, "timed out after 1500ms");
            assert.equal(JSON.parse(retrieval.filters).failure_reason, "timed out after 1500ms");

            const [injected] = read(`SELECT entries, chars, memory_ids FROM injections WHERE id = ${answer.injectionId}`);

            assert.equal(injected.entries, 0);
            assert.equal(injected.chars, 0);
            assert.deepEqual(JSON.parse(injected.memory_ids), []);
        });
    });

    it("refuses an injection that has neither a retrieval nor a failure", () => {
        withAdmin(({ admin, read }) => {
            const answer = admin("injection", { sessionId: "s1" });

            assert.equal(answer.ok, false);
            assert.match(answer.reason, /retrieval id or a failure/u);
            assert.deepEqual(read("SELECT id FROM injections"), []);
        });
    });
});

describe("memory-admin refuses the calls it cannot make, as values", () => {
    it("names the ops it has when handed one it does not", () => {
        withAdmin(({ admin }) => {
            const answer = admin("vacuum");

            assert.equal(answer.ok, false);
            assert.match(answer.reason, /no op named vacuum/u);
        });
    });

    it("says so when stdin is not a JSON object", () => {
        withAdmin(({ dbPath }) => {
            const ran = spawnSync("bun", [ADMIN, dbPath, "list"], { input: "not json at all", encoding: "utf8" });

            assert.equal(ran.status, 0);

            const answer = JSON.parse(ran.stdout.trim().split("\n").at(-1));

            assert.equal(answer.ok, false);
            assert.match(answer.reason, /stdin is not JSON/u);
        });
    });
});
