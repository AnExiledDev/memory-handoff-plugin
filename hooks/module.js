/**
 * memory-handoff: the conversation a compaction throws away, read once for
 * anything worth remembering later, and handed back at the next prompt.
 *
 * It forks the session at compaction time, asks the fork for what is worth
 * keeping, and writes the memories and what they cost to SQLite. At the next
 * prompt somebody types it retrieves against that store and attaches what it
 * found as context the model reads and the person never sees. Four tools and a
 * pane are how a person sees it instead.
 *
 * Four rules shape everything below.
 *
 * **Exactly one fork per compaction.** compact-handoff answers `session.compact`
 * without calling `next`, so a plugin keyed after it in `enabledPlugins` never
 * sees the event at all. It offers a seam instead: this module hands it the name
 * of a tool at `session.start`, and one compaction before it happens
 * compact-handoff raises that tool, so the generation runs here beside its own
 * fork over the same pre-compaction transcript. When the seam is there this
 * module's own `session.compact` hook forks nothing, so the two installs
 * together still pay for one memory fork. When the seam is absent the hook does
 * the fork itself. The row says which path carried it, `via: "seam"` or
 * `via: "hook"`.
 *
 * **It never answers a compaction.** Every `session.compact` dispatch ends in
 * `next(e)`, whatever happened here, so the compaction you already had is what
 * you still get. Every runtime call is wrapped: a throw becomes a field on the
 * row and never an unhandled rejection, because the worst case of installing
 * this must be your own compaction plus a row.
 *
 * **It never answers a prompt either.** Every `prompt.submit` dispatch ends in
 * `next`, and the context is attached on the way down, which is the only place
 * the engine attaches it. A retrieval is bounded by a hard timeout on the whole
 * child; when it does not answer, the prompt goes down untouched and a row says
 * why. The worst case of a broken memory store is a prompt with no memories.
 *
 * **Nothing here can open SQLite.** A plugin module runs in a sandbox that
 * imports its own files and `claude-code` and nothing else, so every database
 * call below is a Bun child: `retrieval/search-cli.js` for a retrieval,
 * `retrieval/explain-cli.js` for a trace, `schema/write-generation.js` for a
 * generation and `schema/memory-admin.js` for everything else.
 */

import { projectKey } from "../schema/generation-rows.js";
import { composeInjection, finalScoreOf, injectionGate, promptLine } from "./inject.js";
import { paneTree } from "./pane.js";
import { parseReply } from "./parse.js";
import { priceUsage } from "./pricing.js";
import { GENERATION_PROMPT } from "./prompt.js";

/**
 * Which `generations.outcome` each index-row outcome is written as.
 *
 * An outcome missing from here writes no database row at all: a refused raise
 * is not a generation, and a rehearsal deliberately leaves the database alone,
 * which is the whole of what rehearsing means.
 *
 * `extracted` covers an empty block as well as a full one, because a
 * conversation that established nothing durable is a generation that worked:
 * `wrote` with `memories_written = 0`. `empty` is the other thing, a reply that
 * carried no block at all.
 */
const DB_OUTCOMES = {
    extracted: "wrote",
    empty: "empty",
    cold: "cold",
    threw: "failed",
    subagent: "skipped",
    precompute: "skipped",
    overBudget: "overBudget",
};

/** How long the writer child may take before the generation is recorded without it. */
const WRITE_MS = 20_000;

/** How long a `git` reading may take before the project falls back to the cwd. */
const GIT_MS = 3000;

/** How many rejected lines are named on the index row; the count is always exact. */
const MAX_REJECTED_REASONS = 5;

/** Whether this session reached the transcript through compact-handoff's seam. */
const SEAM_KEY = "seam";

/**
 * The tool compact-handoff raises when a compaction is about to happen, and the
 * whole of the seam between the two plugins.
 *
 * The seam carries strings. A callback cannot cross a plugin boundary here at
 * all: each plugin runs in its own environment, an interface call's arguments
 * go through `cloneInto`, and `cloneInto` throws `DataCloneError` on a function.
 * So compact-handoff is handed this name and raises it, the raise lands on the
 * hook below, and the generation runs in this plugin's environment where a fork
 * works the way it does everywhere else.
 *
 * It has to be registered. Leaving it out was tried first, because the model
 * has no business calling it, and the engine refused the raise outright:
 * `HooksError: compact-handoff: $.tool.call: no tool named
 * "mcp__memory-handoff__before_compact" in this session` (live run C, engine
 * 2.1.273). There is no way to register a tool the model cannot see, so it is
 * registered with a description saying what it is for, and the hook denies any
 * call that does not carry compact-handoff's fields.
 */
const SEAM_TOOL = "mcp__memory-handoff__before_compact";

/** How many compactions this session has generated from, for the filename. */
const DEPTH_KEY = "depth";

/** How much of a fork's reply is kept on the row itself; the rest is on disk. */
const MAX_DETAIL_CHARS = 2000;

/** How long a tool's child may take. Nobody is waiting on a keystroke here. */
const TOOL_MS = 30_000;

/** The four tools the model may call, spelled out because a matcher takes a literal. */
const TOOL_SEARCH = "mcp__memory-handoff__memory_search";
const TOOL_EXPLAIN = "mcp__memory-handoff__memory_explain";
const TOOL_LIST = "mcp__memory-handoff__memory_list";
const TOOL_DELETE = "mcp__memory-handoff__memory_delete";

/** What every knob is when nobody set it. */
const DEFAULT_INJECT_K = 5;
const DEFAULT_MAX_ENTRIES = 5;
const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_INJECT_MS = 1500;
const DEFAULT_BUDGET_USD = 1;

/**
 * How much of the prompt's own budget the child's runtime wait may take.
 *
 * The outer `timeoutMs` is the hard bound on the whole child; the runtime wait
 * inside it has to end first, or the child is killed mid-degradation and the
 * `retrievals` row it was about to write is never written.
 */
