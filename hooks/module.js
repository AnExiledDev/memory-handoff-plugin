/**
 * memory-handoff: the conversation a compaction throws away, read once for
 * anything worth remembering later.
 *
 * This is the skeleton. It forks the session at compaction time, asks the fork
 * a placeholder extraction question, and writes what came back plus what it
 * cost. Nothing is stored in SQLite, nothing is retrieved and nothing is
 * injected yet; that is AnExiledDev/claude-investigations #680 to #683.
 *
 * Two rules shape everything below.
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
 */

/**
 * The extraction question, and a placeholder until #682 writes the real one.
 *
 * It asks for JSON so the row can carry a count today and the parser has
 * something to sharpen against later. A fork that answers prose is still
 * stored whole; only `candidates` goes null.
 */
const EXTRACTION_PROMPT = `Read back over this conversation and list what would be worth remembering in a later session about this project: decisions that were made and why, constraints and preferences the person stated, and gotchas that cost time.

Skip anything already obvious from reading the repository, and skip the state of the task you are in the middle of.

Answer with JSON and nothing else, in this shape:

{"memories":[{"text":"one self-contained sentence","type":"decision|preference|fact|gotcha","importance":1}]}

importance runs 1 (minor) to 5 (would waste an hour to rediscover). Ten memories is plenty; fewer is fine, and an empty list is a legitimate answer.`;

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

/**
 * Three environment variables steer this, and the static scan will only take
 * them spelled out at the call site, so they are named here and nowhere else:
 *
 * - `MEMORY_HANDOFF_LIVE` off, it rehearses: it writes a row saying what it
 *   would have done and spends nothing.
 * - `MEMORY_HANDOFF_DIR` where the rows and replies are kept.
 * - `MEMORY_HANDOFF_MODEL` recorded on the row as the model that was asked for.
 *   `$.model.fork` takes `{ prompt }` and nothing else, so it steers no call
 *   yet; #681 is where it starts meaning something.
 */
export const register = (on) => {
    on("session.start", async ($, e, next) => {
        await safely($, () => registerTools($));
        await safely($, () => subscribeToSeam($));

        return next(e);
    });

    on("tool.call", { tool: "mcp__memory-handoff__memory_status" }, async ($) => {
        return { result: JSON.stringify(await statusReport($), null, 2) };
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
    // nothing here spends on it. It is handed on rather than declined: this
    // plugin answers no compaction, and a `{ skip }` from here would change how
    // the engine compacts for someone who installed a memory plugin.
    on("session.compact", { trigger: "precompute" }, async ($, e, next) => {
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

    try {
        const reply = await $.model.fork({ prompt: EXTRACTION_PROMPT });

        if (reply === null || reply === undefined) {
            return finish($, record, "cold", startedAt);
        }

        const text = typeof reply.text === "string" ? reply.text : "";

        record.usage = reply.usage ?? null;
        record.replyChars = text.length;
        record.candidates = countMemories(text);
        record.replyFile = await safely($, () => storeReply($, record, text));

        return finish($, record, text.trim() === "" ? "empty" : "extracted", startedAt);
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
        modelRequested: await modelAlias($),
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
        candidates: null,
        replyFile: null,
        elapsedMs: null,
    };
};

/** Stamps the outcome and the clock on the row, appends it, and hands it back. */
const finish = async ($, record, outcome, startedAt) => {
    record.outcome = outcome;

    // `$.clock.now()` answers a Promise at 2.1.273 against a declaration that
    // says `number`, so every duration here is `Date.now()`.
    record.elapsedMs = Date.now() - startedAt;

    await safely($, () => appendRow($, record));

    return record;
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
                prompt: EXTRACTION_PROMPT,
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
 * How many memories the fork named, or null when its answer was not the JSON
 * that was asked for. A count that cannot be read is never a zero, because a
 * zero is a real answer here.
 */
const countMemories = (text) => {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start === -1 || end <= start) {
        return null;
    }

    try {
        const parsed = JSON.parse(text.slice(start, end + 1));

        return Array.isArray(parsed?.memories) ? parsed.memories.length : null;
    } catch {
        return null;
    }
};

/** What this session has done, for the tool and for a human reading the log. */
const statusReport = async ($) => {
    const rows = await readRows($);
    const seam = await safely($, () => $.store.get(SEAM_KEY));

    return {
        live: await isLive($),
        dir: await dataDir($),
        seam: seam ?? null,
        rows: rows.length,
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
            "What memory-handoff has done: whether it is live, where its data lives, whether it is reading " +
            "compactions through compact-handoff's seam or through its own hook, how many generations have " +
            "been recorded, and the whole of the most recent row.",
        inputSchema: { type: "object", properties: {} },
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

const modelAlias = async ($) => {
    const alias = ((await $.env.get("MEMORY_HANDOFF_MODEL")) ?? "").trim();

    return alias === "" ? null : alias;
};

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
