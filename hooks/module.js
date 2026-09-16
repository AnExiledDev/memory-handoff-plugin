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
 * sees the event at all. It offers a seam instead: `$.compactHandoff.beforeCompact`
 * fires with the same pre-compaction transcript, beside its own fork. When that
 * seam is there this module subscribes at `session.start` and its own
 * `session.compact` hook forks nothing, so the two installs together still pay
 * for one memory fork. When the seam is absent the hook does the fork itself.
 * The row says which path carried it, `via: "seam"` or `via: "hook"`.
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

        await safely($, () => generate($, e, "hook"));

        return next(e);
    });
};

/**
 * Subscribes to compact-handoff when it is there, and records either way.
 *
 * The check is the one the contract names, `typeof $.compactHandoff?.beforeCompact`,
 * and it runs at `session.start` because that is the first event after the
 * `engine.create` fold that adds the noun.
 */
const subscribeToSeam = async ($) => {
    const seam = $.compactHandoff;

    if (typeof seam?.beforeCompact !== "function") {
        await $.store.set(SEAM_KEY, { present: false, at: Date.now() });

        return;
    }

    seam.beforeCompact((event) => generate($, event, "seam"), { name: "memory-handoff" });

    await $.store.set(SEAM_KEY, { present: true, version: seam.version ?? null, at: Date.now() });
};

/**
 * One compaction, read for memories and written down.
 *
 * Every step that can throw is wrapped, and the row is appended on every path,
 * including the paths that spent nothing. A generation that fails is a row with
 * an outcome on it.
 */
const generate = async ($, e, via) => {
    const startedAt = Date.now();
    const usage = await safely($, () => $.session.usage());
    const record = {
        at: new Date().toISOString(),
        n: await nextDepth($),
        via,
        live: await isLive($),
        sessionId: await safely($, () => $.session.id()),
        cwd: await safely($, () => $.session.cwd()),
        model: await safely($, () => $.session.model()),
        modelRequested: await modelAlias($),
        trigger: e?.trigger ?? null,
        agentId: e?.agentId ?? null,
        messagesIn: Array.isArray(e?.messages) ? e.messages.length : null,
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
