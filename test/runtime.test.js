import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { bunFetchText, createClient } from "../runtime/client.js";
import { createRuntime, defaultModelsDir, missingWeights } from "../runtime/infer.js";
import { serve } from "../runtime/serve.js";

const HERE = join(fileURLToPath(import.meta.url), "..");

/** A port of its own, so a suite run never fights a daemon somebody left up. */
const PORT = 8796;

/**
 * The weights are 166 MB and are not in this repository, so a checkout that has
 * never run `bun runtime/install.js` cannot run half of these. That half skips
 * with the reason rather than failing, because a green suite on a machine with
 * no weights is the point of the install step being a separate act.
 */
const MISSING = missingWeights(defaultModelsDir(), "fp32", "q8");
const withWeights = MISSING.length === 0 ? it : it.skip;

if (MISSING.length > 0) {
    console.warn(`memory-handoff: skipping the inference tests, ${MISSING.length} weight files are missing. Run: bun runtime/install.js`);
}

/** One embedding from a process of its own. @param {string} text @param {"query" | "document"} kind */
const embedInChild = (text, kind) => {
    const stdout = execFileSync(process.execPath, [join(HERE, "embed-once.js"), text, kind], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
    });

    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
};

/** @param {number[]} left @param {number[]} right @returns {number} */
const cosine = (left, right) => left.reduce((total, value, index) => total + value * right[index], 0);

