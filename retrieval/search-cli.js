#!/usr/bin/env bun
/**
 * One retrieval against a database file, printed as JSON.
 *
 *     bun retrieval/search-cli.js <db> --project P --query "..." [--k 5]
 *         [--types user,project] [--status active] [--since ISO] [--until ISO]
 *         [--origin manual|prompt|tool] [--session-id ID] [--turn-id ID]
 *         [--runtime-timeout-ms N] [--no-runtime] [--with-id]
 *     printf '%s' "..." | bun retrieval/search-cli.js <db> --project P --query-stdin
 *
 * `--query-stdin` reads the query off stdin instead of the argv, and is what
 * every caller that did not type the query itself should use: a prompt-time
 * retrieval's query is the prompt the person typed, and an argv is readable in
 * `ps` by anyone on the machine. The whole of stdin is the query, with one
 * trailing newline removed so a `printf '%s\n'` and a heredoc mean the same
 * thing; nothing else is trimmed, because leading space can be the query.
 *
 * No Claude Code session, no hook, no plugin: this is the same `search()` the
 * prompt hook will call in #684, with a database path instead of a session.
 *
 * **The retrieval id goes to stderr, not into the JSON.** Two runs of the same
 * query against an unchanged database must be byte-identical on stdout, and the
 * id is the one thing about a retrieval that legitimately differs between them.
 * `--with-id` puts it in the document for a caller that would rather have it
 * than a clean diff.
 *
 * The runtime is started if it is not running, and retrieval degrades to
 * FTS5-only if it does not come up. `--no-runtime` skips it deliberately, which
 * is how the degradation path is exercised without stopping anything.
 */

import { openMemoryDb } from "../schema/bun-sqlite.js";
import { createClient } from "../runtime/client.js";
import { ensureRuntime } from "./ensure-runtime.js";
import { RUNTIME_TIMEOUT_MS, search } from "./search.js";

const USAGE = "usage: bun retrieval/search-cli.js <db> --project P (--query \"...\" | --query-stdin) [--k N] [--types a,b] [--status a,b] [--since ISO] [--until ISO] [--origin manual|prompt|tool] [--session-id ID] [--turn-id ID] [--runtime-timeout-ms N] [--no-runtime] [--with-id]";

/**
 * `fetch` with the same ceiling `search()` races its calls against, so a
 * runtime that never answers loses its socket as well as its turn. Without it
 * the abandoned request would sit on the client's own twenty-second timeout
 * after retrieval has already moved on.
 *
 * @param {number} timeoutMs
 */
const boundedFetchText = (timeoutMs) => async (url, init = {}) => {
    const response = await fetch(url, {
        method: init.method ?? "GET",
        headers: init.headers,
        body: init.body,
        signal: AbortSignal.timeout(timeoutMs),
    });

    return { status: response.status, ok: response.ok, text: await response.text() };
};

const main = async () => {
    const argv = process.argv.slice(2);
    const dbPath = argv[0];

    if (dbPath === undefined || dbPath.startsWith("-")) {
        return fail(USAGE);
    }

    const flags = parseFlags(argv.slice(1));

    if (flags.project === undefined) {
        return fail(USAGE);
    }

    const query = await queryOf(flags);

    if (query === null) {
        return fail(USAGE);
    }

    if (query.trim() === "") {
        return fail("the query is empty");
    }

    const timeoutMs = flags["runtime-timeout-ms"] === undefined ? RUNTIME_TIMEOUT_MS : Number.parseInt(flags["runtime-timeout-ms"], 10);
    const opened = openMemoryDb(dbPath);
    const client = flags["no-runtime"] === true ? null : createClient({ fetchText: boundedFetchText(timeoutMs) });

    try {
        const answer = await search(
            {
                query,
                project: flags.project,
                types: listOf(flags.types),
                status: listOf(flags.status),
                since: flags.since ?? null,
                until: flags.until ?? null,
                k: flags.k === undefined ? undefined : Number.parseInt(flags.k, 10),
                origin: /** @type {any} */ (flags.origin ?? "manual"),
                // Stamped on the `retrievals` row so a trace can be read back
                // beside the session and the turn it was run for; the prompt
                // hook has both and nothing else could supply them later.
                sessionId: idOf(flags["session-id"]),
                turnId: idOf(flags["turn-id"]),
                runtimeTimeoutMs: timeoutMs,
            },
            {
                db: opened.db,
                client,
                ensureRuntime: client === null ? undefined : () => ensureRuntime({ client, stampPath: `${dbPath}.autostart` }),
            },
        );

        if (!answer.ok) {
            return fail(answer.reason);
        }

        process.stderr.write(`retrieval ${answer.retrievalId}\n`);
        process.stdout.write(`${JSON.stringify(document(answer, flags), null, 2)}\n`);

        return 0;
    } finally {
        opened.close();
    }
};

/**
 * The query, off stdin when the caller asked for that and off the argv otherwise.
 *
 * One trailing newline is removed and nothing else, so the text a shell pipe
 * carries and the text a hook writes to the child are the same query.
 */
const queryOf = async (flags) => {
    if (flags["query-stdin"] === undefined) {
        return typeof flags.query === "string" ? flags.query : null;
    }

    const text = await new Response(Bun.stdin.stream()).text();

    return text.endsWith("\n") ? text.slice(0, -1) : text;
};

/** What stdout carries: the answer, and nothing that changes between two identical runs. */
const document = (answer, flags) => ({
    ...(flags["with-id"] === true ? { retrievalId: answer.retrievalId } : {}),
    degraded: answer.degraded,
    matchExpression: answer.matchExpression,
    results: answer.results.map((result, index) => ({ rank: index + 1, ...result })),
});

/** `--flag value` and `--flag` (true). A value that begins with `--` is the next flag, not this one's argument. */
/** The flags that take no value, so a bare token after one is never swallowed as its value. */
const SWITCHES = new Set(["query-stdin", "no-runtime", "with-id"]);

const parseFlags = (argv) => {
    /** @type {Record<string, any>} */
    const flags = {};

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];

        if (!token.startsWith("--")) continue;

        const name = token.slice(2);
        const next = argv[index + 1];

        if (SWITCHES.has(name) || next === undefined || next.startsWith("--")) {
            flags[name] = true;
            continue;
        }

        flags[name] = next;
        index += 1;
    }

    return flags;
};

/** A flag given without a value is `true`, and `true` is not an id. */
const idOf = (raw) => (typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null);

const listOf = (raw) =>
    typeof raw === "string" ? raw.split(",").map((part) => part.trim()).filter((part) => part !== "") : undefined;

/** @param {string} reason @returns {number} */
const fail = (reason) => {
    process.stderr.write(`${reason}\n`);

    return 1;
};

process.exit(await main());
