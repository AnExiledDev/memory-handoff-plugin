import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openMemoryDb } from "../schema/bun-sqlite.js";
import { embedMissing } from "../retrieval/embed-missing.js";

/** An `/embed` that answers a unit vector per text and remembers what it was asked. */
const fakeClient = (model = "bge-small-fp32") => {
    const asked = [];

    return {
        asked,
        embed: async (texts) => {
            asked.push(texts);

            return { ok: true, model, dim: 3, vectors: texts.map((_, i) => [1, 0, 0].map((x, j) => (j === i % 3 ? 1 : 0))) };
        },
    };
};

const withDb = async (run) => {
    const dir = mkdtempSync(join(tmpdir(), "memory-handoff-embed-"));
    const opened = openMemoryDb(join(dir, "memory.sqlite"));

    try {
        return await run(opened.db);
    } finally {
        opened.close();
        rmSync(dir, { recursive: true, force: true });
    }
};

const insertMemory = (db, id, status = "active") =>
    db.query(
        `INSERT INTO memories (id, uuid, project, type, title, body, importance, status, source, created_at, updated_at)
         VALUES (?, ?, 'p', 'project', ?, 'body', 3, ?, '{}', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z')`,
    ).run(id, `u${id}`, `memory ${id}`, status);

describe("embed-missing writes the vectors a compaction left out", () => {
    it("embeds every active memory without a vector, in batches, and none twice", async () => {
        await withDb(async (db) => {
            for (let id = 1; id <= 5; id += 1) insertMemory(db, id);
            insertMemory(db, 6, "superseded");

            const client = fakeClient();
            const first = await embedMissing(db, client, { batch: 2 });

            assert.deepEqual(first, { ok: true, model: "bge-small-fp32", embedded: 5 });
            assert.deepEqual(client.asked.map((texts) => texts.length), [2, 2, 1]);
            assert.equal(client.asked[0][0], "memory 1\n\nbody", "the same title/body text the retrieval side scores");
            assert.equal(db.query("SELECT count(*) AS n FROM embeddings").get().n, 5, "the superseded row is left alone");

            const second = await embedMissing(db, client, { batch: 2 });

            assert.deepEqual(second, { ok: true, model: null, embedded: 0 });
            assert.equal(client.asked.length, 3, "a second run asks the runtime for nothing");
        });
    });

    it("embeds for a new model what an old model already covered", async () => {
        await withDb(async (db) => {
            insertMemory(db, 1);
            insertMemory(db, 2);
            db.query(
                `INSERT INTO embeddings (memory_id, model, dim, dtype, normalised, vector, created_at)
                 VALUES (1, 'old-model', 3, 'f32', 1, X'000000000000000000000000', '2026-09-17T00:00:00Z')`,
            ).run();

            const result = await embedMissing(db, fakeClient("new-model"), { batch: 16 });

            assert.deepEqual(result, { ok: true, model: "new-model", embedded: 2 });
            assert.equal(db.query("SELECT count(*) AS n FROM embeddings WHERE model = 'new-model'").get().n, 2);
        });
    });

    it("stops at the first refused batch and keeps what it had written", async () => {
        await withDb(async (db) => {
            insertMemory(db, 1);
            insertMemory(db, 2);

            let calls = 0;
            const client = {
                embed: async (texts) => {
                    calls += 1;

                    return calls === 1
                        ? { ok: true, model: "m", dim: 3, vectors: texts.map(() => [1, 0, 0]) }
                        : { ok: false, reason: "the runtime went away" };
                },
            };
            const result = await embedMissing(db, client, { batch: 1 });

            assert.deepEqual(result, { ok: false, model: "m", embedded: 1, reason: "the runtime went away" });
            assert.equal(db.query("SELECT count(*) AS n FROM embeddings").get().n, 1);
        });
    });
});
