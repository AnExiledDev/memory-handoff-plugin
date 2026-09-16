> **AI-written.** No human has read this. Every requirement below is an agent's inference.
> `session: 7c6495a3 | 2026-09-16`

# memory-handoff

When Claude Code compacts a conversation it keeps a summary and throws the rest
away, and everything the session learned about your project goes with it. The
next session rediscovers it at model cost. This plugin reads the conversation
one more time on its way out and writes down what looked worth keeping.

This is version 0.1.0 and it is the skeleton. It forks the session at
compaction, asks the fork for a short list of candidate memories, and writes the
answer and what it cost to a JSONL log under `~/.claude/memory-handoff/`. That
is all it does. There is no database, no search, no reranker, nothing injected
back into a later prompt, and the extraction question is a placeholder that will
be replaced by a written and measured one. So right now it is an instrument
rather than a memory, and the things that make it a memory are listed under
Roadmap.

It never answers a compaction. Every `session.compact` dispatch ends in
`next(e)`, so your compaction is whatever it already was, plus a row.

## Install

```bash
claude plugin marketplace add AnExiledDev/memory-handoff-plugin
claude plugin install memory-handoff@memory-handoff
```

This repository is its own marketplace, `.claude-plugin/marketplace.json` lists
one plugin whose `source` is the repository root, so those two commands are the
whole install and neither of them needs a clone. `claude plugin install` writes
user scope unless you pass `--scope project` or `--scope local`. Claude Code
picks it up on its next launch, or on `/reload-plugins` in a session that is
already open.