const RUNTIME_MARGIN_MS = 300;

/** The least runtime wait worth asking for once the margin is taken off. */
const RUNTIME_FLOOR_MS = 200;

/** The pane's id and its tab. One pane, opened once. */
const PANE_ID = "memory-handoff";
const PANE_TITLE = "Memories";

/** How many prompts the pane lists before the oldest falls off. */
const MAX_PANE_INJECTIONS = 20;

/** What this session has injected, for the pane. Newest first. */
const INJECTIONS_KEY = "injections";

/** This session's running counts, for `memory_status` and the budget. */
const SESSION_KEY = "session";

/** Whether the pane was opened, and whether the person closed it. */
const PANE_KEY = "pane";

/** The project key, worked out once per session from git. */
const PROJECT_KEY = "project";

/** The counters a session starts with. */
const EMPTY_SESSION = {
    retrievals: 0,
    injections: 0,
    memoriesInjected: 0,
    charsInjected: 0,
    approxTokensInjected: 0,
    spendUsd: 0,
};

/** What a tool answers when its own body threw; a tool never throws at the model. */
const THREW = { ok: false, reason: "memory-handoff: the call threw, and the reason is in the session's debug log" };

/**
 * Three environment variables steer this, and the static scan will only take
 * them spelled out at the call site, so they are named here and nowhere else:
 *
 * - `MEMORY_HANDOFF_LIVE` off, it rehearses: a generation writes a row saying
 *   what it would have done and spends nothing, and a prompt still runs its
 *   retrieval and writes its row but attaches nothing to the prompt.
 * - `MEMORY_HANDOFF_DIR` where the rows, the replies and the database are kept.
 * - `MEMORY_HANDOFF_INJECT_K` how many memories a prompt's retrieval asks for.
 * - `MEMORY_HANDOFF_INJECT_MAX_ENTRIES` how many of them may be attached.
 * - `MEMORY_HANDOFF_INJECT_MAX_CHARS` how much text they may come to.
 * - `MEMORY_HANDOFF_INJECT_TIMEOUT_MS` the hard bound on the retrieval child.
 * - `MEMORY_HANDOFF_SESSION_BUDGET_USD` what one session's generations may cost
 *   before the next one is skipped.
 */
export const register = (on) => {
    on("session.start", async ($, e, next) => {
        await safely($, () => registerTools($));
        await safely($, () => subscribeToSeam($));

        return next(e);
    });

    /**
     * The prompt, and the memories that go down with it.
     *
     * The retrieval runs before `next` because context attaches on the way
     * down: the declaration is explicit that context put on the result after
     * `next` resolved is not attached, the prompt having already entered. The
     * row, the pane and the counters all wait until after, so the only thing
     * between the person's Enter and their turn is the one bounded child.
     */
    on("prompt.submit", async ($, e, next) => {
        const plan = await safely($, () => planInjection($, e));

        if (plan === null) {
            return next(e);
        }

        const answer = await next(plan.block === null ? e : { ...e, context: [...(e.context ?? []), plan.block] });

        await safely($, () => recordInjection($, plan));
        await safely($, () => showPane($));

        return answer;
    });

    on("ui.render", { surface: "terminal", component: "Pane" }, async ($, e, next) => {
        if (e.requestId !== PANE_ID) {
            return next(e);
        }

        return drawMemoryPane($, e);
    });

    /**
     * A pane the person closed stays closed.
     *
     * Reopening it on the next injection is the behaviour that makes a person
     * uninstall a plugin, so the close is remembered for the session and the
     * only way back is `/memory` in a later version, or a new session.
     */
    on("ui.close", async ($, e, next) => {
        if (e.id === PANE_ID && e.origin?.kind === "person") {
            await safely($, () => $.store.set(PANE_KEY, { opened: false, closedByPerson: true }));
        }

        return next(e);
    });

    on("tool.call", { tool: "mcp__memory-handoff__memory_status" }, async ($) => {
        return { result: JSON.stringify(await statusReport($), null, 2) };
    });

    // A hook apiece rather than one dispatcher: the engine refuses a module
    // that hands `$` to anything but a top-level function of this file, so
    // every tool names the function that serves it.
    on("tool.call", { tool: TOOL_SEARCH }, async ($, e) => {
        return { result: JSON.stringify((await safely($, () => searchTool($, e))) ?? THREW, null, 2) };
    });

    on("tool.call", { tool: TOOL_EXPLAIN }, async ($, e) => {
        return { result: JSON.stringify((await safely($, () => explainTool($, e))) ?? THREW, null, 2) };
    });

    on("tool.call", { tool: TOOL_LIST }, async ($, e) => {
        return { result: JSON.stringify((await safely($, () => listTool($, e))) ?? THREW, null, 2) };
    });

    on("tool.call", { tool: TOOL_DELETE }, async ($, e) => {
        return { result: JSON.stringify((await safely($, () => deleteTool($, e))) ?? THREW, null, 2) };
    });

    // compact-handoff raising the seam, one compaction before it happens. It
    // never calls `next`: this call exists for this hook and for nothing else,
    // and the answer goes back on compact-handoff's own row.
    on("tool.call", { tool: SEAM_TOOL }, async ($, e) => {
        const about = seamAbout(e);

        // The tool is registered, so the model can see it and will sometimes
        // try it. Only compact-handoff's raise carries both of these.
        if (about.trigger === null || about.messagesIn === null) {
            await safely($, () => refuseRaise($, about));

            return { deny: DENY_REASON };
        }

        const record = await safely($, () => generate($, about, "seam"));

        if (record === null) {
            return { result: { outcome: "threw", n: null, elapsedMs: null } };
        }

        return { result: { outcome: record.outcome, n: record.n, elapsedMs: record.elapsedMs } };
    });

    // A precompute is the engine building a compaction it may never use, so
    // nothing here spends on it; the skip is recorded rather than silent, so a
    // session whose compactions all arrive this way is visible instead of
    // looking like a plugin that never ran. It is handed on rather than
    // declined: this plugin answers no compaction, and a `{ skip }` from here
    // would change how the engine compacts for someone who installed a memory
    // plugin.
    on("session.compact", { trigger: "precompute" }, async ($, e, next) => {
        await safely($, () => generate($, hookAbout(e), "hook"));

        return next(e);
    });

    on("session.compact", async ($, e, next) => {
        const seam = await safely($, () => $.store.get(SEAM_KEY));

        // The seam already carried this one, or is about to. Forking here too
        // is the double spend the whole arrangement exists to avoid.
        if (seam !== null && seam !== undefined && seam.present === true) {
            return next(e);
        }

        await safely($, () => generate($, hookAbout(e), "hook"));

        return next(e);
    });
};

