/**
 * Starting the daemon, which is retrieval's job and nobody else's.
 *
 * #681 built `bun runtime/serve.js` and deliberately left nothing starting it.
 * The retrieval entry point is where that belongs: it is the first caller that
 * needs a vector, it already knows how to run without one, and a daemon started
 * anywhere else would be a model server left resident on a box that has been
 * OOM-swept once. The daemon exits by itself when idle, so the worst case of
 * starting one here is half an hour of a sleeping process.
 *
 * The bound is the point. A retrieval runs while a user waits for a prompt to
 * go out, so this waits a few seconds for the weights to come up and then gives
 * up and lets retrieval degrade to FTS5-only.
 *
 * **This bounds the start and nothing else.** `/health` answers `ready: true`
 * while the ONNX sessions are still loading — it checks that a load was begun,
 * not that it finished — so a daemon can pass this and then sit on an `/embed`
 * for as long as the load takes. The call timeouts in `search.js` are the other
 * half of the bound, and the honest guarantee is the sum of the three: this
 * window, plus the embed timeout, plus the rerank timeout.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnDetached } from "../runtime/detach.js";
import { defaultDbPath } from "../schema/bun-sqlite.js";

/** How long a start is given before retrieval goes on without it. */
export const READY_TIMEOUT_MS = 5000;

/** How often `/health` is asked during that window. */
export const POLL_MS = 250;

/**
 * How long a failed start suppresses the next one.
 *
 * Without it, a port 8794 that is wedged — something else listening, or a
 * daemon that came up without weights — costs a fresh detached process **and**
 * the full wait on every single retrieval, forever. One attempt a minute is
 * enough to recover from a daemon that died and cheap enough that a permanently
 * broken port costs a stat() per search.
 */
export const AUTOSTART_COOLDOWN_MS = 60_000;

/** Where the attempt is stamped when a caller does not say. Beside the database, which is where this plugin's state lives. */
export const defaultStampPath = () => `${defaultDbPath()}.autostart`;

/** `bun runtime/serve.js`, resolved from this file so the cwd cannot change what gets started. */
export const servePath = () => join(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "serve.js");

/**
 * @typedef {object} EnsureResult
 * @property {boolean} ready
 * @property {boolean} started True when this call spawned a daemon, whether or not it came up in time.
 * @property {string} [reason] Why it is not ready. Always set when `ready` is false.
 */

/**
 * Health, then the cooldown, then a start, then a bounded wait.
 *
 * @param {{ client: { health: () => Promise<{ ready: boolean, reason?: string }> }, spawn?: () => void, sleep?: (ms: number) => Promise<void>, now?: () => number, timeoutMs?: number, pollMs?: number, cooldownMs?: number, stampPath?: string, readStamp?: () => number | null, writeStamp?: (at: number) => void }} options
 * @returns {Promise<EnsureResult>}
 */
export const ensureRuntime = async (options) => {
    const first = await options.client.health();

    if (first.ready) {
        return { ready: true, started: false };
    }

    // Weights that are not on disk are not something a restart fixes, and
    // spawning a daemon to watch it say so again is a wasted process.
    if (/weights missing/iu.test(first.reason ?? "")) {
        return { ready: false, started: false, reason: first.reason ?? "weights missing" };
    }

    const spawn = options.spawn ?? spawnDaemon;
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const now = options.now ?? (() => Date.now());
    const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS;
    const pollMs = options.pollMs ?? POLL_MS;
    const cooldownMs = options.cooldownMs ?? AUTOSTART_COOLDOWN_MS;
    const readStamp = options.readStamp ?? (() => readStampFile(options.stampPath ?? defaultStampPath()));
    const writeStamp = options.writeStamp ?? ((at) => writeStampFile(options.stampPath ?? defaultStampPath(), at));
    const attemptedAt = readStamp();

    // A recent attempt that did not produce a working daemon means the port is
    // wedged or the daemon is dying on start. Spawning again and waiting again
    // costs the caller the whole window for the same answer.
    if (attemptedAt !== null && now() - attemptedAt < cooldownMs) {
        const ago = Math.round((now() - attemptedAt) / 1000);

        return { ready: false, started: false, reason: `runtime: autostart attempted ${ago}s ago, not ready` };
    }

    writeStamp(now());

    try {
        spawn();
    } catch (error) {
        return { ready: false, started: false, reason: `could not start the runtime: ${messageOf(error)}` };
    }

    const deadline = now() + timeoutMs;
    let last = first.reason ?? "the runtime was not ready";

    while (now() < deadline) {
        await sleep(pollMs);

        const health = await options.client.health();

        if (health.ready) {
            return { ready: true, started: true };
        }

        last = health.reason ?? last;
    }

    return { ready: false, started: true, reason: `the runtime did not come up within ${timeoutMs} ms: ${last}` };
};

/**
 * The detached start.
 *
 * Own session, stdio ignored on all three descriptors, handle unref'd: the
 * daemon outlives this process and the terminal this process ran under (see
 * `runtime/detach.js` for why the session matters), and nothing downstream
 * inherits a pipe that would keep an event loop alive. Its own logs go nowhere
 * by design: `/health` is the interface, and a daemon writing into a session's
 * stdout would land in the middle of a prompt.
 *
 * @returns {void}
 */
export const spawnDaemon = () => spawnDetached(["bun", servePath()]);

/**
 * The cooldown stamp, read and written fail-soft.
 *
 * A stamp that cannot be read is no cooldown and a stamp that cannot be written
 * is a cooldown that does not happen: both are worse than the alternative, and
 * neither is worth failing a retrieval over.
 *
 * @param {string} path
 * @returns {number | null}
 */
const readStampFile = (path) => {
    try {
        const at = Number.parseInt(readFileSync(path, "utf8").trim(), 10);

        return Number.isFinite(at) ? at : null;
    } catch {
        return null;
    }
};

/** @param {string} path @param {number} at @returns {void} */
const writeStampFile = (path, at) => {
    try {
        writeFileSync(path, `${at}\n`);
    } catch {
        // See readStampFile: a cooldown we cannot record is not an error.
    }
};

/** @param {unknown} error @returns {string} */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));
