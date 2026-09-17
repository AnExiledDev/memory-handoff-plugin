> **AI-written.** No human has read this. Every requirement below is an agent's inference.
> `session: 7c6495a3 | 2026-09-16`

# memory-handoff

When Claude Code compacts a conversation it keeps a summary and throws the rest
away, and everything the session learned about your project goes with it. The
next session rediscovers it at model cost. This plugin reads the conversation
one more time on its way out and writes down what looked worth keeping.

This is version 0.2.0 and it is still the skeleton. It forks the session at
compaction, asks the fork for a short list of candidate memories, and writes the
answer and what it cost to a JSONL log under `~/.claude/memory-handoff/`. There
is a database now, described under Storage, and nothing writes memories into it
yet. There is no search, no reranker, nothing injected back into a later prompt,
and the extraction question is a placeholder that will be replaced by a written
and measured one. So right now it is an instrument rather than a memory, and the
things that make it a memory are listed under Roadmap.

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

**Together**, compact-handoff exposes a seam, and the seam carries strings.
At `session.start` this plugin hands it the name of a tool:

```js
await $.compactHandoff.beforeCompact({
    tool: "mcp__memory-handoff__before_compact",
    name: "memory-handoff",
});
```

One compaction before it happens, compact-handoff raises that tool with
`$.tool.call({ tool, trigger, messageCount })`. The raise lands on this plugin's
own `tool.call` hook, so the fork and the row happen here, in this plugin's own
environment, beside compact-handoff's fork over the same pre-compaction
transcript. This plugin's own `session.compact` hook then forks nothing even if
it happens to be outermost. One compaction is one memory fork either way.

**`before_compact` is a registered tool, and the model can see it.** Leaving it
unregistered was tried first, on the grounds that it is for one hook of one
plugin. The engine refused the raise: `no tool named
"mcp__memory-handoff__before_compact" in this session`, measured on 2.1.273. A
tool has to be registered to be raised, there is no way to register one the
model cannot see, so its description says what it is for and the hook denies any
call that does not carry both `trigger` and `messageCount`. A denied call writes
a row with `outcome: "denied"`, which is how you would notice the model reaching
for it.

A callback would have been simpler to read and it cannot cross this boundary at
all. Each plugin runs in its own environment, an interface call's arguments go
through `cloneInto`, and `cloneInto` throws `DataCloneError` on a function. The
transcript does not travel either, which is why the raise carries
`messageCount` and the fork reads the live session itself.

The row records `via: "seam"` and `messagesIn` from the count the raise carried,
and compact-handoff's own row records this plugin's name, tool, outcome and
elapsed ms beside it. A raise that throws changes nothing for compact-handoff,
and one still pending after its timeout is abandoned so the compaction is never
held up.

**Which path ran is on the row.** `via: "seam"` means compact-handoff raised the
tool and this plugin's `session.compact` hook did nothing; `via: "hook"` means
this plugin took the compaction itself. `mcp__memory-handoff__memory_status`
answers with the same reading before any compaction has happened: its `seam`
field is `{ present: true, version }` when the subscription went through, and
`{ present: false, detail }` with the error that says so when compact-handoff is
not installed.

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

Two tools are registered. `mcp__memory-handoff__memory_status` answers with the
row count, the most recent row, whether the plugin is live, where the data is,
and whether it is reading compactions through the seam or its own hook.
`mcp__memory-handoff__before_compact` is the seam's raise and is described
above; calling it yourself gets you a denial and a row.

A seam row also carries `raise: { keys, hasToolUseId }`, the field names the
engine built the raise out of and whether it filled in a `tool_use_id`. That is
there to answer what a plugin's `$.tool.call` looks like beside the model's own
call, which the declarations leave open.

## Storage

The database is `~/.claude/memory-handoff/memory.sqlite`, or `memory.sqlite`
inside whatever `MEMORY_HANDOFF_DIR` points at. It sits outside any repository
for the same reason the rows do: the plugin's own root is a worktree somebody
may delete. It is opened in WAL mode with `foreign_keys` on and a 5000 ms busy
timeout, because two sessions can compact in the same minute and both of them
have to be able to write.

The schema is `schema/001-initial.sql` and nine tables:

- `schema_meta`, one row, the schema version the file is at.
- `memories`, the memories themselves and the metadata every filter reads.
- `memories_fts`, an FTS5 index over `title` and `body` only, external content
  over `memories`, kept in step by three triggers. The documented query shape
  weights the title: `bm25(memories_fts, 3.0, 1.0)`.
- `embeddings`, one vector per memory per model, keyed on both.
- `generations`, one row per attempt to turn a compaction into memories,
  including the attempts that wrote nothing.
- `costs`, what a model call cost, normalised into columns so a status command
  can sum a day of them.
- `retrievals`, one row per retrieval with its counts and its timings.
- `retrieval_candidates`, every candidate a retrieval considered, including the
  ones it threw away and why.
- `injections`, what was actually put in front of the model, and what was
  dropped or clipped to fit.

**The project key is the git remote URL, normalised.** `git@host:owner/repo.git`
and `https://host/owner/repo(.git)` both become `host/owner/repo`, lowercase
host, no trailing `.git`. When there is no remote the key is the git toplevel
path, and when there is no repository at all it is the cwd. A worktree under
`.claude/worktrees/x` shares `origin` with its primary and so shares the key,
which is the point: one repository is one project however many worktrees of it
you have open. The raw `cwd` and which of the three answered (`project_kind` of
`remote`, `toplevel` or `cwd`) go in the `source` JSON, never in the key. The
empty string is refused by a CHECK, so a future global scope has to be a
deliberate schema bump rather than a writer with an unset variable.

**Importance is an integer 1 to 5**, CHECK enforced. A model can emit it
reproducibly and a filter can ask for `>= 4`.

**A title is at most 200 characters and a body at most 4000**, also CHECKs. The
writer clips before it inserts and records the original length inside `source`
as `{"clipped": {"body": 6100}}`, so a memory that was cut says so rather than
looking like a short one. An unbounded blob is a thing the reranker would have
to read later.

**Deleting is a tombstone by default.** The row's `status` becomes `deleted`,
the text stays, and the status filter stops returning it, because a memory you
disagree with is evidence. `purge: true` is a real `DELETE`: it cascades to
`embeddings` and `retrieval_candidates`, takes the FTS entry with it, and leaves
`retrievals` and `injections` alone, since those hold ids and scores and no
text. A memory that captured a secret has to actually go.

**A memory is immutable once written**, except for `status`, `updated_at` and
`supersedes`. That is a trigger rather than a convention, so index drift through
an `UPDATE` that bypasses the FTS triggers cannot happen. An update is an insert
plus a supersede instead: the successor carries `supersedes`, the ancestor's
status becomes `superseded`, and a unique partial index makes a second successor
for one ancestor impossible. A `rebuild` is still shipped for a database
restored from a backup, `INSERT INTO memories_fts(memories_fts)
VALUES('rebuild')`, exposed as `rebuildFts` in `schema/bun-sqlite.js`.

**Vectors are plain blobs and the scan is brute force.** 384 float32 is 1536
bytes a memory, so 20,000 memories is 30.7 MB resident and a full scan of that
many dot products is single-digit milliseconds. 20,000 is the number at which
`sqlite-vec` and a `vec0` table become the answer; `dtype` keeps `i8` as the
cheaper lever before that, at 384 bytes a memory. A public plugin cannot ship or
locate a loadable extension per platform, which is the other half of why the
dependency is not here yet.

**Migrations are forward-only.** `schema_meta.version` says where a database is,
`schema/migrate.js` applies every `NNN-*.sql` above it in one transaction each,
and a database at a version newer than the newest file on disk is refused rather
than downgraded. `migrate.js` takes a port, `{ run(sql), get(sql) }`, and knows
about no driver and no filesystem; `schema/bun-sqlite.js` is the one adapter and
holds all of both.

`bun schema/smoke.js [path]` is the runnable check: a fresh file, two memories,
an FTS5 match, both vector dtypes, a supersede, a generation with its cost, a
retrieval with three candidates and an injection, every count asserted and a
summary line printed. `bun test` is the gate. The DDL is written for SQLite
**3.37.2**, which is the oldest build it is expected to meet, so no `STRICT`
tables, no `RETURNING` and no `->>` operator; it runs on the 3.53.0 inside
`bun:sqlite` as well, on the same file.

## Runtime

Retrieval needs two models and neither of them is a network call: an embedding
model to put a memory and a query in the same 384-dimensional space, and a
cross-encoder to re-rank the handful of candidates that survive. Both run on
this machine, on the CPU, out of a loopback daemon.