/**
 * What a generation needs to know about the compaction it is reading, from the
 * two events that carry it.
 *
 * The raise carries a count because the messages themselves cannot cross the
 * boundary; the hook has the messages in hand. Either way the fork reads the
 * live session rather than anything passed in, so the count is a row field and
 * never an input to the work.
 */
const seamAbout = (e) => ({
    trigger: typeof e?.trigger === "string" ? e.trigger : null,
    agentId: e?.agentId ?? null,
    messagesIn: typeof e?.messageCount === "number" ? e.messageCount : null,
    raise: raiseShape(e),
});

const hookAbout = (e) => ({
    trigger: e?.trigger ?? null,
    agentId: e?.agentId ?? null,
    messagesIn: Array.isArray(e?.messages) ? e.messages.length : null,
    raise: null,
});

/**
 * What the engine filled in on the raise, in two small fields.
 *
 * A plugin's `$.tool.call` and the model's own call arrive at the same hook,
 * and how much of a tool call the engine builds for a raise is not documented:
 * the declarations say `tool_use_id` is on every `tool.call` input. Recording
 * the key names and whether that id was there is how the next version finds
 * out, and it costs a row field.
 */
const raiseShape = (e) => ({
    keys: Object.keys(e ?? {}).filter((key) => key !== "messages"),
    hasToolUseId: typeof e?.tool_use_id === "string",
});

/** Why a call that is not compact-handoff's raise is refused. */
const DENY_REASON = "before_compact is raised by compact-handoff at compaction; it is not a tool for the model";

/** A refused call is a row too, so a model reaching for it is visible. */
const refuseRaise = async ($, about) => {
    const startedAt = Date.now();

    return finish($, await blankRecord($, about, "seam"), "denied", startedAt);
};

/**
 * Subscribes to compact-handoff when it is there, and records either way.
 *
 * The calls are written out longhand and wrapped, because that is the only
 * spelling the engine's static scan takes: `$` is `$.noun.event(...)` at the
 * call site, and a noun read, bound or optionally chained is refused at load
 * ("$.<noun> is used as a value"). So there is no `typeof` check and no
 * optionally chained read of the noun, which is what refused 0.1.0 at load.
 * With compact-handoff absent there is no such noun, reading it throws a
 * TypeError, and that throw is the detection.
 *
 * It runs at `session.start` because that is the first event after the
 * `engine.create` fold that adds the noun.
 */
const subscribeToSeam = async ($) => {
    let reading = null;

    try {
        await $.compactHandoff.beforeCompact({ tool: SEAM_TOOL, name: "memory-handoff" });

        const version = await $.compactHandoff.version();

        reading = { present: true, version, detail: null, at: Date.now() };
    } catch (error) {
        reading = { present: false, version: null, detail: String(error).slice(0, MAX_DETAIL_CHARS), at: Date.now() };
    }

    await safely($, () => $.store.set(SEAM_KEY, reading));
};

/**
 * One compaction, read for memories and written down.
 *
 * Every step that can throw is wrapped, and the row is appended on every path,
 * including the paths that spent nothing. A generation that fails is a row with
 * an outcome on it.
 */
const generate = async ($, about, via) => {
    const startedAt = Date.now();
    const record = await blankRecord($, about, via);

    // A subagent's compaction is a different conversation with a different
    // owner, and a subagent is not a memory source yet. compact-handoff does
    // not call the seam for one either, so this only catches the hook path.
    if (record.agentId !== null && record.agentId !== undefined) {
        return finish($, record, "subagent", startedAt);
    }

    if (record.live !== true) {
        return finish($, record, "rehearsed", startedAt);
    }

    // The engine speculatively compacting something it may never use. Spending
    // a fork on a compaction that gets thrown away is money for nothing.
    if (record.trigger === "precompute") {
        return finish($, record, "precompute", startedAt);
    }

    // A session that compacts all day is a session that forks all day. The
    // ceiling is per session rather than per day because a session is what a
    // person is looking at when they decide this plugin costs too much.
    const budget = await sessionBudget($);
    const spent = (await sessionCounts($)).spendUsd;

    if (budget !== null && spent >= budget) {
        record.detail = `${spent.toFixed(4)} spent of a ${budget.toFixed(2)} session ceiling`;

        return finish($, record, "overBudget", startedAt);
    }

    try {
        const reply = await $.model.fork({ prompt: GENERATION_PROMPT });

        if (reply === null || reply === undefined) {
            return finish($, record, "cold", startedAt);
        }

        const text = typeof reply.text === "string" ? reply.text : "";
        const parsed = parseReply(text);

        record.usage = reply.usage ?? null;
        record.replyChars = text.length;
        // Priced here and not only in the writer, because the ceiling above has
        // to hold in the session that is spending, not in the next one that
        // reads the table.
        await safely($, () => bumpSession($, { spendUsd: priceUsage(record.usage, record.model).usd ?? 0 }));
        record.parsedRows = parsed.rows.length;
        record.rejectedRows = parsed.rejected.length;
        record.rejected = parsed.rejected.slice(0, MAX_REJECTED_REASONS);
        record.hitOutputCap = parsed.hitCap;
        record.replyFile = await safely($, () => storeReply($, record, text));

        return finish($, record, parsed.hadBlock ? "extracted" : "empty", startedAt, parsed.rows);
    } catch (error) {
        record.detail = String(error).slice(0, MAX_DETAIL_CHARS);

        return finish($, record, "threw", startedAt);
    }
};

