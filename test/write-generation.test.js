import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Database } from "bun:sqlite";

const HERE = join(fileURLToPath(import.meta.url), "..");
const WRITER = join(HERE, "..", "schema", "write-generation.js");

const USAGE = { input_tokens: 12, output_tokens: 800, cache_read_input_tokens: 57_000, cache_creation_input_tokens: 0 };

const MEMORIES = [
    {
        type: "project",
        title: "the staging psql needs a TLS mode set",
        body: "connections hang forever without it, and nothing says why",
        importance: 4,
        supersedesHint: null,
    },
    {
        type: "feedback",
        title: "one fix per pull request",
        body: "the operator asked for it after a bundled branch was hard to revert",
        importance: 3,
        supersedesHint: "an older note about batching fixes",
    },
];

/** Runs the writer over a document, in a temp directory that is always removed. */
const withWriter = (run) => {
    const dir = mkdtempSync(join(tmpdir(), "memory-handoff-writer-"));
    const dbPath = join(dir, "memory.sqlite");
    const write = (doc) => {
        const ran = spawnSync("bun", [WRITER], { input: JSON.stringify({ dbPath, ...doc }), encoding: "utf8" });

        assert.equal(ran.status, 0, `the writer exited ${ran.status}: ${ran.stderr}`);

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

    try {
        return run({ write, read, dbPath });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

const document = (extra = {}) => ({
    remoteUrl: "git@github.com:owner/repo.git",
    cwd: "/work/repo",
    source: { sessionId: "s1", n: 0, via: "hook" },
    model: "claude-opus-5",
    usage: USAGE,
    rows: MEMORIES,
    generation: {
        at: "2026-09-16T12:00:00Z",
        sessionId: "s1",
        compactionN: 0,
        trigger: "manual",
        messagesIn: 42,
        outcome: "wrote",
        parsedRows: 2,
        rejectedRows: 1,
        elapsedMs: 2100,
        plugin: "0.2.0",
        engine: "2.1.273",
    },
    ...extra,
});

describe("write-generation", () => {
    it("writes the memories, the generation and the cost in one pass", () => {
        withWriter(({ write, read }) => {
            const answer = write(document());

            assert.equal(answer.ok, true);
            assert.equal(answer.memoriesWritten, 2);
            assert.equal(answer.project, "github.com/owner/repo");
            assert.equal(answer.projectKind, "remote");
            assert.equal(answer.ids.length, 2);

            const memories = read("SELECT * FROM memories ORDER BY id");

            assert.deepEqual(memories.map((row) => row.type), ["project", "feedback"]);
            assert.deepEqual(memories.map((row) => row.project), ["github.com/owner/repo", "github.com/owner/repo"]);
            assert.deepEqual(memories.map((row) => row.generation_id), [answer.generationId, answer.generationId]);
            assert.equal(JSON.parse(memories[1].source).supersedesHint, "an older note about batching fixes");
            assert.equal(JSON.parse(memories[0].source).via, "hook");

            const [generation] = read("SELECT * FROM generations");

            assert.equal(generation.outcome, "wrote");
            assert.equal(generation.memories_written, 2);
            assert.equal(generation.parsed_rows, 2);
            assert.equal(generation.rejected_rows, 1);
            assert.equal(generation.hit_output_cap, 0);
            assert.equal(generation.project, "github.com/owner/repo");
            assert.equal(generation.cost_id, answer.costId);

            const [cost] = read("SELECT * FROM costs");

            assert.ok(cost.usd > 0);
            assert.equal(cost.model, "claude-opus-5");
            assert.equal(cost.output_tokens, 800);
            assert.equal(cost.cost_unknown_reason, null);
        });
    });

    // A pass that found nothing is a real result and has to be recorded as one,
    // or the only evidence left is a generation that never happened.
    it("records a zero-memory pass as a generation that wrote nothing", () => {
        withWriter(({ write, read }) => {
            const answer = write(document({ rows: [], generation: { outcome: "wrote", parsedRows: 0, rejectedRows: 0 } }));

            assert.equal(answer.memoriesWritten, 0);
            assert.equal(read("SELECT * FROM memories").length, 0);

            const [generation] = read("SELECT outcome, memories_written FROM generations");

            assert.equal(generation.outcome, "wrote");
            assert.equal(generation.memories_written, 0);
        });
    });

    it("prices an unknown model as unknown rather than as free", () => {
        withWriter(({ write, read }) => {
            write(document({ model: "gpt-9", rows: [] }));

            const [cost] = read("SELECT usd, cost_unknown_reason, cost_note FROM costs");

            assert.equal(cost.usd, null);
            assert.match(cost.cost_unknown_reason, /gpt-9/u);
            assert.equal(cost.cost_note, null);
        });
    });

    it("records a pass that made no model call with a zero that says so", () => {
        withWriter(({ write, read }) => {
            write(
                document({
                    rows: [],
                    model: null,
                    usage: null,
                    costNote: "the fork returned null",
                    generation: { outcome: "cold", outcomeReason: "the fork returned null" },
                }),
            );

            const [cost] = read("SELECT usd, basis, cost_note FROM costs");

            assert.equal(cost.usd, 0);
            assert.equal(cost.basis, "no model call");
            assert.equal(cost.cost_note, "the fork returned null");
        });
    });

    it("carries the output cap onto the generation row", () => {
        withWriter(({ write, read }) => {
            write(document({ rows: [], generation: { outcome: "wrote", hitCap: "truncated row" } }));

            const [generation] = read("SELECT hit_output_cap, outcome_reason FROM generations");

            assert.equal(generation.hit_output_cap, 1);
            assert.equal(generation.outcome_reason, "hit output cap: truncated row");
        });
    });

    it("leaves the memories searchable through the index the schema keeps", () => {
        withWriter(({ write, read }) => {
            write(document());

            const hits = read("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'hang'");

            assert.equal(hits.length, 1);
        });
    });

    // The hook calling this is a compaction hook: a bad document is a recorded
    // failure, never a non-zero exit that reads as the plugin breaking.
    it("answers a failure as a value, with the exit status still zero", () => {
        const ran = spawnSync("bun", [WRITER], { input: "not json at all", encoding: "utf8" });

        assert.equal(ran.status, 0);

        const answer = JSON.parse(ran.stdout.trim().split("\n").at(-1));

        assert.equal(answer.ok, false);
        assert.match(answer.reason, /stdin is not JSON/u);
    });

    it("refuses a document it cannot key to a project rather than inventing one", () => {
        withWriter(({ write, dbPath }) => {
            const answer = write(document({ remoteUrl: null, toplevel: null, cwd: null, rows: [] }));

            assert.equal(answer.ok, false);
            assert.match(answer.reason, /no project key/u);
            // It refuses before it opens anything, so there is no database.
            assert.equal(existsSync(dbPath), false);
        });
    });

    it("leaves the immutability trigger in force over what it wrote", () => {
        withWriter(({ write, dbPath }) => {
            write(document());

            const db = new Database(dbPath);

            try {
                assert.throws(() => db.query("UPDATE memories SET body = 'rewritten' WHERE id = 1").run(), /immutable/iu);
            } finally {
                db.close();
            }
        });
    });
});