| | |
| --- | --- |
| Embedding | `BAAI/bge-small-en-v1.5` @ `5c38ec7c405e`, fp32, 384 dims, 512-token window, MIT |
| Reranker | `jinaai/jina-reranker-v1-tiny-en` @ `aca45de6945b`, int8, Apache-2.0 |
| Engine | `@huggingface/transformers` 3.8.1 on onnxruntime-node, under Bun |

### Install the weights, once

```
bun runtime/install.js
```

It downloads six files for the embedder and five for the reranker into
`~/.claude/memory-handoff/models/`, verifies every one against a sha256 pinned
in `runtime/models.json`, and prints what it wrote. **161.6 MB on disk** for the
two shipped dtypes (127.8 MB bge fp32, 33.8 MB jina int8); `--all-dtypes` also
fetches the fp32 reranker, which is only there so the quantisation comparison
below can be reproduced. A file whose digest does not match is never written.

It is a command and refuses to be imported. A hook must never be the thing that
decides to pull 160 MB off the internet, so the guard is a throw at module
scope, not a flag somebody can pass.

### Start and stop

```
bun runtime/serve.js          # foreground, prints its URL, exits after 30 idle minutes
curl -s 127.0.0.1:8794/health
curl -s -XPOST 127.0.0.1:8794/shutdown
```

It binds `127.0.0.1` and nothing else, has no authentication and wants none: the
port is not reachable from off the box. It warms both models behind the listen,
so `/health` answers immediately and says `ready: false` with a reason until the
load finishes. Every request resets the idle timer, and when it expires the
process exits 0 rather than sitting on 350 MB for a session that ended hours
ago.

**With no weights it still starts.** `/health` answers
`{ ready: false, reason: "weights missing (11 files): run bun runtime/install.js" }`
and `/embed` and `/rerank` answer 503 with the same reason in the body. Nothing
throws, at any layer, which is the point: retrieval that cannot embed falls back
to FTS5 and the session never sees an error.

### The interface

| Route | Body | Answer |
| --- | --- | --- |
| `GET /health` | | `{ ready, models, rss_bytes, weights_bytes, models_dir, device, dtypes, reason? }` |
| `POST /embed` | `{ texts: string[], kind: "query" \| "document" }` | `{ ok: true, vectors, dim, model, ms, truncated }` |
| `POST /rerank` | `{ query: string, documents: string[] }` | `{ ok: true, scores, model, ms, truncated }` |
| `POST /shutdown` | | `{ ok: true }`, then the process exits |

`kind` is not decoration. bge is asymmetric: a query gets the instruction prefix
`Represent this sentence for searching relevant passages: ` and a stored memory
does not, and getting that backwards quietly costs recall. The prefix lives
inside `embed()` so no caller has to remember it, and an unknown `kind` is
refused rather than guessed.

`truncated` is a boolean per text, reported rather than logged, because a 900-word
memory silently losing its second half is the kind of thing that only shows up
as bad retrieval three weeks later. The window is 512 tokens and the truncation
is deterministic.

`scores` from the reranker are raw logits and are **not calibrated**. Rank with
them; never threshold on them.

`runtime/client.js` is the pure client. It takes an injected
`fetchText(url, init) -> { status, ok, text }`, so the same code runs under Bun's
`fetch` and under the sandbox's `$.http.fetch` (which has no `.json`). It never
throws: a dead daemon, a 503 and a malformed body all come back as
`{ ok: false, reason }`.

### Environment

| Variable | Default | Effect |
| --- | --- | --- |
| `MEMORY_HANDOFF_RUNTIME_PORT` | `8794` | Loopback port for the daemon and the client. |
| `MEMORY_HANDOFF_RUNTIME_IDLE_MS` | `1800000` | Idle milliseconds before the daemon exits on its own. |
| `MEMORY_HANDOFF_MODELS_DIR` | `~/.claude/memory-handoff/models` | Where the weights live. |
| `MEMORY_HANDOFF_RUNTIME_DEVICE` | `cpu` | Only `cpu` works today; see the WASM note below. |

### What it costs to leave running

The ceiling this was built to: **both models under 400 MB resident, a warm
`embed(1)` under 150 ms, a warm `rerank(20)` under 600 ms.** `bun runtime/bench.js`
is the thing that checks it. Each pass is its own process, because a cold number
measured after a model is already loaded is not a cold number, and the passes run
one at a time, never together.