/**
 * Everything a row knows before the work happens, for the two paths that write
 * one: a generation, and a call this plugin refused.
 */
const blankRecord = async ($, about, via) => {
    const usage = await safely($, () => $.session.usage());

    return {
        at: new Date().toISOString(),
        n: await nextDepth($),
        via,
        live: await isLive($),
        sessionId: await safely($, () => $.session.id()),
        cwd: await safely($, () => $.session.cwd()),
        model: await safely($, () => $.session.model()),
        trigger: about.trigger,
        agentId: about.agentId,
        messagesIn: about.messagesIn,
        raise: about.raise,
        context: usage?.context ?? null,
        plugin: await pluginVersion($),
        engine: (await safely($, () => $.env.get("CLAUDE_CODE_VERSION"))) ?? null,
        outcome: "",
        detail: "",
        usage: null,
        replyChars: null,
        parsedRows: null,
        rejectedRows: null,
        rejected: null,
        hitOutputCap: null,
        memoriesWritten: null,
        writeOutcome: null,
        project: null,
        replyFile: null,
        elapsedMs: null,
    };
};

/**
 * Stamps the outcome and the clock on the row, writes the generation to SQLite,
 * appends the row and hands it back.
 *
 * The clock is read before the database write on purpose: `elapsed_ms` on a
 * `generations` row is how long reading the conversation took, and folding a
 * child process's startup into it would make every generation look slower than
 * the fork it is measuring.
 *
 * @param {import("./parse.js").MemoryRow[]} [rows] The parsed memories, which live on the row's own
 *   file rather than on the row: `index.jsonl` is a log, not the store.
 */
const finish = async ($, record, outcome, startedAt, rows = []) => {
    record.outcome = outcome;

    // `$.clock.now()` answers a Promise at 2.1.273 against a declaration that
    // says `number`, so every duration here is `Date.now()`.
    record.elapsedMs = Date.now() - startedAt;

    const written = await safely($, () => writeGeneration($, record, rows));

    record.writeOutcome = written?.outcome ?? "threw";
    record.memoriesWritten = written?.memoriesWritten ?? null;
    record.project = written?.project ?? null;

    await safely($, () => appendRow($, record));

    return record;
};

/**
 * The generation, handed to SQLite by a Bun child over stdin.
 *
 * A plugin module runs in a sandbox with no SQLite and no import of anything
 * but a relative file, so the database is reached the same way the row log is:
 * a process. The whole document goes over stdin rather than the argv, because
 * the memories are the conversation and an argv is visible in `ps`.
 *
 * Every failure here is a field on the row. A database that will not open must
 * cost somebody a memory, never their compaction.
 */
const writeGeneration = async ($, record, rows) => {
    const outcome = DB_OUTCOMES[record.outcome] ?? null;

    if (outcome === null || record.live !== true) {
        return { outcome: "no row", memoriesWritten: null, project: null };
    }

    const dir = await dataDir($);
    const where = await gitFacts($, record.cwd);
    const ran = await $.process.run(["bun", `${$.plugin.root}/schema/write-generation.js`], {
        stdin: JSON.stringify(writeDocument(record, rows, outcome, where, `${dir}/memory.sqlite`)),
        timeoutMs: WRITE_MS,
    });
    const answer = readAnswer(ran);

    return {
        outcome: answer.ok === true ? "wrote" : `refused: ${String(answer.reason ?? "").slice(0, 200)}`,
        memoriesWritten: typeof answer.memoriesWritten === "number" ? answer.memoriesWritten : null,
        project: typeof answer.project === "string" ? answer.project : null,
    };
};

/** What the writer said, or the child's own failure read as the same shape. */
const readAnswer = (ran) => {
    try {
        return JSON.parse((ran?.stdout ?? "").trim().split("\n").at(-1) ?? "");
    } catch {
        return { ok: false, reason: `the writer wrote no answer: ${(ran?.stderr ?? "").slice(0, 200)}` };
    }
};

/** Everything the writer needs, in the one document it reads off stdin. */
const writeDocument = (record, rows, outcome, where, dbPath) => ({
    dbPath,
    remoteUrl: where.remoteUrl,
    toplevel: where.toplevel,
    cwd: record.cwd,
    model: record.model,
    usage: record.usage,
    // A pass with no usage made no model call, and a real zero says so rather
    // than being summed into a day's total as if the fork had been free.
    costNote: record.usage === null ? `no model call: ${record.outcome}` : null,
    source: {
        sessionId: record.sessionId,
        n: record.n,
        via: record.via,
        trigger: record.trigger,
        replyFile: record.replyFile,
    },
    rows,
    generation: {
        at: record.at,
        sessionId: record.sessionId,
        compactionN: record.n,
        trigger: record.trigger,
        agentId: record.agentId,
        messagesIn: record.messagesIn,
        outcome,
        outcomeReason: reasonFor(record),
        parsedRows: record.parsedRows,
        rejectedRows: record.rejectedRows,
        hitCap: record.hitOutputCap,
        elapsedMs: record.elapsedMs,
        plugin: record.plugin,
        engine: record.engine,
    },
});

