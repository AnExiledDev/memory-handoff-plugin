/**
 * The client the plugin uses, and the reason it takes its fetch as an argument.
 *
 * Inside a hook there is no `fetch`: the sandbox has `$.http.fetch`, which
 * answers `{ status, ok, headers, text }` and has no `.json`. Outside one there
 * is `fetch`, which answers a `Response`. So this file takes the narrow thing
 * both can be reduced to, `fetchText(url, init) -> { status, ok, text }`, and
 * holds no reference to either. `bunFetchText` below is the outside-a-hook
 * adapter; the hook passes its own three-line wrapper over `$.http.fetch` when
 * #683 wires this in.
 *
 * **Nothing here throws.** A daemon that is not running, a daemon that is
 * running without weights, a body that is not JSON and a socket that dies
 * mid-read all come back as `{ ok: false, reason }` or `{ ready: false,
 * reason }`. Retrieval degrades to FTS5-only on any of them, and a compaction
 * that cannot embed stores the memory without a vector; neither is allowed to
 * be an exception somebody forgot to catch.
 */

import { DEFAULT_PORT } from "./serve.js";

/**
 * @typedef {object} FetchTextResult
 * @property {number} status
 * @property {boolean} ok
 * @property {string} text
 */

/**
 * @typedef {(url: string, init?: { method?: string, headers?: Record<string, string>, body?: string }) => Promise<FetchTextResult>} FetchText
 */

/** How long a call waits before it decides the daemon is not answering. */
export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * @param {{ fetchText: FetchText, port?: number, host?: string, timeoutMs?: number }} options
 */
export const createClient = (options) => {
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? DEFAULT_PORT;
    const base = `http://${host}:${port}`;

    /**
     * @param {string} path
     * @param {unknown} body
     * @returns {Promise<{ ok: true, value: any } | { ok: false, reason: string }>}
     */
    const post = async (path, body) => {
        let answer;

        try {
            answer = await options.fetchText(`${base}${path}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });
        } catch (error) {
            return { ok: false, reason: unreachable(error, base) };
        }

        return parse(answer, path);
    };

    return {
        url: base,

        /**
         * @param {string[]} texts
         * @param {{ kind?: "query" | "document" }} [init]
         * @returns {Promise<{ ok: true, vectors: number[][], dim: number, model: string, ms: number, truncated: boolean[] } | { ok: false, reason: string }>}
         */
        embed: async (texts, init = {}) => {
            const answer = await post("/embed", { texts, kind: init.kind ?? "document" });

            return answer.ok ? answer.value : answer;
        },

        /**
         * @param {string} query
         * @param {string[]} docs
         * @returns {Promise<{ ok: true, scores: number[], model: string, ms: number, truncated: boolean[] } | { ok: false, reason: string }>}
         */
        rerank: async (query, docs) => {
            const answer = await post("/rerank", { query, docs });

            return answer.ok ? answer.value : answer;
        },

        /**
         * The reading a caller degrades on. A daemon that is not running is
         * `ready: false` with the reason, never a thrown connection error.
         *
         * @returns {Promise<{ ready: boolean, models: string[], rss_bytes: number, reason?: string }>}
         */
        health: async () => {
            let answer;

            try {
                answer = await options.fetchText(`${base}/health`);
            } catch (error) {
                return { ready: false, models: [], rss_bytes: 0, reason: unreachable(error, base) };
            }

            const parsed = parse(answer, "/health");

            if (!parsed.ok) {
                return { ready: false, models: [], rss_bytes: 0, reason: parsed.reason };
            }

            return parsed.value;
        },
    };
};

/**
 * `fetch` reduced to the three fields `$.http.fetch` also answers with, so the
 * client above is the same code in both environments.
 *
 * @type {FetchText}
 */
export const bunFetchText = async (url, init = {}) => {
    const response = await fetch(url, {
        method: init.method ?? "GET",
        headers: init.headers,
        body: init.body,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    return { status: response.status, ok: response.ok, text: await response.text() };
};

/**
 * @param {FetchTextResult} answer
 * @param {string} path
 * @returns {{ ok: true, value: any } | { ok: false, reason: string }}
 */
const parse = (answer, path) => {
    let value;

    try {
        value = JSON.parse(answer.text);
    } catch {
        return { ok: false, reason: `runtime answered ${answer.status} on ${path} with something that is not JSON` };
    }

    if (value === null || typeof value !== "object") {
        return { ok: false, reason: `runtime answered ${answer.status} on ${path} with a ${typeof value}` };
    }

    // A 503 carrying `{ ok: false, reason }` is the runtime saying it cannot
    // serve this call, which is a value and not a transport failure.
    if (!answer.ok && typeof value.reason !== "string") {
        return { ok: false, reason: `runtime answered ${answer.status} on ${path}` };
    }

    return { ok: true, value };
};

/** @param {unknown} error @param {string} base @returns {string} */
const unreachable = (error, base) =>
    `runtime unreachable at ${base}: ${error instanceof Error ? error.message : String(error)}`;
