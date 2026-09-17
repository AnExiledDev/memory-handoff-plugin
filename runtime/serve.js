/**
 * The loopback daemon: `bun runtime/serve.js`.
 *
 * One adapter over `infer.js`, and the shape the plugin talks to. Three things
 * about it are deliberate.
 *
 * **127.0.0.1 and nothing else.** There is no authentication here and there is
 * not going to be any; the closed port is the whole of the security model, the
 * way the changelog bot on this box publishes 8792 on loopback only.
 *
 * **It exits when it is idle.** This box has 7.9 GB of RAM and has been
 * OOM-swept once, taking cron down for eight hours. A model server that stays
 * resident forever after one compaction is exactly the wrong thing to leave on
 * it, so the timer is reset by every call and the process ends quietly after
 * `MEMORY_HANDOFF_RUNTIME_IDLE_MS`.
 *
 * **It answers before it is ready.** The listen happens first and the load
 * runs behind it, so `/health` can say `ready: false, reason` to a caller that
 * then degrades, rather than the caller seeing a connection refused and having
 * to guess whether the weights are missing or the port is wrong.
 */

import { createRuntime, defaultModelsDir } from "./infer.js";

/** The changelog bot already holds 8792 on this box; 8794 leaves it alone. */
export const DEFAULT_PORT = 8794;

/** Thirty minutes. Long enough to cover a working session, short enough that a forgotten daemon is not a leak. */
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;

/**
 * @param {Record<string, string | undefined>} [vars]
 * @returns {{ port: number, idleMs: number, modelsDir: string, device: "cpu" | "wasm" }}
 */
export const readConfig = (vars = process.env) => ({
    port: positive(vars.MEMORY_HANDOFF_RUNTIME_PORT) ?? DEFAULT_PORT,
    idleMs: positive(vars.MEMORY_HANDOFF_RUNTIME_IDLE_MS) ?? DEFAULT_IDLE_MS,
    modelsDir: defaultModelsDir(vars),
    device: vars.MEMORY_HANDOFF_RUNTIME_DEVICE === "wasm" ? "wasm" : "cpu",
});

/**
 * Starts the daemon and answers the handle, so a test can stop it.
 *
 * @param {{ port?: number, idleMs?: number, modelsDir?: string, device?: "cpu" | "wasm", onIdle?: () => void }} [options]
 */
export const serve = (options = {}) => {
    const config = { ...readConfig(), ...options };
    const runtime = createRuntime({ modelsDir: config.modelsDir, device: config.device });
    const startedAt = Date.now();

    let idleTimer = setTimeout(() => stop(), config.idleMs);

    const touch = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => stop(), config.idleMs);
    };

    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: config.port,
        fetch: async (request) => {
            touch();

            return await route(request, runtime, { startedAt, idleMs: config.idleMs, stop });
        },
    });

    function stop() {
        clearTimeout(idleTimer);
        server.stop(true);
    }

    return { server, runtime, url: `http://127.0.0.1:${server.port}`, stop };
};

/**
 * @param {Request} request
 * @param {ReturnType<typeof createRuntime>} runtime
 * @param {{ startedAt: number, idleMs: number, stop: () => void }} lifecycle
 * @returns {Promise<Response>}
 */
const route = async (request, runtime, lifecycle) => {
    const path = new URL(request.url).pathname;

    if (path === "/health") {
        return json(200, { ...runtime.health(), uptime_ms: Date.now() - lifecycle.startedAt, idle_ms: lifecycle.idleMs });
    }

    if (path === "/shutdown" && request.method === "POST") {
        // Answered before the stop, or the caller reads a closed socket instead
        // of the acknowledgement.
        queueMicrotask(() => lifecycle.stop());

        return json(200, { ok: true, stopping: true });
    }

    if (request.method !== "POST") {
        return json(405, { ok: false, reason: `${request.method} ${path} is not a route here` });
    }

    const body = await readJson(request);

    if (!body.ok) {
        return json(400, body);
    }

    if (path === "/embed") {
        const payload = /** @type {{ texts?: unknown, kind?: unknown }} */ (body.value);
        const result = await runtime.embed(
            /** @type {string[]} */ (payload.texts),
            { kind: /** @type {any} */ (payload.kind) },
        );

        return json(result.ok ? 200 : 503, result);
    }

    if (path === "/rerank") {
        const payload = /** @type {{ query?: unknown, docs?: unknown }} */ (body.value);
        const result = await runtime.rerank(/** @type {string} */ (payload.query), /** @type {string[]} */ (payload.docs));

        return json(result.ok ? 200 : 503, result);
    }

    return json(404, { ok: false, reason: `no route ${path}` });
};

/**
 * @param {Request} request
 * @returns {Promise<{ ok: true, value: Record<string, unknown> } | { ok: false, reason: string }>}
 */
const readJson = async (request) => {
    try {
        const value = await request.json();

        if (value === null || typeof value !== "object") {
            return { ok: false, reason: "the body must be a JSON object" };
        }

        return { ok: true, value: /** @type {Record<string, unknown>} */ (value) };
    } catch (error) {
        return { ok: false, reason: `unreadable body: ${error instanceof Error ? error.message : String(error)}` };
    }
};

/** @param {number} status @param {unknown} value @returns {Response} */
const json = (status, value) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** @param {string | undefined} raw @returns {number | undefined} */
const positive = (raw) => {
    const value = Number.parseInt((raw ?? "").trim(), 10);

    return Number.isFinite(value) && value > 0 ? value : undefined;
};

if (import.meta.main) {
    // The daemon is started from inside a session and must outlive it. The
    // hangup that closes that session's terminal is not a reason to stop;
    // the idle timer is.
    process.on("SIGHUP", () => {});

    const { url, runtime } = serve();
    const health = runtime.health();

    console.log(`memory-handoff runtime on ${url} (models ${health.models_dir}, device ${health.device})`);

    if (!health.ready) {
        console.log(`not ready yet: ${health.reason}`);
    }

    // Warm up behind the listen. A caller that arrives first gets
    // `ready: false` and degrades; one that arrives second pays nothing.
    runtime
        .load()
        .then(() => console.log("both models loaded"))
        .catch((error) => console.log(`load failed: ${error instanceof Error ? error.message : String(error)}`));
}
