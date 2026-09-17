/**
 * The inference core: two ONNX sessions, a tokenizer each, and nothing else.
 *
 * There is no HTTP in this file and no process management. `serve.js` wraps it
 * in a loopback daemon and `client.js` speaks to that daemon; both are
 * adapters, and anything that wants to embed in-process imports this directly.
 *
 * Three things here are contract rather than implementation detail.
 *
 * **The bge query prefix lives inside `embed`.** bge-small asks that a search
 * query carry a short instruction and that a document carry none. Leaving that
 * to callers guarantees that half a corpus is written one way and queried the
 * other, and the failure is silent: the vectors are well shaped and the
 * neighbours are wrong. So the caller says `kind: "query"` or
 * `kind: "document"` and the runtime applies the asymmetry.
 *
 * **Truncation is reported.** Both models see 512 tokens. Anything longer is
 * cut at the tokenizer, deterministically, and the result says which texts were
 * cut, because a memory that was truncated means something different from the
 * one that was written and nothing downstream can tell by looking.
 *
 * **Threads are pinned to 2.** This box has 6 cores shared with a five-minute
 * monitor tick, a Laravel container and agent waves. ONNX takes every core it
 * can see by default, which turns one embed into real interference with work
 * somebody is waiting on.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AutoModel, AutoModelForSequenceClassification, AutoTokenizer, env } from "@huggingface/transformers";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The pinned weights, and the only place a model id or a revision is written. */
export const MODELS = JSON.parse(readFileSync(join(HERE, "models.json"), "utf8"));

/** How many cores one session may take. See the file header. */
export const INTRA_OP_THREADS = 2;

/**
 * @typedef {"fp32" | "q8"} Dtype
 * @typedef {"cpu" | "wasm"} Device onnxruntime-node native, or the WASM build.
 * @typedef {"query" | "document"} TextKind
 */

/**
 * @typedef {object} RuntimeOptions
 * @property {string} [modelsDir]
 * @property {Device} [device]
 * @property {Dtype} [embedDtype]
 * @property {Dtype} [rerankDtype]
 * @property {number} [threads]
 */

/**
 * Where the weights live. Not inside the plugin: its own root is a worktree
 * somebody may delete, and 166 MB has no business in a git checkout.
 *
 * @param {Record<string, string | undefined>} [vars]
 * @returns {string}
 */
export const defaultModelsDir = (vars = process.env) => {
    const override = (vars.MEMORY_HANDOFF_MODELS_DIR ?? "").trim();

    if (override !== "") {
        return override.replace(/\/+$/u, "");
    }

    const dir = (vars.MEMORY_HANDOFF_DIR ?? "").trim();
    const root = dir !== "" ? dir.replace(/\/+$/u, "") : join((vars.HOME ?? "").trim(), ".claude/memory-handoff");

    return join(root, "models");
};

/** The file a dtype resolves to inside a model's directory. @param {Dtype} dtype @returns {string} */
export const onnxFileFor = (dtype) => (dtype === "fp32" ? "onnx/model.onnx" : "onnx/model_quantized.onnx");

/**
 * Every file a model needs at a dtype, relative to the models directory.
 *
 * @param {{ id: string, files: { path: string, dtype?: string }[] }} spec
 * @param {Dtype} dtype
 * @returns {string[]}
 */
export const filesFor = (spec, dtype) =>
    spec.files.filter((file) => file.dtype === undefined || file.dtype === dtype).map((file) => join(spec.id, file.path));

/**
 * Which of the weights are missing from disk, so `health()` can say so before
 * anything tries to load them and throw.
 *
 * @param {string} modelsDir
 * @param {Dtype} embedDtype
 * @param {Dtype} rerankDtype
 * @returns {string[]}
 */
export const missingWeights = (modelsDir, embedDtype, rerankDtype) =>
    [...filesFor(MODELS.embed, embedDtype), ...filesFor(MODELS.rerank, rerankDtype)].filter(
        (relative) => !existsSync(join(modelsDir, relative)),
    );

/** Bytes on disk for everything present of a model's pinned files. @param {string} modelsDir @param {Dtype} embedDtype @param {Dtype} rerankDtype @returns {number} */
export const weightsBytes = (modelsDir, embedDtype, rerankDtype) =>
    [...filesFor(MODELS.embed, embedDtype), ...filesFor(MODELS.rerank, rerankDtype)].reduce((total, relative) => {
        const path = join(modelsDir, relative);

        return existsSync(path) ? total + statSync(path).size : total;
    }, 0);

/**
 * A runtime over one models directory. Nothing is loaded until `load()` or the
 * first call, so constructing one is free and `health()` on a machine with no
 * weights answers rather than throws.
 *
 * @param {RuntimeOptions} [options]
 */