describe("health answers before anything is loaded", () => {
    it("says the weights are missing when the models directory is empty", () => {
        const dir = mkdtempSync(join(tmpdir(), "memory-handoff-noweights-"));

        try {
            const health = createRuntime({ modelsDir: dir }).health();

            assert.equal(health.ready, false);
            assert.match(String(health.reason), /weights missing/u);
            assert.equal(health.weights_bytes, 0);
            assert.equal(health.models.length, 2);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("names the models it would load, so a caller can record which vector space it got", () => {
        const dir = mkdtempSync(join(tmpdir(), "memory-handoff-noweights-"));

        try {
            const health = createRuntime({ modelsDir: dir }).health();

            assert.match(health.models[0], /^BAAI\/bge-small-en-v1\.5@[0-9a-f]{12}\/fp32$/u);
            assert.match(health.models[1], /^jinaai\/jina-reranker-v1-tiny-en@[0-9a-f]{12}\/q8$/u);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("a client with nothing to talk to degrades", () => {
    it("answers ready:false with a reason instead of throwing", async () => {
        // Nothing is listening on this port; that is the whole test.
        const client = createClient({ fetchText: bunFetchText, port: 8797 });
        const health = await client.health();

        assert.equal(health.ready, false);
        assert.match(String(health.reason), /unreachable/u);
    });

    it("answers embed and rerank as values, so retrieval falls back to FTS5", async () => {
        const client = createClient({ fetchText: bunFetchText, port: 8797 });
        const embedded = await client.embed(["anything"], { kind: "query" });
        const ranked = await client.rerank("anything", ["a", "b"]);

        assert.equal(embedded.ok, false);
        assert.equal(ranked.ok, false);
        assert.equal(typeof (embedded.ok === false ? embedded.reason : ""), "string");
    });

    it("carries a 503 from a daemon that has no weights through as a reason", async () => {
        const dir = mkdtempSync(join(tmpdir(), "memory-handoff-noweights-"));
        const daemon = serve({ port: PORT + 2, idleMs: 5000, modelsDir: dir });
        const client = createClient({ fetchText: bunFetchText, port: PORT + 2 });

        try {
            const health = await client.health();
            const embedded = await client.embed(["anything"], { kind: "query" });

            assert.equal(health.ready, false);
            assert.match(String(health.reason), /weights missing/u);
            assert.equal(embedded.ok, false);
        } finally {
            daemon.stop();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("the query and document sides of bge are not the same call", () => {
    withWeights("embeds the same text differently as a query and as a document", async () => {
        const runtime = createRuntime();
        const asDocument = await runtime.embed(["the monitor tick pulls the checkout"], { kind: "document" });
        const asQuery = await runtime.embed(["the monitor tick pulls the checkout"], { kind: "query" });

        assert.equal(asDocument.ok, true);
        assert.equal(asQuery.ok, true);

        if (asDocument.ok && asQuery.ok) {
            assert.notDeepEqual(asQuery.vectors[0], asDocument.vectors[0]);
            assert.equal(asQuery.dim, 384);
        }
    });

    withWeights("refuses a kind it does not know rather than guessing one", async () => {
        const result = await createRuntime().embed(["text"], { kind: /** @type {any} */ ("passage") });

        assert.equal(result.ok, false);
    });
});

describe("the vectors mean something, not just the right shape", () => {
    withWeights("puts a paraphrase materially nearer than an unrelated sentence", async () => {
        const result = await createRuntime().embed(
            ["the cat sat on the mat", "a feline rested on a rug", "sqlite journal mode WAL"],
            { kind: "document" },
        );

        assert.equal(result.ok, true);

        if (result.ok) {
            const [cat, feline, wal] = result.vectors;

            assert.ok(cosine(cat, feline) > cosine(cat, wal) + 0.2, "paraphrase is nearer than an unrelated sentence");
        }
    });

    withWeights("ranks the obvious answer first among five documents", async () => {
        const docs = [
            "The cat sat on the mat.",
            "A recipe for lasagne, with three cheeses.",
            "PRAGMA journal_mode = WAL turns on write-ahead logging in SQLite.",
            "Git worktrees share one stash stack with the primary checkout.",
            "The monitor tick runs every five minutes from cron.",
        ];
        const ranked = await createRuntime().rerank("how do I turn on WAL mode in sqlite?", docs);

        assert.equal(ranked.ok, true);

        if (ranked.ok) {
            assert.equal(ranked.scores.length, docs.length);
            assert.equal(ranked.scores.indexOf(Math.max(...ranked.scores)), 2);
        }
    });
});

describe("a stored vector and a re-embedded one are comparable", () => {
    withWeights("gives byte-identical vectors from two separate processes", () => {
        const first = embedInChild("the monitor tick pulls the checkout every five minutes", "document");
        const second = embedInChild("the monitor tick pulls the checkout every five minutes", "document");

        assert.equal(first.vector.length, 384);
        assert.deepEqual(first.vector, second.vector);
        assert.equal(first.model, second.model);
    });

    withWeights("does not let the rest of the batch change a vector", async () => {
        const runtime = createRuntime();
        const alone = await runtime.embed(["the monitor tick pulls the checkout"], { kind: "document" });
        const batched = await runtime.embed(
            ["the monitor tick pulls the checkout", "a much longer sentence that pads the batch out considerably"],
            { kind: "document" },
        );

        assert.equal(alone.ok, true);
        assert.equal(batched.ok, true);

        if (alone.ok && batched.ok) {
            assert.deepEqual(batched.vectors[0], alone.vectors[0]);
        }
    });
});

describe("truncation is reported rather than silent", () => {
    withWeights("flags a text past the 512-token window and leaves a short one alone", async () => {
        const result = await createRuntime().embed(["word ".repeat(900), "short"], { kind: "document" });

        assert.equal(result.ok, true);

        if (result.ok) {
            assert.deepEqual(result.truncated, [true, false]);
        }
    });

    withWeights("flags a reranked pair that filled the window", async () => {
        const ranked = await createRuntime().rerank("a query", ["word ".repeat(900), "short"]);

        assert.equal(ranked.ok, true);

        if (ranked.ok) {
            assert.equal(ranked.truncated[0], true);
        }
    });
});

describe("the daemon serves the same answers over loopback", () => {
    withWeights("embeds, reranks and reports health through the client", async () => {
        const daemon = serve({ port: PORT, idleMs: 30_000 });
        const client = createClient({ fetchText: bunFetchText, port: PORT });

        try {
            const embedded = await client.embed(["the monitor tick pulls the checkout"], { kind: "query" });
            const ranked = await client.rerank("a query", ["one document", "another document"]);
            const health = await client.health();

            assert.equal(embedded.ok, true);
            assert.equal(ranked.ok, true);
            assert.equal(health.ready, true);
            assert.ok(health.rss_bytes > 0);

            if (embedded.ok) {
                assert.equal(embedded.vectors[0].length, 384);
                assert.equal(typeof embedded.ms, "number");
            }
        } finally {
            daemon.stop();
        }
    });

    withWeights("listens on loopback and nowhere else", () => {
        const daemon = serve({ port: PORT + 1, idleMs: 5000 });

        try {
            assert.equal(daemon.server.hostname, "127.0.0.1");
        } finally {
            daemon.stop();
        }
    });
});
