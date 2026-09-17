import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { GENERATION_PROMPT, GENERATION_PROMPT_ARM, MAX_BODY_CHARS, MAX_MEMORIES, MAX_TITLE_CHARS } from "../hooks/prompt.js";

const HERE = join(fileURLToPath(import.meta.url), "..");

describe("GENERATION_PROMPT", () => {
    // The bench grades a file and the hook forks a constant. If the two can
    // drift, every number the README quotes is about a prompt that never ran.
    it("is byte for byte the arm the bench measured", () => {
        const arm = join(HERE, "..", "bench", "prompts", `${GENERATION_PROMPT_ARM}.txt`);

        assert.equal(GENERATION_PROMPT, readFileSync(arm, "utf8"));
    });

    it("says which arm it is, so the README's numbers are about this text", () => {
        assert.match(GENERATION_PROMPT_ARM, /^v[0-9]+$/u);
    });

    it("states the budget the parser and the schema enforce", () => {
        assert.match(GENERATION_PROMPT, new RegExp(`At most ${MAX_MEMORIES} memories`, "u"));
        assert.match(GENERATION_PROMPT, new RegExp(`at most ${MAX_TITLE_CHARS} characters`, "u"));
        assert.match(GENERATION_PROMPT, new RegExp(`at most ${MAX_BODY_CHARS} characters`, "u"));
    });

    it("asks for the block the parser reads, and says an empty one is an answer", () => {
        assert.match(GENERATION_PROMPT, /<memories>/u);
        assert.match(GENERATION_PROMPT, /<\/memories>/u);
        assert.match(GENERATION_PROMPT, /One JSON object per line, no array/u);
        assert.match(GENERATION_PROMPT, /Leave the block empty if nothing qualifies\./u);
    });

    it("names all four types, each in its own paragraph, so a type can come back empty", () => {
        for (const type of ["user", "feedback", "project", "reference"]) {
            assert.match(GENERATION_PROMPT, new RegExp("^`" + type + "` - ", "mu"));
        }

        assert.match(GENERATION_PROMPT, /let a type be empty/u);
    });

    // v1 leaked the fixture's roadmap decoy on both replicates, and this line
    // is the whole difference between v1 and the shipped v2.
    it("names a plan for a future quarter as a thing never to write", () => {
        assert.match(GENERATION_PROMPT, /a plan for a future quarter/u);
        assert.match(GENERATION_PROMPT, /A roadmap is still a roadmap when it arrives as a reason to do less work now/u);
    });

    // Under v2 a live fork answered an empty block to a conversation that was
    // nothing but two facts the person asked it to remember. This bullet, and
    // the exception it carves out of the never-write list, is the whole of v3.
    it("writes what the person explicitly asked to remember, above the never-write list", () => {
        assert.match(GENERATION_PROMPT, /^- Anything the person explicitly asked you to remember, in their words\./mu);
        assert.match(GENERATION_PROMPT, /with one exception: something the person asked you to remember is written even when it looks like state/u);
    });

    it("carries auto-memory's two lists verbatim, including the secrets line", () => {
        for (const line of [
            "A fact about this repo or operator that a fresh session would waste time rediscovering.",
            'A build flag, harness quirk, environment limit, or non-obvious "why" not in git, an ADR, or a comment.',
            "A standing operator preference or correction.",
            "Policy, process, orchestration. Those are rules; they go in `~/.claude/rules/`.",
            'Plans, roadmaps, "next action", session state, SHAs, branch names.',
            "Anything git, the tracker, or `AGENTS.md` already holds.",
            "Secrets. Name the path, never the value.",
        ]) {
            assert.ok(GENERATION_PROMPT.includes(`- ${line}`), `the prompt is missing: ${line}`);
        }
    });

    it("is written to the model in the second person", () => {
        assert.match(GENERATION_PROMPT, /^Read back over this conversation/u);
        assert.doesNotMatch(GENERATION_PROMPT, /\bthe assistant should\b/u);
    });
});
