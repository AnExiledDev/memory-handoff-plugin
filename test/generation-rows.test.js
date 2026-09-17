import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BODY_CAP, TITLE_CAP, costRow, generationRow, memoryRow, normaliseRemote, projectKey } from "../schema/generation-rows.js";

const SOURCE = { kind: "compaction", sessionId: "s", n: 0 };

const row = (extra = {}) => ({
    type: "project",
    title: "a title",
    body: "a body",
    importance: 3,
    supersedesHint: null,
    ...extra,
});

describe("projectKey", () => {
    // One repository is one project however many worktrees of it are open, so
    // both spellings of the same remote have to land on the same key.
    it("reads both remote spellings of one repository as the same key", () => {
        assert.deepEqual(projectKey("git@github.com:owner/repo.git", "/repo", "/repo"), {
            project: "github.com/owner/repo",
            projectKind: "remote",
        });
        assert.deepEqual(projectKey("https://github.com/owner/repo.git", "/repo", "/repo"), {
            project: "github.com/owner/repo",
            projectKind: "remote",
        });
    });

    it("keys a worktree on the remote, not on the directory it sits in", () => {
        const primary = projectKey("git@github.com:owner/repo.git", "/work/repo", "/work/repo");
        const worktree = projectKey("git@github.com:owner/repo.git", "/work/repo/.claude/worktrees/x", "/work/repo/.claude/worktrees/x");

        assert.equal(worktree.project, primary.project);
    });

    it("falls back to the toplevel, then the cwd, and says which it used", () => {
        assert.deepEqual(projectKey(null, "/work/repo", "/work/repo/sub"), { project: "/work/repo", projectKind: "toplevel" });
        assert.deepEqual(projectKey(null, null, "/somewhere"), { project: "/somewhere", projectKind: "cwd" });
    });

    it("answers null rather than an empty key when there is nothing to key on", () => {
        assert.deepEqual(projectKey(null, "  ", ""), { project: null, projectKind: null });
    });
});

describe("normaliseRemote", () => {
    it("lowercases the host and strips .git and trailing slashes", () => {
        assert.equal(normaliseRemote("https://GitHub.com/Owner/Repo/"), "github.com/Owner/Repo");
        assert.equal(normaliseRemote("ssh://git@github.com/owner/repo.git"), "github.com/owner/repo");
    });

    it("answers null for anything that is not a remote", () => {
        for (const input of [null, undefined, "", "   ", "/work/repo", "not a url"]) {
            assert.equal(normaliseRemote(input), null);
        }
    });
});

describe("memoryRow", () => {
    it("carries the hint into source and leaves it out when there is none", () => {
        const withHint = memoryRow({ row: row({ supersedesHint: "an older note" }), project: "p", uuid: "u", now: "N", source: SOURCE });
        const without = memoryRow({ row: row(), project: "p", uuid: "u", now: "N", source: SOURCE });

        assert.equal(JSON.parse(withHint.source).supersedesHint, "an older note");
        assert.equal("supersedesHint" in JSON.parse(without.source), false);
        assert.deepEqual([without.status, without.supersedes, without.created_at, without.updated_at], ["active", null, "N", "N"]);
    });

    // A clipped memory that looks like a short one is worse than a refused one:
    // nothing downstream can tell the fork ran out of room.
    it("clips at the schema's caps and records the length it clipped from", () => {
        const clipped = memoryRow({
            row: row({ title: "t".repeat(TITLE_CAP + 5), body: "b".repeat(BODY_CAP + 7) }),
            project: "p",
            uuid: "u",
            now: "N",
            source: SOURCE,
        });

        assert.equal(clipped.title.length, TITLE_CAP);
        assert.equal(clipped.body.length, BODY_CAP);
        assert.deepEqual(JSON.parse(clipped.source).clipped, { title: TITLE_CAP + 5, body: BODY_CAP + 7 });
    });
});

describe("generationRow", () => {
    it("flags the output cap and says which kind it was", () => {
        const written = generationRow({ at: "N", outcome: "wrote", hitCap: "truncated row", memoriesWritten: 2 }, "p", 7);

        assert.equal(written.hit_output_cap, 1);
        assert.equal(written.outcome_reason, "hit output cap: truncated row");
        assert.equal(written.cost_id, 7);
        assert.equal(written.project, "p");
    });

    it("leaves an explicit reason alone, and a finished reply unflagged", () => {
        const cold = generationRow({ at: "N", outcome: "cold", outcomeReason: "the fork answered null", hitCap: null }, "p", 1);

        assert.equal(cold.hit_output_cap, 0);
        assert.equal(cold.outcome_reason, "the fork answered null");
        assert.equal(cold.memories_written, 0);
    });
});

describe("costRow", () => {
    const usage = { input_tokens: 12, output_tokens: 800, cache_read_input_tokens: 57_000, cache_creation_input_tokens: 0 };

    it("prices a known model and waives the cache read rather than charging it", () => {
        const priced = costRow({ at: "N", model: "claude-opus-5", usage });

        assert.ok(priced.usd > 0);
        assert.ok(priced.cache_read_waived_usd > 0);
        assert.equal(priced.cost_unknown_reason, null);
        assert.equal(priced.input_tokens, 12);
        assert.equal(priced.output_tokens, 800);
    });

    // Never a silent zero: an unpriceable call and a call that cost nothing are
    // different answers, and the `costs` CHECK refuses a zero with neither.
    it("answers an unknown model with a NULL price and the reason why", () => {
        const unknown = costRow({ at: "N", model: "gpt-9", usage });

        assert.equal(unknown.usd, null);
        assert.match(unknown.cost_unknown_reason, /gpt-9/u);
        assert.equal(unknown.cost_note, null);
    });

    it("answers a pass that made no model call with a real zero and a note", () => {
        const none = costRow({ at: "N", model: null, usage: null, note: "the fork returned null" });

        assert.equal(none.usd, 0);
        assert.equal(none.basis, "no model call");
        assert.equal(none.cost_note, "the fork returned null");
    });

    it("says so out loud when a priced call worked out to nothing", () => {
        const nothing = costRow({ at: "N", model: "claude-opus-5", usage: { input_tokens: 0, output_tokens: 0 } });

        assert.equal(nothing.usd, 0);
        assert.match(nothing.cost_note, /^priced at zero/u);
    });
});