/** Why a generation ended as it did, in the words a reader of the table wants. */
const reasonFor = (record) => {
    if (record.outcome === "empty") {
        return "no block";
    }

    if (record.outcome === "cold") {
        return "the fork found no warm main-thread transcript";
    }

    if (record.outcome === "subagent") {
        return "a subagent's compaction is a different conversation";
    }

    if (record.outcome === "precompute") {
        return "a precompute compaction the engine may never use";
    }

    if (record.outcome === "overBudget") {
        return `the session's generation budget is spent: ${record.detail}`;
    }

    if (record.outcome === "threw") {
        return record.detail.slice(0, 200);
    }

    return null;
};

/**
 * Which repository this session is in, for the project key.
 *
 * Both readings are allowed to fail and both are short: a compaction must never
 * wait on a git that is slow, and a missing remote is an ordinary answer that
 * the key falls back through.
 */
const gitFacts = async ($, cwd) => ({
    remoteUrl: await gitLine($, cwd, ["git", "remote", "get-url", "origin"]),
    toplevel: await gitLine($, cwd, ["git", "rev-parse", "--show-toplevel"]),
});

const gitLine = async ($, cwd, argv) => {
    const ran = await safely($, () => $.process.run(argv, { cwd: cwd ?? undefined, timeoutMs: GIT_MS }));

    return ran?.exitCode === 0 ? (ran.stdout ?? "").trim() || null : null;
};

/** The fork's answer as it came back, beside the row that prices it. */
const storeReply = async ($, record, text) => {
    const file = `${await dataDir($)}/sessions/${record.sessionId ?? "unknown"}/${record.n}.json`;

    await $.fs.write(
        file,
        JSON.stringify(
            {
                at: record.at,
                n: record.n,
                via: record.via,
                sessionId: record.sessionId,
                prompt: GENERATION_PROMPT,
                text,
                usage: record.usage,
            },
            null,
            2,
        ),
    );

    return file;
};

/**
 * One prompt's whole injection decision, made before the prompt goes down.
 *
 * `null` means this submission is not one memories go to at all, and that is
 * the one path that writes no row: a peer session's delivery, a plugin's own
 * prompt or an empty one is not a retrieval that failed, it is a retrieval that
 * was never owed. Every other path returns a plan, and every plan becomes a row.
 *
 * @returns {Promise<object | null>}
 */
const planInjection = async ($, e) => {
    const gate = injectionGate(e);

    if (gate.inject !== true) {
        return null;
    }

    const plan = {
        query: gate.query,
        caps: await injectCaps($),
        sessionId: await safely($, () => $.session.id()),
        turnId: null,
        project: await projectFor($),
        retrievalId: null,
        candidates: 0,
        chosen: [],
        block: null,
        chars: 0,
        approxTokens: 0,
        dropped: 0,
        disposition: "injected",
        reason: null,
        msTotal: null,
    };

    if (plan.project === null) {
        return failedPlan(plan, "no project key: this session has neither a git remote, a toplevel nor a cwd");
    }

    const startedAt = Date.now();
    const found = await searchForPrompt($, plan);

    plan.msTotal = Date.now() - startedAt;

    if (found.ok !== true) {
        return failedPlan(plan, found.reason);
    }

    const results = Array.isArray(found.document.results) ? found.document.results : [];
    const composed = composeInjection(results, plan.caps, found.document.retrievalId ?? "?");

    plan.retrievalId = typeof found.document.retrievalId === "number" ? found.document.retrievalId : null;
    plan.candidates = results.length;
    plan.chosen = composed.entries.map(paneEntry);
    plan.dropped = composed.dropped;
    plan.block = composed.block;
    plan.chars = composed.chars;
    plan.approxTokens = composed.approxTokens;

    if ((await isLive($)) !== true) {
        return rehearsedPlan(plan);
    }

    return plan;
};

/** A plan that never reached a retrieval, or reached one that did not answer. */
const failedPlan = (plan, reason) => ({ ...plan, disposition: "failed", reason, block: null, chars: 0, approxTokens: 0 });

/**
 * A plan that ran, chose, and attached nothing.
 *
 * The schema has no disposition column and this issue adds no DDL, so the pair
 * of rows carries it: the `retrievals` row is whole (it really ran, and
 * `returned_n` says what it found) while the `injections` row beside it holds
 * no ids and no characters. A failed retrieval reads differently because its
 * own row is the degraded one. Both are in the README.
 */
const rehearsedPlan = (plan) => ({
    ...plan,
    disposition: "rehearsed",
    reason: "MEMORY_HANDOFF_LIVE is off, so nothing was attached",
    block: null,
    chars: 0,
    approxTokens: 0,
    dropped: plan.candidates,
});

/** What the pane and the row keep about one chosen memory. */
const paneEntry = (entry) => {
    const scored = finalScoreOf(entry);

    return { memoryId: entry.memoryId, title: entry.title, score: scored.score, scoreKind: scored.kind };
};

/**
 * The retrieval, as a bounded child.
 *
 * Bounded twice: `timeoutMs` is the hard stop on the whole child and the only
 * thing standing between a wedged runtime and the person's Enter, and the
 * runtime wait inside it is set lower so the child still has time to write its
 * own degraded row before it is killed. `$.process.run` rejects on the timeout
 * rather than resolving with a code, which is why the call is wrapped.
 *
 * The query goes over stdin, never the argv: the query here is the prompt the
 * person typed, and an argv is readable in `ps` by anyone on the machine.
 */
