/**
 * The one question a generation fork is asked, and the budget it is asked under.
 *
 * `$.model.fork` appends this as a user message to the session's own transcript,
 * so it is written to the session about itself, in the second person, the way
 * compact-handoff's own fork prompt is. There are no tools inside a fork ("A
 * model fork cannot use tools"), so nothing below may ask the session to check
 * anything: every instruction has to be answerable from the conversation that is
 * already in the window.
 *
 * The write and never-write lists are carried verbatim out of
 * `~/.claude/rules/auto-memory.md` rather than paraphrased, because the
 * never-write half is the half a model asked to "extract memories" gets wrong: a
 * conversation is mostly plan and state, and a plan stored as a memory is what
 * fills the database and then gets injected into every later prompt.
 *
 * One paragraph per type, and a type is allowed to come back empty. That shape
 * is compact-handoff's empty-subsection trick, which moved rejected-approach
 * carry from 11.1% to 61.1% on its own bench: a model made to consider a heading
 * and find it empty is not the same model as one that never considered it.
 *
 * The exact text is the arm file `GENERATION_PROMPT_ARM` names, because the
 * bench takes its arms as files. `test/prompt.test.js` asserts the two never
 * drift, so the numbers the README quotes are about the prompt that ships.
 */

/**
 * Which file in `bench/prompts/` this constant is, and so which measured run in
 * the README is about it. v1 leaked a roadmap item on both replicates; v2 is v1
 * with the never-write paragraph naming a plan for a future quarter outright.
 */
export const GENERATION_PROMPT_ARM = "v2";

/** At most this many memories out of one compaction. */
export const MAX_MEMORIES = 25;

/** The longest title asked for. The schema's own CHECK is 200. */
export const MAX_TITLE_CHARS = 120;

/** The longest body asked for. The schema's own CHECK is 4000. */
export const MAX_BODY_CHARS = 600;

/**
 * The generation question.
 *
 * The budget is stated rather than enforced: a fork takes `{ prompt }` and no
 * `maxTokens`, so the engine's own ceiling is the only real one and it has never
 * been provoked (a fork is null headless, so it cannot be measured from a bench).
 * 25 rows of 600 characters is roughly 4k tokens of output, comfortably under
 * the 8192 compact-handoff observed on `$.model.complete`.
 */
export const GENERATION_PROMPT = `Read back over this conversation one more time. It is about to be compacted and most of it is about to be thrown away. Write down the things a future session working on this project would otherwise have to rediscover at model cost.

A memory is a fact, not a narrative. Judge every candidate against these two lists, which are the rule this plugin exists to follow.

Write:
- A fact about this repo or operator that a fresh session would waste time rediscovering.
- A build flag, harness quirk, environment limit, or non-obvious "why" not in git, an ADR, or a comment.
- A standing operator preference or correction.

Never write:
- Policy, process, orchestration. Those are rules; they go in \`~/.claude/rules/\`.
- Plans, roadmaps, "next action", session state, SHAs, branch names.
- Anything git, the tracker, or \`AGENTS.md\` already holds.
- Secrets. Name the path, never the value.

The never-write list outranks the write list. A branch name, a commit SHA, what you were about to do next, which tests are currently failing, a plan for a future quarter, and anything you read out of an \`AGENTS.md\` or \`CLAUDE.md\` file are all worthless a week from now, and a database full of them is worse than an empty one. A roadmap is still a roadmap when it arrives as a reason to do less work now: write down the measured fact it rests on if there is one, and let the plan itself go. If a secret was pasted into this conversation, the memory names the file or the variable it lives in and never the value itself; quoting a token into a memory is the one mistake here that cannot be undone.

Consider each of these four types in turn, and let a type be empty if this conversation established nothing of that kind. Most conversations fill one or two.

\`user\` - who the person is, what they are responsible for, what they already know, and how that should change the way work is explained to them.

\`feedback\` - a correction they gave you, or an approach they confirmed was right. Carry the reason they gave, so a later session can tell an edge case from the rule.

\`project\` - a fact about this codebase or the work around it that is not derivable by reading the code: a constraint, a measured number, an environment limit, a why.

\`reference\` - where information lives outside this repository: which tracker, which dashboard, which channel, and what it is good for.

Answer with a single \`<memories>\` block and nothing else. One JSON object per line, no array, no code fence, no commentary before or after the block:

<memories>
{"type":"project","title":"short noun phrase","body":"the fact, self-contained, and why it matters","importance":3}
{"type":"feedback","title":"...","body":"...","importance":4,"supersedes_hint":"names an older memory this contradicts, in plain words"}
</memories>

Every line carries \`type\` (one of \`user\`, \`feedback\`, \`project\`, \`reference\`), \`title\` (at most ${MAX_TITLE_CHARS} characters), \`body\` (at most ${MAX_BODY_CHARS} characters, newlines escaped as \\n) and \`importance\`, a whole number from 1 (mildly useful) to 5 (would cost an hour to rediscover). \`supersedes_hint\` is optional free text and is the only place to say that something you learned here replaces something stated earlier; you cannot look anything up, so name it in words and let the plugin resolve it.

At most ${MAX_MEMORIES} memories. Fewer is better than padded: every row you write is read again in a later session's prompt, and a row that was not worth keeping costs that session tokens and attention. Write one line per fact rather than one line per topic, and make each body stand on its own, since the conversation it came from will be gone.

Leave the block empty if nothing qualifies. A conversation that established nothing durable is a normal outcome and an empty block is the correct answer to it. Do not manufacture a memory to fill the block.`;
