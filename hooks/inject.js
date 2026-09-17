/**
 * The pure half of injection: who gets memories, how many fit, and what the
 * block reads like.
 *
 * Nothing here touches `$`, a database or a child process, so every rule below
 * is testable on its own. `hooks/module.js` is the adapter that runs a
 * retrieval, calls these, and writes the row.
 */

/**
 * The two origins that are a person deciding to say something.
 *
 * `composer` is Enter at the terminal as the engine stamped it. `bridge` is the
 * same person through Remote Control, on a phone or the web client, and there
 * is no reason a memory should reach them only when they are at the keyboard.
 *
 * Everything else is something other than a person typing: `sdk` is a headless
 * host's own turn, `task-notification`, `peer`, `peer-send-message`,
 * `scheduled-trigger`, `projects-relay`, `coordinator`, `observer`,
 * `observer-activity`, `channel` and `auto-continuation` are all the engine or
 * another session speaking, and `plugin` is a plugin's own submission.
 *
 * **`unclassified` is deliberately not in this list.** The declaration says a
 * channel the engine cannot attest arrives that way, and a memory injection is
 * the thing you least want to hand to a turn nobody can attribute. The cost of
 * the choice is that a prompt the engine failed to classify gets no memories;
 * the alternative is injecting on a turn the engine itself will not vouch for.
 */
export const INJECT_ORIGINS = ["composer", "bridge"];

/** The block's first line, which is also how the model is told where this came from. */
export const headerFor = (retrievalId) =>
    `Memories from earlier sessions (memory-handoff, retrieval ${retrievalId})`;

/**
 * Whether this submission gets memories, and why not when it does not.
 *
 * The reason is kept rather than discarded because "nothing was injected" and
 * "nothing was injected because a peer session sent this" are different
 * answers, and only one of them is a bug.
 *
 * @param {{ text?: unknown, turnId?: unknown, origin?: { kind?: unknown } }} e
 * @returns {{ inject: true, query: string, kind: string } | { inject: false, reason: string, kind: string | null }}
 */
export const injectionGate = (e) => {
    const kind = typeof e?.origin?.kind === "string" ? e.origin.kind : null;

    if (kind === null) {
        return { inject: false, reason: "the submission carried no origin", kind: null };
    }

    if (!INJECT_ORIGINS.includes(kind)) {
        return { inject: false, reason: `origin ${kind} is not a person submitting a prompt`, kind };
    }

    // A prompt with a turn id was delivered into a turn that was already
    // running: queued, notified or relayed, never Enter on an idle session.
    if (typeof e?.turnId === "string" && e.turnId !== "") {
        return { inject: false, reason: "the prompt was delivered into a running turn", kind };
    }

    const query = typeof e?.text === "string" ? e.text.trim() : "";

    // Attachments arrive with a prompt that can be empty text, and an empty
    // query retrieves nothing anyway.
    if (query === "") {
        return { inject: false, reason: "the prompt has no text to retrieve on", kind };
    }

    return { inject: true, query, kind };
};

/**
 * The block, and what it cost, under both caps.
 *
 * Whole memories are dropped, lowest-ranked first, and nothing is ever cut
 * mid-body: half a memory reads as a memory and is one the model cannot check.
 * That is why `clipped_chars` on the row is always zero — the column is the
 * schema's, and this implementation has no path that clips.
 *
 * @param {{ memoryId: number, title: string, body: string, scores?: object }[]} results Rank order, best first.
 * @param {{ maxEntries: number, maxChars: number }} caps
 * @param {number | string} retrievalId
 */
export const composeInjection = (results, caps, retrievalId) => {
    const ranked = Array.isArray(results) ? results : [];
    const wanted = ranked.slice(0, Math.max(0, caps.maxEntries));

    /** @type {{ memoryId: number, title: string, body: string, scores?: object }[]} */
    let entries = [];
    let block = null;

    for (const result of wanted) {
        const candidate = [...entries, result];
        const text = blockText(retrievalId, candidate);

        if (text.length > caps.maxChars) {
            break;
        }

        entries = candidate;
        block = text;
    }

    const chars = block === null ? 0 : block.length;

    return {
        entries,
        block,
        chars,
        // Named an estimate everywhere it is recorded: four characters to a
        // token is a rule of thumb, not this tokenizer.
        approxTokens: Math.ceil(chars / 4),
        dropped: ranked.length - entries.length,
        clippedChars: 0,
    };
};

/** The whole context block: one header, then the memories numbered from one. */
export const blockText = (retrievalId, entries) =>
    [headerFor(retrievalId), ...entries.map((entry, index) => entryText(index + 1, entry))].join("\n\n");

const entryText = (number, entry) =>
    [`${number}. ${oneLine(entry.title)}`, ...String(entry.body ?? "").split("\n").map((line) => `   ${line}`)].join("\n");

const oneLine = (text) => String(text ?? "").replace(/\s+/gu, " ").trim();

/**
 * The prompt as the pane lists it: one line, cut with an ellipsis rather than
 * silently, so a truncated prompt is visibly truncated.
 */
export const promptLine = (text, columns = 60) => {
    const line = oneLine(text);

    return line.length <= columns ? line : `${line.slice(0, Math.max(1, columns - 1))}…`;
};

/**
 * The score the pane and the row report for a memory: the reranker's when the
 * reranker ran, the merge score when it did not.
 *
 * Reporting a merge score as if it were a rerank score is how a degraded
 * retrieval stops looking degraded.
 */
export const finalScoreOf = (entry) => {
    const scores = entry?.scores ?? {};
    const rerank = typeof scores.rerank === "number" ? scores.rerank : null;

    return rerank === null
        ? { score: typeof scores.merge === "number" ? scores.merge : null, kind: "merge" }
        : { score: rerank, kind: "rerank" };
};