const searchForPrompt = async ($, plan) => {
    const runtimeMs = Math.max(RUNTIME_FLOOR_MS, plan.caps.timeoutMs - RUNTIME_MARGIN_MS);
    const argv = [
        "bun",
        `${$.plugin.root}/retrieval/search-cli.js`,
        await dbFile($),
        "--project",
        plan.project,
        "--query-stdin",
        "--k",
        String(plan.caps.k),
        "--origin",
        "prompt",
        "--runtime-timeout-ms",
        String(runtimeMs),
        "--with-id",
        ...(typeof plan.sessionId === "string" && plan.sessionId !== "" ? ["--session-id", plan.sessionId] : []),
    ];

    let ran = null;

    try {
        ran = await $.process.run(argv, { timeoutMs: plan.caps.timeoutMs, stdin: plan.query });
    } catch (error) {
        return { ok: false, reason: `the retrieval did not finish inside ${plan.caps.timeoutMs}ms: ${String(error).slice(0, 200)}` };
    }

    if (ran?.exitCode !== 0) {
        return { ok: false, reason: `the retrieval exited ${ran?.exitCode ?? "(no code)"}: ${(ran?.stderr ?? "").trim().slice(0, 200)}` };
    }

    try {
        return { ok: true, document: JSON.parse(ran.stdout ?? "") };
    } catch (error) {
        return { ok: false, reason: `the retrieval printed no document: ${String(error).slice(0, 200)}` };
    }
};

/**
 * The row, the pane's copy and the counters, after the prompt has entered.
 *
 * The row goes first: what the model was given is the fact worth keeping, and
 * the pane is a view of it.
 */
const recordInjection = async ($, plan) => {
    const injected = plan.disposition === "injected";
    const written = await adminCall($, "injection", {
        sessionId: plan.sessionId,
        turnId: plan.turnId,
        retrievalId: plan.retrievalId,
        memoryIds: injected ? plan.chosen.map((entry) => entry.memoryId) : [],
        chars: plan.chars,
        approxTokens: plan.approxTokens,
        capChars: plan.caps.maxChars,
        capEntries: plan.caps.maxEntries,
        dropped: plan.dropped,
        // Nothing is ever cut mid-body, so this column is always zero here; it
        // is written rather than left out so the row says so.
        clippedChars: 0,
        ...(plan.retrievalId === null
            ? {
                  failure: {
                      query: plan.query,
                      reason: plan.reason ?? "the retrieval did not answer",
                      project: plan.project,
                      origin: "prompt",
                      k: plan.caps.k,
                      msTotal: plan.msTotal,
                  },
              }
            : {}),
    });

    await rememberInjection($, plan);
    await bumpSession($, {
        retrievals: plan.retrievalId === null ? 0 : 1,
        injections: 1,
        memoriesInjected: injected ? plan.chosen.length : 0,
        charsInjected: plan.chars,
        approxTokensInjected: plan.approxTokens,
    });

    return written;
};

/** The pane's list: newest first, and short, because it is a view and not the log. */
const rememberInjection = async ($, plan) => {
    const seen = (await safely($, () => $.store.get(INJECTIONS_KEY))) ?? [];
    const entry = {
        at: new Date().toISOString(),
        prompt: promptLine(plan.query),
        retrievalId: plan.retrievalId,
        entries: plan.chosen,
        chars: plan.chars,
        approxTokens: plan.approxTokens,
        dropped: plan.dropped,
        disposition: plan.disposition,
        reason: plan.reason,
    };

    await safely($, () => $.store.set(INJECTIONS_KEY, [entry, ...(Array.isArray(seen) ? seen : [])].slice(0, MAX_PANE_INJECTIONS)));
};

/**
 * Opens the pane the first time something is injected, and only then.
 *
 * Not at `session.start`: a pane that opens before there is anything in it is a
 * plugin taking a third of somebody's terminal to say nothing. Not again after
 * the person closed it, for the same reason in reverse.
 *
 * The open is allowed to fail — headless has no surface, and a narrow terminal
 * holds the open undrawn — and a failure is logged rather than swallowed,
 * because "the pane never appeared" is otherwise unanswerable.
 */
const showPane = async ($) => {
    const state = (await safely($, () => $.store.get(PANE_KEY))) ?? { opened: false, closedByPerson: false };

    if (state.closedByPerson === true) {
        return;
    }

    if (state.opened !== true) {
        try {
            await $.ui.open({ id: PANE_ID, title: PANE_TITLE });
            await safely($, () => $.store.set(PANE_KEY, { opened: true, closedByPerson: false }));
        } catch (error) {
            await safely($, () => $.ui.log(`memory-handoff: the pane would not open: ${String(error).slice(0, 200)}`));

            return;
        }
    }

    await safely($, () => $.ui.invalidate("ui.render"));
};

/** This session's injections, drawn. The tree itself is `hooks/pane.js`. */
const drawMemoryPane = async ($, e) => {
    const elements = $.ui.resolve(e);
    const view = {
        live: await isLive($),
        dbPath: await dbFile($),
        injections: (await safely($, () => $.store.get(INJECTIONS_KEY))) ?? [],
    };

    return paneTree(elements, view, e.props?.bodyColumns ?? e.viewport?.columns);
};

/* ------------------------------------------------------------------- tools */

/**
 * A retrieval the model asked for, traced as `tool` rather than `prompt`.
 *
 * The query goes over stdin for the same reason the prompt's does: a search the
 * model ran on somebody's words has no business in `ps`.
 */
const searchTool = async ($, e) => {
    const project = await projectFor($);

    if (project === null) {
        return { ok: false, reason: "no project key: this session has neither a git remote, a toplevel nor a cwd" };
    }

    const query = typeof e?.query === "string" ? e.query.trim() : "";

    if (query === "") {
        return { ok: false, reason: "memory_search needs a query" };
    }

    const caps = await injectCaps($);
    const argv = [
        "bun",
        `${$.plugin.root}/retrieval/search-cli.js`,
        await dbFile($),
        "--project",
        project,
        "--query-stdin",
        "--k",
        String(wholeNumber(e?.k, caps.k)),
        "--origin",
        "tool",
        "--with-id",
        ...(typeof e?.types === "string" && e.types.trim() !== "" ? ["--types", e.types.trim()] : []),
        ...(Array.isArray(e?.types) && e.types.length > 0 ? ["--types", e.types.join(",")] : []),
    ];
    const ran = await $.process.run(argv, { timeoutMs: TOOL_MS, stdin: query });

    if (ran?.exitCode !== 0) {
        return { ok: false, reason: `the retrieval exited ${ran?.exitCode ?? "(no code)"}: ${(ran?.stderr ?? "").trim().slice(0, 500)}` };
    }

    try {
        return { ok: true, ...JSON.parse(ran.stdout ?? "") };
    } catch (error) {
        return { ok: false, reason: `the retrieval printed no document: ${String(error).slice(0, 200)}` };
    }
};

