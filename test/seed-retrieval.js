/**
 * A fixture database for working on retrieval by hand.
 *
 * ~50 memories across two projects and all four types, embedded through the
 * real runtime, plus the four probe cases the retrieval design turns on:
 *
 * - **exact-token-only** — a rare literal the query spells out, in a memory
 *   phrased nothing like the query. Only the lexical arm can find it.
 * - **paraphrase-only** — the same meaning as the query with no token in
 *   common. Only the vector arm can find it.
 * - **both-arms** — shares tokens *and* meaning, so it should come back first
 *   and carry both origins on one candidate row.
 * - **wrong-project** — the both-arms text again under the other project, which
 *   must never appear in a project-A retrieval.
 *
 * It is a script, not a test: it needs the 166 MB of weights and a daemon, and
 * `bun test` must stay runnable on a checkout that has neither.
 *
 *     bun test/seed-retrieval.js /tmp/retrieval-fixture.db
 *
 * Re-running it against an existing path is refused rather than merged, because
 * the ids in the printed verification steps would move underneath you.
 */

import { existsSync } from "node:fs";

import { openMemoryDb } from "../schema/bun-sqlite.js";
import { bunFetchText, createClient } from "../runtime/client.js";
import { ensureRuntime } from "../retrieval/ensure-runtime.js";
import { vectorToBlob } from "../retrieval/store.js";

const PROJECT_A = "host/owner/alpha";
const PROJECT_B = "host/owner/beta";

/** The query the probes are built around, printed at the end so the run is reproducible. */
const PROBE_QUERY = "how do I stop the worktree gate from failing on ORAT-4417";

const PROBES = [
    {
        project: PROJECT_A,
        type: "reference",
        title: "Ticket ORAT-4417",
        body: "ORAT-4417 is filed under the platform board. Nothing in it describes a build; it is a paperwork trail for an audit and the acceptance note is a signature.",
        importance: 2,
        note: "exact-token-only: the query's rare literal, in prose about nothing the query means",
    },
    {
        project: PROJECT_A,
        type: "project",
        title: "Parallel checkouts trip the quality barrier",
        body: "Running two isolated copies of the repository side by side makes the pre-merge barrier report a false red, because both copies share one lock directory.",
        importance: 4,
        note: "paraphrase-only: the query's meaning with none of its words",
    },
    {
        project: PROJECT_A,
        type: "feedback",
        title: "The worktree gate fails on ORAT-4417",
        body: "When the gate runs inside a worktree for ORAT-4417 it fails on a missing submodule. Initialise the submodule in the worktree before running the gate and it passes.",
        importance: 5,
        note: "both-arms: shares the query's tokens and its meaning",
    },
    {
        project: PROJECT_B,
        type: "feedback",
        title: "The worktree gate fails on ORAT-4417",
        body: "When the gate runs inside a worktree for ORAT-4417 it fails on a missing submodule. Initialise the submodule in the worktree before running the gate and it passes.",
        importance: 5,
        note: "wrong-project: the same strong match under project B, which project A must never see",
    },
];

/** Filler, deliberately about neighbouring subjects so the arms have something to disagree over. */
const SUBJECTS = [
    ["Database writes are batched", "Writes go through one transaction per tick; a write outside one is a bug and the trigger refuses it."],
    ["The cron tick is every five minutes", "A quiet tick costs one registry query. Nothing is spent until a new version lands."],
    ["Migrations never run themselves", "A merged migration stays unapplied until someone runs it, and every health signal stays green while the pages are broken."],
    ["Secrets live in one env file", "That file is never committed. The ignore rule covers it and nothing may override the rule."],
    ["The submodule pointer goes second", "Push the submodule's commit before bumping the pointer or the parent points at a commit nobody can fetch."],
    ["Logs rotate daily", "Dated logs under the state directory; catastrophic failures land in the stderr log instead."],
    ["The reranker is a ranking", "Cross-encoder scores are comparable inside one call and meaningless across calls, so nothing thresholds on them."],
    ["Read the design before the code", "Three of these subjects were reinvented twice before somebody wrote the design down."],
    ["The bot is the only announcer", "Every release announcement goes through one endpoint with a shared secret."],
    ["Static pages are retired", "The old site is a redirect now, kept for posterity; the JSON dumps it writes are the only live interface."],
    ["Backfill is sequential", "One version at a time. Parallel runs thrash the box and the results are not reproducible anyway."],
    ["Weights are not in the repository", "The model files are fetched on install; a checkout without them still runs the suite."],
    ["A sweep agent is not reproducible", "About half the output is chance on both passes. Never let one run stand as ground truth."],
    ["Prefer over-grouping", "A wrong fold is one reversible column; a missed fold is a fragmented page."],
    ["Headless sessions fork cold", "A one-shot session never exercises the replacement path, so behaviour has to be checked interactively."],
    ["The port is fixed", "The daemon listens on one loopback port and exits when idle."],
    ["Costs are recorded, not inferred", "A missing measurement is null with a reason. Zero is a claim that a call was free."],
    ["Determinism is a requirement", "Every sort is score descending, id ascending, so a tie cannot swap between runs."],
    ["Stopword prompts return nothing", "Matching everything on \"ok\" would inject five random memories into a prompt."],
    ["The window is 512 tokens", "Longer input is truncated before it reaches the embedder and the truncation is recorded."],
    ["Type is a filter, not a score", "A caller asking for one type gets one type; the others still get a trace row saying why."],
    ["Superseded memories stay", "The row is kept and the chain is followed, because the supersession is itself information."],
    ["One vocabulary per concept", "A file that calls the same thing three names costs a reader more than it saves the writer."],
];

