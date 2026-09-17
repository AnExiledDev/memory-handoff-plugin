/**
 * The pure half of the writer: which project a memory belongs to, and what the
 * three tables' rows look like.
 *
 * Nothing here opens a database or reads the filesystem, so every rule below is
 * testable without one. `schema/write-generation.js` is the adapter that runs
 * these against `bun:sqlite` inside a transaction.
 */

import { COST_BASIS, PRICES_TAKEN, priceUsage } from "../hooks/pricing.js";

/** The schema's own caps, which the writer clips to rather than failing on. */
export const TITLE_CAP = 200;

export const BODY_CAP = 4000;

/**
 * Which project a compaction's memories belong to: the git remote, normalised,
 * then the git toplevel path, then the cwd.
 *
 * `git@host:owner/repo.git` and `https://host/owner/repo(.git)` both become
 * `host/owner/repo`, lowercase host, no trailing `.git`, so a worktree under
 * `.claude/worktrees/x` shares the key with the primary checkout it was made
 * from. That is the point: one repository is one project however many worktrees
 * of it are open.
 *
 * `null` when there is nothing at all to key on. The empty string is refused by
 * the schema, and a writer that shrugged and inserted one would put every
 * unkeyed memory in the same bucket.
 *
 * @param {string | null | undefined} remoteUrl
 * @param {string | null | undefined} toplevel
 * @param {string | null | undefined} cwd
 * @returns {{ project: string | null, projectKind: "remote" | "toplevel" | "cwd" | null }}
 */
export const projectKey = (remoteUrl, toplevel, cwd) => {
    const remote = normaliseRemote(remoteUrl);

    if (remote !== null) {
        return { project: remote, projectKind: "remote" };
    }

    const root = trimmed(toplevel);

    if (root !== "") {
        return { project: root, projectKind: "toplevel" };
    }

    const here = trimmed(cwd);

    return here === "" ? { project: null, projectKind: null } : { project: here, projectKind: "cwd" };
};

/** A remote URL as `host/owner/repo`, or null when it is not one. */
export const normaliseRemote = (url) => {
    const raw = trimmed(url);

    if (raw === "") {
        return null;
    }

    // `git@host:owner/repo.git`, the scp-like spelling, which is not a URL and
    // so cannot be handed to a URL parser.
    const scp = /^[^@/]+@([^:/]+):(.+)$/u.exec(raw);
    const [host, path] = scp !== null ? [scp[1], scp[2]] : hostAndPathOf(raw);

    if (host === null || path === null) {
        return null;
    }

    const cleaned = path.replace(/^\/+/u, "").replace(/\/+$/u, "").replace(/\.git$/u, "");

    return cleaned === "" ? null : `${host.toLowerCase()}/${cleaned}`;
};

/** @returns {[string, string] | [null, null]} */
const hostAndPathOf = (raw) => {
    try {
        const url = new URL(raw);

        return url.hostname === "" ? [null, null] : [url.hostname, url.pathname];
    } catch {
        return [null, null];
    }
};

/**
 * One parsed memory as the `memories` table takes it.
 *
 * Clipping rather than refusing, and the original length recorded in `source`,
 * so a memory that was cut says it was cut instead of looking like a short one.
 * The parser already refuses anything over these caps; this is the same rule at
 * the process boundary, where the JSON on stdin could have come from anywhere.
 *
 * @param {object} options
 * @param {{ type: string, title: string, body: string, importance: number, supersedesHint?: string | null }} options.row
 * @param {string} options.project
 * @param {string} options.uuid
 * @param {string} options.now
 * @param {object} options.source
 */
export const memoryRow = ({ row, project, uuid, now, source }) => {
    const title = clip(row.title, TITLE_CAP);
    const body = clip(row.body, BODY_CAP);
    const clipped = {
        ...(title.clippedFrom === null ? {} : { title: title.clippedFrom }),
        ...(body.clippedFrom === null ? {} : { body: body.clippedFrom }),
    };

    return {
        uuid,
        project,
        type: row.type,
        title: title.text,
        body: body.text,
        importance: row.importance,
        status: "active",
        supersedes: null,
        source: JSON.stringify({
            ...source,
            ...(row.supersedesHint ? { supersedesHint: row.supersedesHint } : {}),
            ...(Object.keys(clipped).length === 0 ? {} : { clipped }),
        }),
        created_at: now,
        updated_at: now,
    };
};