/** One retrieval's trace, read back from the tables it was written to. */
const explainTool = async ($, e) => {
    const retrievalId = wholeNumber(e?.retrievalId, 0);

    if (retrievalId < 1) {
        return { ok: false, reason: `${JSON.stringify(e?.retrievalId ?? null)} is not a retrieval id` };
    }

    const argv = ["bun", `${$.plugin.root}/retrieval/explain-cli.js`, await dbFile($), String(retrievalId), "--json"];
    const ran = await $.process.run(argv, { timeoutMs: TOOL_MS });

    if (ran?.exitCode !== 0) {
        return { ok: false, reason: `no trace for retrieval ${retrievalId}: ${(ran?.stderr ?? "").trim().slice(0, 500)}` };
    }

    // `--json` prints a formatted document over many lines, so the whole of
    // stdout is the answer here rather than its last line.
    try {
        return { ok: true, ...JSON.parse(ran.stdout ?? "") };
    } catch (error) {
        return { ok: false, reason: `the trace printed no document: ${String(error).slice(0, 200)}` };
    }
};

/** This project's memories, newest first. */
const listTool = async ($, e) =>
    adminCall($, "list", {
        project: await projectFor($),
        limit: e?.limit,
        offset: e?.offset,
        status: e?.status,
    });

/** A memory the person disagrees with: tombstoned, or purged when asked. */
const deleteTool = async ($, e) => adminCall($, "delete", { id: e?.id, purge: e?.purge === true });

/** Every call into `schema/memory-admin.js`, which is every database call but a retrieval. */
const adminCall = async ($, op, doc) => {
    const ran = await $.process.run(["bun", `${$.plugin.root}/schema/memory-admin.js`, await dbFile($), op], {
        stdin: JSON.stringify(doc),
        timeoutMs: TOOL_MS,
    });

    return readAnswer(ran);
};

/* ----------------------------------------------------------------- session */

/**
 * The project key, worked out once and kept.
 *
 * The same `projectKey` the generation path writes with, from the same two git
 * readings, because a retrieval filtered on a key no generation ever wrote is a
 * retrieval that silently returns nothing.
 */
const projectFor = async ($) => {
    const cached = await safely($, () => $.store.get(PROJECT_KEY));

    if (cached !== null && cached !== undefined) {
        return cached.project;
    }

    const cwd = await safely($, () => $.session.cwd());
    const where = await gitFacts($, cwd);
    const keyed = projectKey(where.remoteUrl, where.toplevel, cwd);

    await safely($, () => $.store.set(PROJECT_KEY, keyed));

    return keyed.project;
};

/** This session's running counts, whatever the store holds. */
const sessionCounts = async ($) => {
    const seen = await safely($, () => $.store.get(SESSION_KEY));

    return { ...EMPTY_SESSION, ...(seen ?? {}) };
};

/** Adds to this session's counts. Every field is a total, so every write is a sum. */
const bumpSession = async ($, patch) => {
    const after = await sessionCounts($);

    for (const [key, value] of Object.entries(patch)) {
        after[key] = (after[key] ?? 0) + (Number.isFinite(value) ? value : 0);
    }

    await safely($, () => $.store.set(SESSION_KEY, after));

    return after;
};

/** Where the database is. One spelling, because a second one is a second database. */
const dbFile = async ($) => `${await dataDir($)}/memory.sqlite`;

/**
 * The four injection knobs.
 *
 * Read at every prompt rather than once, so changing one in the environment of
 * a long session is not a restart.
 */
const injectCaps = async ($) => ({
    k: wholeNumber(await $.env.get("MEMORY_HANDOFF_INJECT_K"), DEFAULT_INJECT_K),
    maxEntries: wholeNumber(await $.env.get("MEMORY_HANDOFF_INJECT_MAX_ENTRIES"), DEFAULT_MAX_ENTRIES),
    maxChars: wholeNumber(await $.env.get("MEMORY_HANDOFF_INJECT_MAX_CHARS"), DEFAULT_MAX_CHARS),
    timeoutMs: wholeNumber(await $.env.get("MEMORY_HANDOFF_INJECT_TIMEOUT_MS"), DEFAULT_INJECT_MS),
});

/** What this session's generations may cost. Zero or less is no ceiling at all. */
const sessionBudget = async ($) => {
    const raw = Number.parseFloat(((await $.env.get("MEMORY_HANDOFF_SESSION_BUDGET_USD")) ?? "").trim());
    const budget = Number.isFinite(raw) ? raw : DEFAULT_BUDGET_USD;

    return budget > 0 ? budget : null;
};

