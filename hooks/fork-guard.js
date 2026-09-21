/**
 * Whether a compaction the engine is about to run belongs to this plugin's own
 * fork, from the two things that can tell: what the dispatch carries, and
 * whether a fork was in flight when it arrived.
 *
 * A memory fork copies a conversation that has just tripped auto-compaction and
 * appends a prompt to it. The copy is therefore also over the threshold, the
 * engine compacts it, and the fork answers over a summary of this conversation
 * rather than this conversation. #690 measured the result and refused it after
 * the spend; this is the reading that lets it be refused before.
 */

/**
 * The verdicts `nestedForkCompaction` returns.
 *
 * `own` is a compaction of a fork this plugin is waiting on right now, and the
 * only one it refuses. `late` carries an `agentId` and arrived while a fork was
 * in flight but past the window, so it is handed on and counted: a session
 * accumulating these is the reading that says the window is too tight. `other`
 * is every genuine subagent compaction, which must go through untouched.
 */
export const OWN = "own";
export const LATE = "late";
export const OTHER = "other";

/**
 * Reads one `session.compact` dispatch against the fork guard.
 *
 * `agentId` is the engine's own word for "this transcript is a subagent's or a
 * fork's, not the main conversation", so its absence settles the question on
 * its own: the main conversation's compaction is never this plugin's fork.
 *
 * @param {{ since: number | null }} guard The session's fork guard.
 * @param {{ agentId?: unknown } | null | undefined} event The dispatch, as it arrived.
 * @param {number} now The clock, in epoch milliseconds.
 * @param {number} windowMs How long after a fork starts a nested compaction is read as its own.
 * @returns {typeof OWN | typeof LATE | typeof OTHER}
 */
export const nestedForkCompaction = (guard, event, now, windowMs) => {
    const isNested = typeof event?.agentId === "string" && event.agentId !== "";
    const since = typeof guard?.since === "number" ? guard.since : null;

    if (!isNested || since === null) {
        return OTHER;
    }

    return now - since <= windowMs ? OWN : LATE;
};