Two environment variables belong in the `env` block of
`~/.claude/settings.json`, and the install does not write them for you:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
    "MEMORY_HANDOFF_LIVE": "1"
  }
}
```

Without `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` the runtime this is built on does
not exist and the module never loads. Without `MEMORY_HANDOFF_LIVE=1` it
rehearses, which means it writes a row on every compaction saying what it would
have read and spends nothing on a fork. Rehearsing is the default after an
install on purpose, since this plugin spends your money and reads your
conversation, and both of those should be a second deliberate act.

To work on it rather than use it, `--plugin-dir` loads a folder for one session
and takes precedence over the installed copy of the same name:

```bash
git clone https://github.com/AnExiledDev/memory-handoff-plugin.git
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 MEMORY_HANDOFF_LIVE=1 claude --plugin-dir ./memory-handoff-plugin
```

The runtime is Bun, and the tests run under `bun test`. The operator's
instruction on 2026-09-16, verbatim: *"For runtime use bun unless there is a
genuinly faster smaller option."*

## Working beside compact-handoff

[compact-handoff](https://github.com/AnExiledDev/compact-handoff-plugin) replaces
the engine's compaction with its own handoff. It answers `session.compact`
without calling `next`, and inside the `user` tier a hook chain runs in the key
order of `enabledPlugins` in `~/.claude/settings.json`, first key outermost. So
a plugin whose key sits below `compact-handoff@compact-handoff` never sees the
compaction event at all, and `claude plugin install` appends each new key last,
which means whatever you installed most recently runs innermost. That was
measured on engine 2.1.273 with two marketplace-installed plugins. Nobody should
have to hand-edit `enabledPlugins` to make two plugins get along, so this one
does not depend on the order.

**Alone**, memory-handoff hooks `session.compact` itself, takes one fork over
the pre-compaction transcript, writes its row, and returns `next(e)` so the
engine compacts exactly as it always did. The row records `via: "hook"`.

**Together**, compact-handoff exposes a seam, `$.compactHandoff.beforeCompact(fn,
{ name })`, that fires with the same event right beside its own fork. This
plugin looks for that seam at `session.start` and subscribes to it when it is
there, and its own `session.compact` hook then forks nothing even if it happens
to be outermost. One compaction is one memory fork either way. The row records
`via: "seam"`, and compact-handoff's own row records the subscriber's name,
outcome and elapsed ms beside it. A subscriber that throws changes nothing for
compact-handoff, and one still pending after its timeout is abandoned so the
compaction is never held up.

Two things the seam deliberately does not carry. A subagent's compaction is
passed through by compact-handoff without calling subscribers, so it reaches
this plugin only when this plugin is outermost, and it is skipped there too with
a row saying `subagent`. And a compaction compact-handoff declines for its own
budget reasons never reaches the seam. Both are fine for now, because a
subagent's conversation is not a memory source yet.

A `precompute` compaction is passed through here without a fork. The engine is
building a compaction it may never use, and spending on one that gets discarded
is money for nothing. compact-handoff declines those outright, which is its
business, and this plugin hands them on because it answers no compaction ever.

## Where the data lives

`~/.claude/memory-handoff/`, or wherever `MEMORY_HANDOFF_DIR` points.

- `index.jsonl`, one row per compaction, appended with `cat >>` because `$.fs`
  has no append and a read-modify-write loses rows when two sessions compact at
  the same second.
- `sessions/<sessionId>/<n>.json`, the fork's reply as it came back, with the
  prompt it was asked and the usage it reported.

**That second file is your conversation, distilled.** Read the plugin before you
run it live and decide whether you want that on disk. Nothing is sent anywhere,
the fork runs on the session's own model through Claude Code, and nothing here
phones home, but the reply is written to your home directory in plain text and
it will contain whatever the fork thought was worth remembering out of your
work.

A row carries when it ran, `via`, the session id, cwd, the compaction trigger,
the model, the plugin and engine versions, how many messages the transcript
held, the context the session reported, the fork's `usage`, how long it took in
milliseconds, how many candidate memories parsed out, and where the reply went.
Every one of those readings is allowed to fail on its own, so a field can be
`null` and the row still gets written. Outcomes are `extracted`, `empty`,
`cold`, `threw`, `rehearsed` and `subagent`.

Durations are `Date.now()` everywhere, because `$.clock.now()` returns a Promise
at 2.1.273 against a declaration saying it returns a number, and subtracting a
Promise gives you `NaN` which serialises as `null`. That cost compact-handoff 65
of its first 66 rows.

`mcp__memory-handoff__memory_status` is the one registered tool, and it answers
with the row count, the most recent row, whether the plugin is live, where the
data is, and whether it is reading compactions through the seam or its own hook.

## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `MEMORY_HANDOFF_LIVE` | off | Off, every compaction writes a `rehearsed` row and no fork runs. On, it forks. |
| `MEMORY_HANDOFF_DIR` | `~/.claude/memory-handoff` | Where rows and replies are kept. |
| `MEMORY_HANDOFF_MODEL` | unset | Recorded on the row as `modelRequested` and nothing else yet. `$.model.fork` takes `{ prompt }` and no model, so there is nothing for it to steer until the model runtime lands. |

## What it costs

One fork per compaction, and the fork is one tool-less completion over a
transcript the session was about to throw away. Measured during the spike that
led to this plugin, a second fork from inside `session.compact` over a 57k
transcript cost $0.0012 with the cache discount and $0.0156 without it, and took
about 2 seconds. The same fork taken from `turn.complete` right after a
compaction cost $0.4995, because the compaction forces a roughly 40k-token cache
write. That is a 400x difference on the same question, which is why the fork
happens inside the compaction event and nowhere else.

Every row carries the fork's `usage` for that reason: `input_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`. A
warm fork shows a large `cache_read` and a `cache_creation` near zero, and a
cold one shows the reverse, so you can tell from the row which one you paid for
without guessing. compact-handoff has been seen taking cold forks it could not
explain, every one of them paired with a subagent compaction, and that is
claude-investigations#690. The seam hands this plugin the same event, so it
inherits the same problem, and recording the usage is how it stays visible.

The row carries no dollar figure yet. compact-handoff prices its rows from a
table it reads off Anthropic's pricing page and records the date it was read;
this one records the tokens and leaves the arithmetic for later.

## Roadmap

This is the first slice of AnExiledDev/claude-investigations#678, which is where
the design lives. What is still missing: the SQLite schema with provenance and
lifecycle, a written extraction prompt, a local embedding model
(`BAAI/bge-small-en-v1.5`) and reranker (`jinaai/jina-reranker-v1-tiny-en`), a
hybrid FTS5 and vector retrieval pipeline with an inspectable trace, injection
on `prompt.submit` and on no other kind of turn, a pane showing what this
session was given, and the rest of the tools.

Until those land the honest description is that this plugin measures a fork and
stores its answer. It does not remember anything for you yet.

## Known limits

- The extraction prompt is a placeholder, it has never been graded against
  anything, and what comes back is whatever the model felt like writing. Take
  the JSON shape as a hint and not a contract.
- `$.model.fork` is always null headless, the engine says so in its log, so
  under `claude -p` every row reads `cold` and nothing is extracted.
- A session that started before compact-handoff loaded, or one where the seam
  check ran before the noun existed, falls back to this plugin's own hook. That
  is safe, since the seam flag is what the hook checks, and the worst case is a
  fork that never happens because compact-handoff answered first.
- Nothing prunes `~/.claude/memory-handoff/`. It grows by one row and one small
  JSON file per compaction, forever, until you delete it.