const wholeNumber = (value, fallback) => {
    const parsed = Number.parseInt(String(value ?? "").trim(), 10);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * What this session has done, what the store holds, and what it has cost.
 *
 * The spend comes back in three numbers rather than one: what was priced, what
 * the subscription waives, and how many rows carry no price at all. Folding an
 * unpriced row in as zero is the one thing the `costs` table's own CHECK exists
 * to stop, and a status line that undoes it is worse than no line.
 */
const statusReport = async ($) => {
    const rows = await readRows($);
    const seam = await safely($, () => $.store.get(SEAM_KEY));
    const sessionId = await safely($, () => $.session.id());
    const mine = rows.filter((row) => row.sessionId === sessionId);
    const counts = await sessionCounts($);

    return {
        live: await isLive($),
        dir: await dataDir($),
        dbPath: await dbFile($),
        project: await projectFor($),
        seam: seam ?? null,
        rows: rows.length,
        session: {
            id: sessionId ?? null,
            generations: mine.length,
            memoriesWritten: mine.reduce((sum, row) => sum + (row.memoriesWritten ?? 0), 0),
            retrievals: counts.retrievals,
            injections: counts.injections,
            memoriesInjected: counts.memoriesInjected,
            charsInjected: counts.charsInjected,
            approxTokensInjected: counts.approxTokensInjected,
            spendUsd: counts.spendUsd,
            budgetUsd: await sessionBudget($),
        },
        database: (await safely($, () => adminCall($, "counts", {}))) ?? null,
        last: rows.at(-1) ?? null,
    };
};

/** Every row ever written here, oldest first. An unreadable log is no rows. */
const readRows = async ($) => {
    const file = `${await dataDir($)}/index.jsonl`;
    const text = await safely($, () => $.fs.read(file));

    if (typeof text !== "string") {
        return [];
    }

    return text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch {
                return { unparsed: line.slice(0, 200) };
            }
        });
};

/**
 * Appends one row without reading the file first.
 *
 * `$.fs` has no append, and the whole-file rewrite that forces loses rows
 * whenever two sessions compact at once: each reads the same file, appends its
 * own row and writes the other's away. `cat >>` is one append and costs a
 * process.
 */
const appendRow = async ($, record) => {
    const file = `${await dataDir($)}/index.jsonl`;

    await $.process.run(["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat >> "$1"', "memory-handoff", file], {
        stdin: `${JSON.stringify(record)}\n`,
    });
};

/** Which compaction of this session this is, 0-based, for the reply's filename. */
const nextDepth = async ($) => {
    const seen = await safely($, () => $.store.get(DEPTH_KEY));
    const depth = typeof seen === "number" ? seen + 1 : 0;

    await safely($, () => $.store.set(DEPTH_KEY, depth));

    return depth;
};

const registerTools = async ($) => {
    // Registered because the engine will not raise a tool it has never been
    // told about, which is the whole of why this is here rather than hidden.
    // The description is written for the model that will read it in every
    // prompt, and the hook denies anything that is not compact-handoff's raise.
    await $.tool.register({
        name: "before_compact",
        description:
            "Internal to the compact-handoff seam. compact-handoff raises this at compaction; it is not for the " +
            "model, and a call without the seam fields is denied.",
        inputSchema: {
            type: "object",
            properties: { trigger: { type: "string" }, messageCount: { type: "number" } },
            required: ["trigger", "messageCount"],
        },
    });

    await $.tool.register({
        name: "memory_status",
        description:
            "What memory-handoff has done: whether it is live, where its database is, whether it is reading " +
            "compactions through compact-handoff's seam or through its own hook, what this session has " +
            "written, retrieved, injected and spent, and what the whole store holds.",
        inputSchema: { type: "object", properties: {} },
    });

    await $.tool.register({
        name: "memory_search",
        description:
            "Search this project's memories from earlier sessions. Use it when the person refers to something " +
            "decided or discovered before this conversation, or when you want what was already learned about a " +
            "file or a decision. Answers the matching memories with their scores and the id of the trace that " +
            "explains the ranking.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "What to look for, in the person's own words where possible." },
                k: { type: "number", description: "How many memories to return. Five by default." },
                types: {
                    type: "array",
                    items: { type: "string" },
                    description: "Narrow to memory types: user, feedback, project, reference.",
                },
            },
            required: ["query"],
        },
    });

    await $.tool.register({
        name: "memory_explain",
        description:
            "Why one retrieval ranked what it did: its filters, every candidate, and the score each stage gave " +
            "it. Takes the retrieval id that memory_search and the injected memory block carry.",
        inputSchema: {
            type: "object",
            properties: { retrievalId: { type: "number", description: "The id off a search or an injected block." } },
            required: ["retrievalId"],
        },
    });

    await $.tool.register({
        name: "memory_list",
        description:
            "This project's memories, newest first, whether or not they match anything. For reviewing what has " +
            "been remembered; memory_search is what to use when looking for something.",
        inputSchema: {
            type: "object",
            properties: {
                limit: { type: "number", description: "How many to return. Twenty by default, a hundred at most." },
                offset: { type: "number", description: "How many to skip, for the next page." },
                status: {
                    type: "array",
                    items: { type: "string" },
                    description: "Which statuses to include: active (the default), deleted.",
                },
            },
        },
    });

    await $.tool.register({
        name: "memory_delete",
        description:
            "Remove a memory the person disagrees with. It is tombstoned by default, which stops it being " +
            "retrieved while keeping the record that it was written; purge deletes the text outright.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "number", description: "The memory's id, as memory_search and memory_list give it." },
                purge: { type: "boolean", description: "Delete the row rather than tombstone it." },
            },
            required: ["id"],
        },
    });
};

const dataDir = async ($) => {
    const override = ((await $.env.get("MEMORY_HANDOFF_DIR")) ?? "").trim();

    if (override !== "") {
        return override.replace(/\/+$/u, "");
    }

    const home = ((await $.env.get("HOME")) ?? "").trim();

    return home === "" ? `${$.plugin.root}/.runs` : `${home}/.claude/memory-handoff`;
};

const isLive = async ($) => isOn(await $.env.get("MEMORY_HANDOFF_LIVE"));

const isOn = (value) => ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());

/** The plugin's own version, off the manifest the runtime loaded it from. */
const pluginVersion = async ($) => {
    try {
        return JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)).version ?? null;
    } catch {
        return null;
    }
};

/** A reading that is allowed to fail. A missing field beats a lost dispatch. */
const safely = async ($, read) => {
    try {
        return await read();
    } catch {
        return null;
    }
};
