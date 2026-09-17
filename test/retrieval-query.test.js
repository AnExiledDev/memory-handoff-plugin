import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Database } from "bun:sqlite";

import { buildMatch, MAX_MATCH_TOKENS, MAX_QUERY_CHARS, MAX_RERANK_QUERY_CHARS, quoteToken, truncateForEmbedding, truncateForRerank } from "../retrieval/query.js";

/** A throwaway FTS5 table, so "this expression is valid" is a fact and not a hope. */
const withFts = (run) => {
    const db = new Database(":memory:");

    db.exec("CREATE VIRTUAL TABLE t USING fts5(title, body, tokenize='porter unicode61')");
    db.query("INSERT INTO t (title, body) VALUES (?, ?)").run("WAL mode", "PRAGMA journal_mode = WAL turns on write-ahead logging");

    try {
        return run(db);
    } finally {
        db.close();
    }
};

const matches = (db, expression) => db.query("SELECT rowid FROM t WHERE t MATCH ?").all(expression).length;

describe("the MATCH expression is built, never interpolated", () => {
    it("quotes every token and ORs them", () => {
        assert.equal(buildMatch("journal mode WAL").expression, '"journal" OR "mode" OR "wal"');
    });

    // The first thing to break: a prompt with a quote in it. Left raw, this is
    // an FTS5 syntax error and the whole lexical arm throws.
    it("survives a prompt full of FTS5 operators", () => {
        const built = buildMatch('why does "wal" NEAR(mode) AND -journal* ( break?');

        assert.deepEqual(built.tokens, ["wal", "near", "mode", "journal", "break"]);
        assert.match(built.expression, /^"wal" OR "near"/u);
        assert.ok(!built.expression.includes("("), "no parenthesis reaches the expression");
    });

    it("produces something SQLite will actually run", () => {
        withFts((db) => {
            for (const prompt of ['how do I turn on "WAL" mode?', "NEAR AND OR NOT *", "journal_mode = WAL;", "café — naïve"]) {
                const built = buildMatch(prompt);

                if (built.empty) continue;

                assert.doesNotThrow(() => matches(db, built.expression), `FTS5 refused ${built.expression}`);
            }

            assert.equal(matches(db, buildMatch("journal mode").expression), 1);
        });
    });

    it("escapes a quote inside a token rather than ending the string", () => {
        assert.equal(quoteToken('wa"l'), '"wa""l"');
    });
});

describe("a query with nothing searchable in it", () => {
    // A large share of real prompts. Matching everything would inject five
    // random memories on "ok"; raising would break the prompt.
    it("is empty for a stopword-only prompt, with the reason", () => {
        const built = buildMatch("ok now do the same for it");

        assert.equal(built.empty, true);
        assert.equal(built.expression, "");
        assert.match(String(built.emptyReason), /stopword/u);
    });

    it("is empty for an empty prompt and for punctuation", () => {
        assert.equal(buildMatch("").empty, true);
        assert.equal(buildMatch("   ").empty, true);
        assert.equal(buildMatch("!!! ??? ...").empty, true);
        assert.match(String(buildMatch("!!!").emptyReason), /letters or digits/u);
    });

    it("drops one-character tokens rather than searching on them", () => {
        const built = buildMatch("y");

        assert.equal(built.empty, true);
        assert.equal(built.dropped.short, 1);
    });
});

describe("a pasted stack trace", () => {
    const trace = Array.from({ length: 400 }, (_unused, index) => `at frame${index} (/srv/app/file${index}.js:${index}:12)`).join("\n");

    it("is cut to a fixed number of tokens, deterministically, and says so", () => {
        const built = buildMatch(trace);

        assert.equal(built.tokens.length, MAX_MATCH_TOKENS);
        assert.ok(built.dropped.overCap > 0);
        assert.deepEqual(buildMatch(trace).tokens, built.tokens);
    });

    it("is cut to a fixed number of characters before it reaches the embedder", () => {
        const cut = truncateForEmbedding(trace);

        assert.ok(trace.length > MAX_QUERY_CHARS);
        assert.equal(cut.truncated, true);
        assert.equal(cut.text.length, MAX_QUERY_CHARS);
        assert.equal(cut.chars, trace.length);
        assert.equal(truncateForEmbedding(trace).text, cut.text);
    });

    it("leaves a short query alone and reports no truncation", () => {
        const cut = truncateForEmbedding("how do I turn on WAL mode");

        assert.equal(cut.truncated, false);
        assert.equal(cut.text, "how do I turn on WAL mode");
    });

    // #711. The reranker pays per character on every candidate and shares one
    // 512-token sequence with the memory, so its window is the narrower one.
    it("is cut harder before it reaches the reranker", () => {
        const cut = truncateForRerank(trace);

        assert.ok(MAX_RERANK_QUERY_CHARS < MAX_QUERY_CHARS);
        assert.equal(cut.truncated, true);
        assert.equal(cut.text.length, MAX_RERANK_QUERY_CHARS);
        assert.equal(cut.chars, trace.length);
        assert.equal(cut.text, truncateForEmbedding(trace).text.slice(0, MAX_RERANK_QUERY_CHARS));
    });

    it("leaves a query inside the rerank window alone", () => {
        const cut = truncateForRerank("how do I turn on WAL mode");

        assert.equal(cut.truncated, false);
        assert.equal(cut.text, "how do I turn on WAL mode");
    });
});

describe("tokens are deduped and ordered", () => {
    it("keeps the first occurrence and drops the repeats", () => {
        assert.deepEqual(buildMatch("wal wal mode WAL").tokens, ["wal", "mode"]);
    });
});