const clip = (text, cap) => {
    const value = typeof text === "string" ? text : "";

    return value.length <= cap ? { text: value, clippedFrom: null } : { text: value.slice(0, cap), clippedFrom: value.length };
};

/**
 * One attempt at a generation, whatever came of it.
 *
 * `hit_output_cap` is a flag and the schema has no column for why, so the reason
 * rides in `outcome_reason` when nothing else claimed it. Losing the difference
 * between a reply that ran out of room and one whose last row was cut in half
 * would cost the next version the only signal it has about the fork's ceiling.
 */
export const generationRow = (generation, project, costId) => {
    const hitCap = generation.hitCap ?? null;
    const reason = generation.outcomeReason ?? (hitCap === null ? null : `hit output cap: ${hitCap}`);

    return {
        at: generation.at,
        session_id: generation.sessionId ?? null,
        compaction_n: numberOr(generation.compactionN),
        trigger: generation.trigger ?? null,
        agent_id: generation.agentId ?? null,
        project,
        messages_in: numberOr(generation.messagesIn),
        transcript_chars: numberOr(generation.transcriptChars),
        outcome: generation.outcome,
        outcome_reason: reason,
        memories_written: generation.memoriesWritten ?? 0,
        parsed_rows: numberOr(generation.parsedRows),
        rejected_rows: numberOr(generation.rejectedRows),
        hit_output_cap: hitCap === null ? 0 : 1,
        elapsed_ms: numberOr(generation.elapsedMs),
        cost_id: costId,
        plugin: generation.plugin ?? null,
        engine: generation.engine ?? null,
    };
};

/**
 * What the generation call cost, in the shape the `costs` table takes.
 *
 * Three legitimate answers and the CHECK keeps them apart: a price, an unknown
 * (`usd` NULL with `cost_unknown_reason`), and a real zero (a pass that made no
 * model call, `usd` 0 with a `cost_note` saying which kind of nothing it was).
 * A silent zero is the one thing this cannot produce.
 *
 * @param {object} options
 * @param {string} options.at
 * @param {string | null} options.model
 * @param {unknown} options.usage
 * @param {string | null} [options.note] Set when no model call was made at all.
 */
export const costRow = ({ at, model, usage, note = null }) => {
    const blank = {
        at,
        kind: "generation",
        model: model ?? null,
        usd: null,
        cache_read_waived_usd: null,
        input_tokens: null,
        output_tokens: null,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        basis: COST_BASIS,
        priced: null,
        prices_taken: PRICES_TAKEN,
        cost_unknown_reason: null,
        cost_note: null,
    };

    if (note !== null) {
        return { ...blank, usd: 0, basis: "no model call", cost_note: note };
    }

    const priced = priceUsage(usage, model);
    const tokens = priced.tokens === null
        ? {}
        : {
            input_tokens: priced.tokens.input,
            output_tokens: priced.tokens.output,
            cache_read_input_tokens: priced.tokens.cacheRead,
            cache_creation_input_tokens: priced.tokens.cacheWrite,
        };

    if (priced.usd === null) {
        return { ...blank, ...tokens, cost_unknown_reason: priced.reason };
    }

    return {
        ...blank,
        ...tokens,
        usd: priced.usd,
        cache_read_waived_usd: priced.cacheReadWaivedUsd,
        priced: priced.priced,
        // A priced call that worked out to nothing is still a real zero, and the
        // CHECK wants it said out loud rather than inferred.
        cost_note: priced.usd === 0 ? "priced at zero: the fork reported no billable tokens" : null,
    };
};

const numberOr = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null);

const trimmed = (value) => (typeof value === "string" ? value.trim() : "");
