/**
 * The documented bench: `bun runtime/bench.js`.
 *
 * It answers the question the footprint ceiling is about, which is not "is this
 * fast" but "what does leaving this on the box cost the work somebody is
 * waiting on". So it prints RSS with both models resident, `free -m` either
 * side of the run, and the `ps` line for the process that held the models, next
 * to the latencies.
 *
 * Each pass is its own child process, because a cold number measured in a
 * process that has already loaded a model is not a cold number. The passes run
 * one after another and never together: this box has been OOM-swept once, and
 * two copies of both models at the same time is how it happens again.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createRuntime } from "./infer.js";

/** How many measured calls a warm figure is the median of. */
const WARM_CALLS = 10;

/** The rerank batch the retrieval pipeline will actually ask for. */
const RERANK_PAIRS = 20;

/** The batch a compaction writing a handful of memories at once will ask for. */
const EMBED_BATCH = 16;

const CEILING = { rss_bytes: 400 * 1048576, embed1_ms: 150, rerank20_ms: 600 };

if (import.meta.main) {
    await main();
}

async function main() {
    const args = process.argv.slice(2);
    const single = args.includes("--single");
    const options = {
        device: /** @type {"cpu" | "wasm"} */ (flag(args, "--device") ?? "cpu"),
        embedDtype: /** @type {"fp32" | "q8"} */ (flag(args, "--embed-dtype") ?? "fp32"),
        rerankDtype: /** @type {"fp32" | "q8"} */ (flag(args, "--rerank-dtype") ?? "q8"),
    };

    if (single) {
        console.log(JSON.stringify(await onePass(options)));

        return;
    }

    const runs = Number.parseInt(flag(args, "--runs") ?? "3", 10);
    const before = freeMegabytes();
    const passes = [];

    for (let index = 0; index < runs; index += 1) {
        passes.push(childPass(options));
    }

    report(options, passes, before, freeMegabytes());
}

/**
 * One pass, in this process: load both models, then time each call shape.
 *
 * "Cold" is the first call after the load, which is the one that pays ONNX's
 * own first-run allocation; the load itself is reported separately, because a
 * daemon pays it once and a per-call sidecar pays it every time.
 *
 * @param {{ device: "cpu" | "wasm", embedDtype: "fp32" | "q8", rerankDtype: "fp32" | "q8" }} options
 */
async function onePass(options) {
    const runtime = createRuntime(options);
    const rssBefore = process.memoryUsage.rss();
    const loadStarted = Date.now();

    await runtime.load();

    const loadMs = Date.now() - loadStarted;
    const one = ["the monitor tick pulls the checkout every five minutes"];
    const batch = Array.from({ length: EMBED_BATCH }, (_unused, index) => `${one[0]} (${index})`);
    const docs = Array.from({ length: RERANK_PAIRS }, (_unused, index) => `Candidate ${index}: ${one[0]}.`);
    const query = "how often does the monitor run?";

    const embedCold = await timed(() => runtime.embed(one, { kind: "query" }));
    const embedWarm = await repeated(() => runtime.embed(one, { kind: "query" }));
    const embedBatch = await repeated(() => runtime.embed(batch, { kind: "document" }));
    const rerankCold = await timed(() => runtime.rerank(query, docs));
    const rerankWarm = await repeated(() => runtime.rerank(query, docs));

    return {
        load_ms: loadMs,
        embed1_cold_ms: embedCold,
        embed1_warm_ms: embedWarm,
        embed16_warm_ms: embedBatch,
        rerank20_cold_ms: rerankCold,
        rerank20_warm_ms: rerankWarm,
        rss_before_bytes: rssBefore,
        rss_bytes: process.memoryUsage.rss(),
        rss_peak_bytes: peakRss(),
        ps: ps(process.pid),
    };
}

/**
 * The high-water mark, which is the number the box's memory pressure is
 * actually about: loading a 127 MB graph costs more while it is being read than
 * it does once it is resident, and an OOM killer watches the peak.
 *
 * @returns {number}
 */
function peakRss() {
    try {
        const line = /VmHWM:\s+(\d+) kB/u.exec(readFileSync("/proc/self/status", "utf8"));

        return line === null ? process.memoryUsage.rss() : Number(line[1]) * 1024;
    } catch {
        return process.memoryUsage.rss();
    }
}

/** @param {() => Promise<{ ok: boolean, reason?: string }>} call @returns {Promise<number>} */
async function timed(call) {
    const started = Date.now();
    const result = await call();

    if (!result.ok) {
        throw new Error(`memory-handoff bench: ${result.reason}`);
    }

    return Date.now() - started;
}