export const createRuntime = (options = {}) => {
    const modelsDir = options.modelsDir ?? defaultModelsDir();
    const device = options.device ?? "cpu";
    const embedDtype = options.embedDtype ?? /** @type {Dtype} */ (MODELS.embed.shippedDtype);
    const rerankDtype = options.rerankDtype ?? /** @type {Dtype} */ (MODELS.rerank.shippedDtype);
    const threads = options.threads ?? INTRA_OP_THREADS;

    /** @type {Promise<{ embed: any, rerank: any }> | null} */
    let loading = null;

    const load = () => {
        loading ??= loadBoth({ modelsDir, device, embedDtype, rerankDtype, threads });

        return loading;
    };

    return {
        modelsDir,
        device,
        dtypes: { embed: embedDtype, rerank: rerankDtype },
        load,

        /**
         * @param {string[]} texts
         * @param {{ kind?: TextKind }} [init]
         * @returns {Promise<{ ok: true, vectors: number[][], dim: number, model: string, ms: number, truncated: boolean[] } | { ok: false, reason: string }>}
         */
        embed: async (texts, init = {}) => {
            const kind = init.kind ?? "document";

            if (!Array.isArray(texts) || texts.some((text) => typeof text !== "string")) {
                return { ok: false, reason: "embed takes an array of strings" };
            }

            if (kind !== "query" && kind !== "document") {
                return { ok: false, reason: `kind must be "query" or "document", not ${JSON.stringify(kind)}` };
            }

            if (texts.length === 0) {
                return { ok: true, vectors: [], dim: MODELS.embed.dim, model: embedName(embedDtype), ms: 0, truncated: [] };
            }

            return await guard(async () => {
                const { embed } = await load();
                const started = Date.now();
                const prepared = texts.map((text) => (kind === "query" ? MODELS.embed.queryPrefix + text : text));
                const truncated = prepared.map((text) => tokenCount(embed.tokenizer, text) > MODELS.embed.maxTokens);
                const inputs = embed.tokenizer(prepared, {
                    padding: true,
                    truncation: true,
                    max_length: MODELS.embed.maxTokens,
                });
                const output = await embed.model(inputs);

                return {
                    ok: /** @type {const} */ (true),
                    vectors: clsPooled(output.last_hidden_state),
                    dim: MODELS.embed.dim,
                    model: embedName(embedDtype),
                    ms: Date.now() - started,
                    truncated,
                };
            });
        },

        /**
         * @param {string} query
         * @param {string[]} docs
         * @returns {Promise<{ ok: true, scores: number[], model: string, ms: number, truncated: boolean[] } | { ok: false, reason: string }>}
         */
        rerank: async (query, docs) => {
            if (typeof query !== "string") {
                return { ok: false, reason: "rerank takes a query string" };
            }

            if (!Array.isArray(docs) || docs.some((doc) => typeof doc !== "string")) {
                return { ok: false, reason: "rerank takes an array of document strings" };
            }

            if (docs.length === 0) {
                return { ok: true, scores: [], model: rerankName(rerankDtype), ms: 0, truncated: [] };
            }

            return await guard(async () => {
                const { rerank } = await load();
                const started = Date.now();
                const inputs = rerank.tokenizer(Array.from({ length: docs.length }, () => query), {
                    text_pair: docs,
                    padding: true,
                    truncation: true,
                    max_length: MODELS.rerank.maxTokens,
                });
                const output = await rerank.model(inputs);
                const logits = /** @type {number[]} */ (Array.from(output.logits.data, Number));

                return {
                    ok: /** @type {const} */ (true),
                    // One logit per pair, and only its order within this call
                    // means anything: the model is not calibrated, so retrieval
                    // ranks by it and never thresholds on it.
                    scores: logits,
                    model: rerankName(rerankDtype),
                    ms: Date.now() - started,
                    truncated: truncationOf(inputs, MODELS.rerank.maxTokens),
                };
            });
        },

        /**
         * Reachability and readiness in one reading, and never a throw: a
         * caller that gets `ready: false` degrades to FTS5-only retrieval.
         *
         * @returns {{ ready: boolean, models: string[], rss_bytes: number, weights_bytes: number, models_dir: string, device: Device, dtypes: { embed: Dtype, rerank: Dtype }, reason?: string }}
         */
        health: () => {
            const base = {
                models: [embedName(embedDtype), rerankName(rerankDtype)],
                rss_bytes: process.memoryUsage.rss(),
                weights_bytes: weightsBytes(modelsDir, embedDtype, rerankDtype),
                models_dir: modelsDir,
                device,
                dtypes: { embed: embedDtype, rerank: rerankDtype },
            };
            const missing = missingWeights(modelsDir, embedDtype, rerankDtype);

            if (missing.length > 0) {
                return { ready: false, ...base, reason: `weights missing (${missing.length} files): run bun runtime/install.js` };
            }

            if (loading === null) {
                return { ready: false, ...base, reason: "weights are on disk and no model is loaded yet" };
            }

            return { ready: true, ...base };
        },
    };
};

