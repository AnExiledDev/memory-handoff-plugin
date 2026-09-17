#!/usr/bin/env bun
/**
 * One retrieval's whole trace, from the database alone.
 *
 *     bun retrieval/explain-cli.js <db> <retrievalId> [--json]
 *
 * Nothing here runs a query, embeds anything or calls a model: it reads the
 * `retrievals` row and its `retrieval_candidates` and prints them. That is the
 * point — the answer must be about the retrieval that happened, not about what
 * would happen if it ran again.
 */

import { openMemoryDb } from "../schema/bun-sqlite.js";
import { explain } from "./explain.js";

const USAGE = "usage: bun retrieval/explain-cli.js <db> <retrievalId> [--json]";

const main = () => {
    const [dbPath, rawId, ...rest] = process.argv.slice(2);
    const retrievalId = Number.parseInt(rawId ?? "", 10);

    if (dbPath === undefined || !Number.isInteger(retrievalId)) {
        process.stderr.write(`${USAGE}\n`);

        return 1;
    }

    const opened = openMemoryDb(dbPath);

    try {
        const answer = explain(opened.db, retrievalId);

        if (!answer.ok) {
            process.stderr.write(`${answer.reason}\n`);

            return 1;
        }

        const text = rest.includes("--json")
            ? JSON.stringify({ retrieval: answer.retrieval, candidates: answer.candidates }, null, 2)
            : answer.text;

        process.stdout.write(`${text}\n`);

        return 0;
    } finally {
        opened.close();
    }
};

process.exit(main());
