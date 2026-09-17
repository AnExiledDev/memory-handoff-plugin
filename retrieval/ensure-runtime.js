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
 * up and lets retrieval degrade to FTS5-only. **It never blocks the prompt**,
 * and it is never the thing that turns a slow model load into a hung session.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** How long a start is given before retrieval goes on without it. */
export const READY_TIMEOUT_MS = 5000;

/** How often `/health` is asked during that window. */
export const POLL_MS = 250;

/** `bun runtime/serve.js`, resolved from this file so the cwd cannot change what gets started. */
export const servePath = () => join(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "serve.js");

/**
 * @typedef {object} EnsureResult
 * @property {boolean} ready
 * @property {boolean} started True when this call spawned a daemon, whether or not it came up in time.
 * @property {string} [reason] Why it is not ready. Always set when `ready` is false.
 */

/**
 * Health, then a start, then a bounded wait.
 *
 * @param {{ client: { health: () => Promise<{ ready: boolean, reason?: string }> }, spawn?: () => void, sleep?: (ms: number) => Promise<void>, now?: () => number, timeoutMs?: number, pollMs?: number }} options
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
 * stdio is ignored on all three descriptors and the handle is unref'd, so the
 * daemon outlives this process and nothing downstream inherits a pipe that
 * would keep an event loop alive. Its own logs go nowhere by design: `/health`
 * is the interface, and a daemon writing into a session's stdout would land in
 * the middle of a prompt.
 *
 * @returns {void}
 */
export const spawnDaemon = () => {
    const child = Bun.spawn(["bun", servePath()], {
        stdio: ["ignore", "ignore", "ignore"],
        env: process.env,
    });

    child.unref();
};

/** @param {unknown} error @returns {string} */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));