/** @param {Dtype} dtype @returns {string} */
const embedName = (dtype) => `${MODELS.embed.id}@${MODELS.embed.revision.slice(0, 12)}/${dtype}`;

/** @param {Dtype} dtype @returns {string} */
const rerankName = (dtype) => `${MODELS.rerank.id}@${MODELS.rerank.revision.slice(0, 12)}/${dtype}`;

/**
 * Both sessions, loaded once. They are loaded together on purpose: the RSS
 * number the footprint ceiling is about is both models resident, so a runtime
 * that quietly loads one of them is not the thing that was measured.
 *
 * @param {{ modelsDir: string, device: Device, embedDtype: Dtype, rerankDtype: Dtype, threads: number }} spec
 */
const loadBoth = async (spec) => {
    // transformers.js keeps this configuration on one process-global object, so
    // it is written here, immediately before the sessions are built, rather
    // than when a runtime is constructed: two runtimes over two directories in
    // one process would otherwise race for it. One runtime per process is the
    // shape this is built for, and `serve.js` is that process.
    //
    // `allowRemoteModels = false` is the load-bearing line. A hook that
    // silently downloads 166 MB is the thing `install.js` exists to prevent,
    // and a missing file must surface as `ready: false` rather than as a fetch.
    env.allowRemoteModels = false;
    env.localModelPath = spec.modelsDir;
    env.backends.onnx.wasm.numThreads = spec.threads;

    const sessionOptions = {
        intraOpNumThreads: spec.threads,
        interOpNumThreads: 1,
        executionMode: /** @type {const} */ ("sequential"),
        // ONNX's CPU arena keeps every block it has ever allocated. Measured on
        // this box, 2026-09-17: leaving it on costs 95 MB of resident memory
        // (440 MB against 345 MB) and buys 4 ms on a warm embed. On a machine
        // that has been OOM-swept once, 95 MB is the better side of that trade.
        enableCpuMemArena: false,
        enableMemPattern: false,
    };
    const common = { local_files_only: true, device: spec.device, session_options: sessionOptions };

    const [embedTokenizer, embedModel, rerankTokenizer, rerankModel] = await Promise.all([
        AutoTokenizer.from_pretrained(MODELS.embed.id, { local_files_only: true }),
        AutoModel.from_pretrained(MODELS.embed.id, { ...common, dtype: spec.embedDtype }),
        AutoTokenizer.from_pretrained(MODELS.rerank.id, { local_files_only: true }),
        AutoModelForSequenceClassification.from_pretrained(MODELS.rerank.id, { ...common, dtype: spec.rerankDtype }),
    ]);

    return {
        embed: { tokenizer: embedTokenizer, model: embedModel },
        rerank: { tokenizer: rerankTokenizer, model: rerankModel },
    };
};

/**
 * bge pools the CLS token and normalises; the cosine everything downstream
 * computes is a dot product only because of the normalise.
 *
 * @param {{ dims: number[], data: ArrayLike<number> }} hidden
 * @returns {number[][]}
 */
const clsPooled = (hidden) => {
    const [batch, , width] = hidden.dims;

    return Array.from({ length: batch }, (_unused, row) => {
        const start = row * hidden.dims[1] * width;
        const vector = Array.from({ length: width }, (_ignored, column) => Number(hidden.data[start + column]));
        const norm = Math.hypot(...vector) || 1;

        return vector.map((value) => value / norm);
    });
};

/**
 * How many tokens a text costs before truncation, which is the only way to
 * report that a text was cut: the truncated encoding cannot tell you.
 *
 * @param {any} tokenizer
 * @param {string} text
 * @returns {number}
 */
const tokenCount = (tokenizer, text) => tokenizer.encode(text).length;

/**
 * A pair is truncated when it filled the window exactly, which is what the
 * tokenizer's own truncation leaves behind. Cheaper than encoding every pair
 * twice, and a pair that lands on 512 tokens without being cut is rare enough
 * that over-reporting it is the safe direction.
 *
 * @param {{ input_ids: { dims: number[], data: ArrayLike<number> }, attention_mask: { dims: number[], data: ArrayLike<number> } }} inputs
 * @param {number} maxTokens
 * @returns {boolean[]}
 */
const truncationOf = (inputs, maxTokens) => {
    const [batch, width] = inputs.attention_mask.dims;

    return Array.from({ length: batch }, (_unused, row) => {
        let used = 0;

        for (let column = 0; column < width; column += 1) {
            used += Number(inputs.attention_mask.data[row * width + column]);
        }

        return used >= maxTokens;
    });
};

/**
 * The boundary where a throw becomes a value. Everything above returns
 * `{ ok: false, reason }` so a compaction that cannot embed stores the memory
 * without a vector instead of failing.
 *
 * @template T
 * @param {() => Promise<T>} run
 * @returns {Promise<T | { ok: false, reason: string }>}
 */
const guard = async (run) => {
    try {
        return await run();
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
};