const TYPES = ["user", "feedback", "project", "reference"];

const main = async () => {
    const path = process.argv[2];

    if (path === undefined) {
        fail("usage: bun test/seed-retrieval.js <db path>");
    }

    if (existsSync(path)) {
        fail(`${path} already exists. Seeding into it would move the ids this script prints; delete it first.`);
    }

    const client = createClient({ fetchText: bunFetchText });
    const runtime = await ensureRuntime({ client });

    if (!runtime.ready) {
        fail(`the runtime is not ready: ${runtime.reason}. The seed needs real embeddings; retrieval itself degrades without them, this does not.`);
    }

    const opened = openMemoryDb(path);
    const db = opened.db;
    const rows = buildRows();
    const ids = insertMemories(db, rows);

    await embedAll(db, client, rows, ids);
    supersedeOne(db, ids);
    report(db, path, rows, ids);

    opened.close();
};

/** @returns {{ project: string, type: string, title: string, body: string, importance: number, note?: string }[]} */
const buildRows = () => {
    const filler = SUBJECTS.flatMap(([title, body], index) => [
        { project: PROJECT_A, type: TYPES[index % TYPES.length], title, body, importance: (index % 5) + 1 },
        { project: PROJECT_B, type: TYPES[(index + 1) % TYPES.length], title: `${title} (beta)`, body, importance: (index % 5) + 1 },
    ]);

    return [...PROBES, ...filler];
};

const insertMemories = (db, rows) => {
    const insert = db.query(`
        INSERT INTO memories (uuid, project, type, title, body, importance, status, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        RETURNING id
    `);

    const at = new Date().toISOString();
    const source = JSON.stringify({ kind: "seed", script: "test/seed-retrieval.js" });

    return db.transaction(() =>
        rows.map((row, index) =>
            insert.get(`seed-${String(index).padStart(3, "0")}`, row.project, row.type, row.title, row.body, row.importance, source, at, at).id,
        ),
    )();
};

/** One `/embed` call per batch, over the same `title\n\nbody` text the retrieval side scores. */
const embedAll = async (db, client, rows, ids) => {
    const texts = rows.map((row) => `${row.title}\n\n${row.body}`);
    const insert = db.query(`
        INSERT INTO embeddings (memory_id, model, dim, dtype, normalised, vector, created_at)
        VALUES (?, ?, ?, 'f32', 1, ?, ?)
    `);

    const at = new Date().toISOString();

    for (let start = 0; start < texts.length; start += 16) {
        const batch = texts.slice(start, start + 16);
        const embedded = await client.embed(batch, { kind: "document" });

        if (!embedded.ok) {
            fail(`embedding stopped at row ${start}: ${embedded.reason}`);
        }

        db.transaction(() => {
            embedded.vectors.forEach((vector, offset) => {
                insert.run(ids[start + offset], embedded.model, embedded.dim, vectorToBlob(vector), at);
            });
        })();

        process.stdout.write(`embedded ${Math.min(start + batch.length, texts.length)}/${texts.length}\r`);
    }

    process.stdout.write("\n");
};

/**
 * One superseded memory with a live successor, so the "a superseded memory that
 * still matches strongly" edge case can be run against real data: the old row
 * must not come back and the new one must.
 */
const supersedeOne = (db, ids) => {
    const old = ids[PROBES.length];

    db.query("UPDATE memories SET status = 'superseded' WHERE id = ?").run(old);
    db.query(`
        INSERT INTO memories (uuid, project, type, title, body, importance, status, supersedes, source, created_at, updated_at)
        SELECT 'seed-successor', project, type, title || ' (revised)', body || ' The batching also covers the trigger.', importance, 'active', id, source, created_at, created_at
        FROM memories WHERE id = ?
    `).run(old);
};

const report = (db, path, rows, ids) => {
    const counts = db.query("SELECT project, count(*) AS n FROM memories GROUP BY project ORDER BY project").all();
    const embedded = db.query("SELECT count(*) AS n FROM embeddings").get().n;

    console.log(`\nseeded ${path}`);

    for (const row of counts) console.log(`  ${row.project}: ${row.n} memories`);

    console.log(`  ${embedded} embeddings (the successor row is deliberately unembedded: a memory written while the runtime was down)`);
    console.log("\nprobes:");

    PROBES.forEach((probe, index) => {
        console.log(`  memory ${ids[index]}  ${probe.note}`);
    });

    console.log(`\n  bun retrieval/search-cli.js ${path} --project ${PROJECT_A} --query ${JSON.stringify(PROBE_QUERY)} --k 5`);
    console.log(`  bun retrieval/search-cli.js ${path} --project ${PROJECT_B} --query ${JSON.stringify(PROBE_QUERY)} --k 5   # must return none of project A's`);
    console.log(`  bun retrieval/explain-cli.js ${path} <retrievalId>`);
    console.log(`  total rows: ${rows.length + 1}`);
};

const fail = (message) => {
    console.error(message);
    process.exit(1);
};

await main();
