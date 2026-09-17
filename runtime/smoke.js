/**
 * The documented end-to-end run: `bun runtime/smoke.js`.
 *
 * It starts the daemon, drives `embed`, `rerank` and `health` through the same
 * client the plugin will use, and asserts what the vectors mean rather than
 * what shape they are: a runtime returning well-formed noise passes every shape
 * check ever written. Then it stops the daemon and checks that a client talking
 * to a dead port degrades instead of throwing.
 *
 * No Claude Code, no hook, nothing but bun. Anything that fails exits non-zero.
 */

import { bunFetchText, createClient } from "./client.js";
import { defaultModelsDir, missingWeights } from "./infer.js";
import { serve } from "./serve.js";

const PORT = Number.parseInt(process.env.MEMORY_HANDOFF_RUNTIME_PORT ?? "8795", 10);

const missing = missingWeights(defaultModelsDir(), "fp32", "q8");

if (missing.length > 0) {
    console.error(`memory-handoff: ${missing.length} weight files are missing. Run: bun runtime/install.js`);
    process.exit(2);
}

const daemon = serve({ port: PORT, idleMs: 120_000 });
const client = createClient({ fetchText: bunFetchText, port: PORT });

try {
    await run();
    console.log("\nruntime smoke: every check passed");
} finally {
    daemon.stop();
}

async function run() {
    const cold = await client.health();

    console.log(`health before the first call: ready=${cold.ready} ${cold.reason ?? ""}`);

    const documents = await client.embed(
        ["the cat sat on the mat", "a feline rested on a rug", "sqlite journal mode WAL"],
        { kind: "document" },
    );

    assert(documents.ok, "embed answered");
    assert(documents.vectors.length === 3 && documents.dim === 384, "three 384-wide vectors");
    assert(documents.truncated.every((flag) => flag === false), "nothing short was reported truncated");

    const [cat, feline, wal] = documents.vectors;
    const paraphrase = cosine(cat, feline);
    const unrelated = cosine(cat, wal);

    console.log(`cosine(paraphrase)=${paraphrase.toFixed(4)}  cosine(unrelated)=${unrelated.toFixed(4)}`);
    assert(paraphrase > unrelated + 0.2, "a paraphrase is materially nearer than an unrelated sentence");

    const asQuery = await client.embed(["the cat sat on the mat"], { kind: "query" });

    assert(asQuery.ok, "query-side embed answered");
    assert(
        JSON.stringify(asQuery.vectors[0]) !== JSON.stringify(cat),
        "the same text embeds differently as a query and as a document",
    );

    const again = await client.embed(["the cat sat on the mat"], { kind: "document" });

    assert(again.ok && JSON.stringify(again.vectors[0]) === JSON.stringify(cat), "two calls give byte-identical vectors");

    const long = await client.embed(["word ".repeat(900)], { kind: "document" });

    assert(long.ok && long.truncated[0] === true, "a text past the 512-token window is reported truncated");

    const docs = [
        "The cat sat on the mat.",
        "A recipe for lasagne, with three cheeses.",
        "PRAGMA journal_mode = WAL turns on write-ahead logging in SQLite.",
        "Git worktrees share one stash stack with the primary checkout.",
        "The monitor tick runs every five minutes from cron.",
    ];
    const ranked = await client.rerank("how do I turn on WAL mode in sqlite?", docs);

    assert(ranked.ok, "rerank answered");
    assert(ranked.scores.length === docs.length, "one score per document");

    const best = ranked.scores.indexOf(Math.max(...ranked.scores));

    console.log(`rerank put document ${best} first: ${docs[best]}`);
    assert(best === 2, "the obvious answer ranks first among five");

    const ready = await client.health();

    assert(ready.ready === true, "health reports ready once both models are loaded");
    console.log(`RSS with both models resident: ${(ready.rss_bytes / 1048576).toFixed(1)} MB`);

    daemon.stop();

    const stopped = await client.health();

    assert(stopped.ready === false && typeof stopped.reason === "string", "a stopped daemon answers ready:false with a reason");

    const degraded = await client.embed(["anything"], { kind: "query" });

    assert(degraded.ok === false && typeof degraded.reason === "string", "embed against a stopped daemon is a value, not a throw");
    console.log(`with the daemon stopped: ${stopped.reason}`);
}

/** @param {number[]} left @param {number[]} right @returns {number} */
function cosine(left, right) {
    return left.reduce((total, value, index) => total + value * right[index], 0);
}

/** @param {unknown} condition @param {string} what @returns {asserts condition} */
function assert(condition, what) {
    if (!condition) {
        console.error(`FAILED: ${what}`);
        process.exit(1);
    }

    console.log(`ok  ${what}`);
}