Measured 2026-09-17 on the box this plugin was written on: arm64 Linux, 6 cores,
7925 MB RAM, bun 1.3.14, no GPU. Three passes, `bun runtime/bench.js --runs 3`:

| | run 1 | run 2 | run 3 | median | spread |
| --- | --- | --- | --- | --- | --- |
| load, both models | 757 | 749 | 711 | **749 ms** | 711-757 |
| `embed(1)` cold | 60 | 46 | 52 | **52 ms** | 46-60 |
| `embed(1)` warm | 25 | 30 | 28 | **28 ms** | 25-30 |
| `embed(16)` warm | 229 | 221 | 215 | **221 ms** | 215-229 |
| `rerank(20)` cold | 106 | 97 | 103 | **103 ms** | 97-106 |
| `rerank(20)` warm | 74 | 78 | 78 | **78 ms** | 74-78 |
| RSS, both resident | 351.0 | 351.1 | 358.7 | **351.1 MB** | 351.0-358.7 |
| RSS peak (VmHWM) | 351.0 | 351.2 | 380.3 | **351.2 MB** | 351.0-380.3 |

All three ceilings are met, with room: 351 MB against 400, 28 ms against 150,
78 ms against 600. `ps -o rss=,vsz=,comm=` for the last pass read
`360812 75077400 bun`. `free -m` total 7925, used 2621 before and 2659 after,
available 5005 before and 4967 after, so a bench leaves nothing behind.

A long-lived daemon is a slightly different shape and worth knowing: measured
live, `VmRSS` settled at 320 MB but `VmHWM` reached 452 MB during the load. The
load is the moment of memory pressure, not the steady state.

### Why this backend, this quantisation, this shape

Four arms were measured once each, and the losers are recorded because the next
person to ask "why not int8 everywhere" deserves a number rather than a shrug.

| Arm | RSS | warm `embed(1)` | warm `rerank(20)` | Verdict |
| --- | --- | --- | --- | --- |
| **onnxruntime-node, embed fp32, rerank int8, CPU arena off** | **351 MB** | **28 ms** | **78 ms** | shipped |
| same, CPU arena on | 440 MB | 19 ms | 63 ms | rejected, over the ceiling |
| same, reranker fp32 | 432 MB | - | 165 ms | rejected, 98 MB and 87 ms for nothing |
| WASM backend | - | - | - | not measurable, see below |

- **The CPU arena is off, deliberately.** ONNX's arena allocator keeps every
  block it ever takes. Leaving it on costs 89 MB resident and buys 9 ms on a
  warm embed. On a box that has been OOM-swept once, that is the wrong side of
  the trade, and it is the single change that brought this under the ceiling.
- **The reranker ships int8.** 33.8 MB against 126 MB on disk, 78 ms against
  165 ms warm, and its ranking on the five-document sanity check is unchanged.
- **The embedder ships fp32 because there is no alternative in the named
  repository.** `BAAI/bge-small-en-v1.5` publishes `onnx/model.onnx` and no
  quantized sibling. An int8 bge exists in third-party mirrors; taking one would
  be a supply-chain decision, and it was not taken. fp32 costs 127.8 MB on disk
  and is inside the ceiling anyway.
- **The WASM arm could not be measured, and this is the honest state of it.**
  Three attempts, verbatim: the node bundle answers
  `Unsupported device: "wasm". Should be one of: cpu.`; the web bundle throws
  `TypeError: undefined is not an object (evaluating 'env.backends.onnx.wasm')`
  because `env.backends` is empty until ORT-web has loaded; and the web bundle
  served over loopback with `device: "cpu"` throws
  `TypeError: undefined is not an object (evaluating 'InferenceSession.create')`.
  Under Bun, `@huggingface/transformers` effectively exposes the native backend
  only. Since the native arm is under every ceiling, this was not pursued
  further. `MEMORY_HANDOFF_RUNTIME_DEVICE` exists for the day it is.

### The Python comparison

The operator's direction was "for runtime use bun unless there is a genuinely
faster smaller option", so a Python arm was measured rather than assumed away:
`runtime/compare/python/embed_bench.py`, on the `onnxruntime` and `numpy` that
were already installed, with a hand-written WordPiece tokenizer over the model's
own `vocab.txt`. Nothing was installed to run it, and nothing needs to be to
reproduce it.

