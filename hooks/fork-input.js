/**
 * Whether a fork read this conversation, from what it was charged to read.
 *
 * Copied from compact-handoff's `hooks/lib.js` rather than imported: the two
 * plugins have to work without each other, so the rule lives twice and moves
 * twice. The floor is compact-handoff's; if #690 moves it, both plugins move
 * together and both READMEs say the new number.
 *
 * A reply is no proof. Some forks come back having been charged for a fraction
 * of the session's context (#690) and their answer reads like any other, so the
 * only thing that can tell is the arithmetic below.
 */

import { usageOf } from "./pricing.js";

/**
 * How much of the session's context a fork must have been charged for before
 * its answer is believed.
 *
 * A warm fork is charged for everything the session holds plus the prompt, so
 * it lands at or above the context; the fourteen warm forks measured on this
 * box came in at 1.01 to 1.04 of theirs. A cold one is charged for a prefix:
 * the ten cold ones were 65k to 78k against contexts of 164k to 167k, which is
 * 0.40 to 0.47. A fifth short is far outside the warm spread and far inside the
 * gap between them.
 */
export const FORK_INPUT_FLOOR = 0.8;

/**
 * What a fork was charged to read, beside what the session it forked from holds.
 *
 * `sent` is the whole input the API counted, cached or not, because a warm fork
 * pays for the same tokens at the cache-read rate rather than fewer of them.
 * `matchesContext` is that one comparison and nothing else: null wherever
 * either number is missing, because an unknown is not a mismatch.
 *
 * @param {unknown} usage The fork's own usage, as it came back.
 * @param {{ tokens?: unknown } | null | undefined} context The session's context, as `$.session.usage()` reports it.
 * @returns {{ sent: number | null, cacheRead: number | null, contextTokens: number | null, matchesContext: boolean | null }}
 */
export const forkInputOf = (usage, context) => {
    const tokens = usageOf(usage);
    const sent = tokens === null ? null : tokens.input + tokens.cacheRead + tokens.cacheWrite;
    const contextTokens = typeof context?.tokens === "number" ? context.tokens : null;
    const unknown = sent === null || contextTokens === null || contextTokens <= 0;

    return {
        sent,
        cacheRead: tokens === null ? null : tokens.cacheRead,
        contextTokens,
        matchesContext: unknown ? null : sent >= contextTokens * FORK_INPUT_FLOOR,
    };
};