/** The median of `WARM_CALLS`, so one scheduler hiccup is not the number. @param {() => Promise<{ ok: boolean, reason?: string }>} call @returns {Promise<number>} */
async function repeated(call) {
    const samples = [];

    for (let index = 0; index < WARM_CALLS; index += 1) {
        samples.push(await timed(call));
    }

    return median(samples);
}

/** @param {{ device: string, embedDtype: string, rerankDtype: string }} options @returns {any} */
function childPass(options) {
    const here = fileURLToPath(import.meta.url);
    const argv = [
        here,
        "--single",
        "--device",
        options.device,
        "--embed-dtype",
        options.embedDtype,
        "--rerank-dtype",
        options.rerankDtype,
    ];
    const stdout = execFileSync(process.execPath, argv, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });

    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
}

/**
 * @param {{ device: string, embedDtype: string, rerankDtype: string }} options
 * @param {any[]} passes
 * @param {string} before
 * @param {string} after
 * @returns {void}
 */
function report(options, passes, before, after) {
    const rows = [
        ["load (both models)", "load_ms", "ms"],
        ["embed(1) cold", "embed1_cold_ms", "ms"],
        ["embed(1) warm", "embed1_warm_ms", "ms"],
        [`embed(${EMBED_BATCH}) warm`, "embed16_warm_ms", "ms"],
        [`rerank(${RERANK_PAIRS}) cold`, "rerank20_cold_ms", "ms"],
        [`rerank(${RERANK_PAIRS}) warm`, "rerank20_warm_ms", "ms"],
        ["RSS, both models resident", "rss_bytes", "MB"],
        ["RSS peak (VmHWM, during load)", "rss_peak_bytes", "MB"],
    ];

    console.log(`memory-handoff runtime bench  device=${options.device} embed=${options.embedDtype} rerank=${options.rerankDtype}`);
    console.log(`${passes.length} passes, each its own process, one at a time.\n`);
    console.log(`${pad("measure", 28)}${passes.map((_unused, index) => pad(`run ${index + 1}`, 10)).join("")}${pad("median", 10)}spread`);

    for (const [label, key, unit] of rows) {
        const values = passes.map((pass) => (unit === "MB" ? pass[key] / 1048576 : pass[key]));
        const shown = values.map((value) => pad(value.toFixed(unit === "MB" ? 1 : 0), 10)).join("");
        const spread = `${Math.min(...values).toFixed(unit === "MB" ? 1 : 0)}-${Math.max(...values).toFixed(unit === "MB" ? 1 : 0)} ${unit}`;

        console.log(`${pad(label, 28)}${shown}${pad(median(values).toFixed(unit === "MB" ? 1 : 0), 10)}${spread}`);
    }

    console.log("\nCeiling:");
    verdict("RSS both models", median(passes.map((pass) => pass.rss_bytes)), CEILING.rss_bytes, (value) => `${(value / 1048576).toFixed(1)} MB`);
    verdict("embed(1) warm", median(passes.map((pass) => pass.embed1_warm_ms)), CEILING.embed1_ms, (value) => `${value} ms`);
    verdict(`rerank(${RERANK_PAIRS}) warm`, median(passes.map((pass) => pass.rerank20_warm_ms)), CEILING.rerank20_ms, (value) => `${value} ms`);

    console.log(`\nps -o rss=,vsz=,comm= (last pass): ${passes.at(-1)?.ps ?? "n/a"}`);
    console.log(`\nfree -m before:\n${before}\nfree -m after:\n${after}`);
}

/** @param {string} label @param {number} measured @param {number} ceiling @param {(value: number) => string} show @returns {void} */
function verdict(label, measured, ceiling, show) {
    const over = measured > ceiling;

    console.log(`  ${pad(label, 26)}${pad(show(measured), 12)}ceiling ${pad(show(ceiling), 12)}${over ? "OVER" : "under"}`);
}

/** @param {string} pid @returns {string} */
function ps(pid) {
    try {
        return execFileSync("ps", ["-o", "rss=,vsz=,comm=", "-p", String(pid)], { encoding: "utf8" }).trim();
    } catch {
        return "ps unavailable";
    }
}

/** @returns {string} */
function freeMegabytes() {
    try {
        return execFileSync("free", ["-m"], { encoding: "utf8" }).trimEnd();
    } catch {
        return "free unavailable";
    }
}

/** @param {number[]} values @returns {number} */
function median(values) {
    const sorted = [...values].sort((left, right) => left - right);

    return sorted[Math.floor(sorted.length / 2)];
}

/** @param {string[]} args @param {string} name @returns {string | undefined} */
function flag(args, name) {
    const index = args.indexOf(name);

    return index === -1 ? undefined : args[index + 1];
}

/** @param {string} text @param {number} width @returns {string} */
function pad(text, width) {
    return text.length >= width ? `${text} ` : text.padEnd(width);
}