| | Bun (shipped) | Python |
| --- | --- | --- |
| load | 749 ms | 440 ms |
| `embed(1)` cold | 52 ms | 30 ms |
| `embed(1)` warm | 28 ms | 22 ms |
| `embed(16)` warm | 221 ms | 216 ms |
| RSS | 351 MB, **both models** | 234 MB, **embedding model only** |

Python is a little quicker to load and a few milliseconds quicker per call, and
its memory figure is not comparable, because writing the reranker arm would mean
hand-writing a second tokenizer (jina is byte-level BPE, not WordPiece). On the
one axis where the two are directly comparable, warm batch embedding, they tie
at 221 and 216 ms. So Python is not *faster and smaller*, it is marginally
faster on a subset and unmeasured on the rest, and adding a Python dependency to
a Bun plugin for 6 ms is not a trade worth making. **Bun ships.**

The arm earned its keep anyway: both implementations produce the same vector to
six decimal places (`0.030454, -0.010437, 0.003020, 0.061055` for the first four
dims of the same sentence), which proves the hand-written tokenizer and the
shipped one agree, and with them the pooling and the normalisation.

### None of this runs inside the hook sandbox, by design

A hooks module may import its own files by relative path and `claude-code`, and
nothing else. There is no way to run an ONNX session in there, which is why the
runtime is a daemon the hook talks to over loopback rather than a library it
imports. The static scan says so before anything loads. A throwaway plugin whose
module does nothing but `import { readFileSync } from "node:fs"`, run through
`claude plugin validate`:

```
Validating hooks: .../probe-plugin/hooks/hooks.json

✘ Found 1 error:

  ❯ modules../module.js: probe-plugin: cannot import "node:fs" (from hooks/module.js): a hooks module imports its own files by relative path and "claude-code", nothing else

✘ Validation failed
```

### Not handled

- **Nothing calls this yet.** The hook does not know the runtime exists;
  wiring the client into generation and retrieval is
  claude-investigations#683 and #684.
- **Nothing starts the daemon for you.** It is a command you run. Supervision,
  autostart on first embed, and a lock so two sessions cannot both spawn one are
  all unbuilt.
- **One runtime per process.** transformers.js keeps its model path in a
  process-global `env`, so two `createRuntime()` instances pointed at different
  directories in one process would fight. The daemon holds exactly one.
- **No batching across callers, no queue, no backpressure.** Two concurrent
  `/embed` calls are two concurrent ONNX sessions on the same two threads.
- **No GPU, no `device: "wasm"`, no other quantisation.** Threads are pinned at
  2 intra-op and 1 inter-op so a background daemon cannot eat six cores.
- **The reranker's scores are uncalibrated** and no absolute cut-off is safe.
- **Model upgrades are a data migration.** Vectors written by one model are not
  comparable with another's; `/health` reports the exact model, revision and
  dtype so a stored vector can be attributed, and the schema records it, but
  nothing re-embeds on a change.

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
the design lives. The SQLite schema with provenance and lifecycle is in, and
nothing writes to it yet. The local embedding model (`BAAI/bge-small-en-v1.5`)
and reranker (`jinaai/jina-reranker-v1-tiny-en`) are in too, as the loopback
daemon documented under Runtime, and nothing calls them yet either. What is
still missing: the writer that turns a fork's answer into rows, a written
extraction prompt, a hybrid FTS5 and vector retrieval pipeline with an
inspectable trace, injection
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
- `mcp__memory-handoff__before_compact` sits in every prompt's tool list, and
  nothing here can hide it. The engine will not raise a tool it has never been
  told about, and `$.tool.register` has no option for a tool the model cannot
  see. The cost is one line of tool listing; the guard is the deny rule above.
- Nothing prunes `~/.claude/memory-handoff/`. It grows by one row and one small
  JSON file per compaction, forever, until you delete it.
- The runtime is 161.6 MB of weights you have to download yourself and a daemon
  you have to start yourself. Until you do both, `/health` says so and every
  call answers `{ ok: false, reason }`; nothing here starts it for you and
  nothing here fails because it is absent.
- A vector is only comparable with vectors from the same model, revision and
  dtype. `/health` reports all three so a stored vector can be attributed, but
  changing the model re-embeds nothing.
