import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { compactInput, fakeApi, fakeRuntime, forkReply, passThrough, promptInput, searchDocument } from "./fixtures.js";

const manifest = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));

/**
 * The options `register` is handed, built the way the engine builds them: every
 * declared default passed as a set value, and whatever the person set on top.
 */
const engineOptions = (set = {}) => ({
    ...Object.fromEntries(
        Object.entries(manifest.userConfig)
            .filter(([, spec]) => "default" in spec)
            .map(([key, spec]) => [key, spec.default]),
    ),
    ...set,
});

const started = async (host, set) => {
    const runtime = fakeRuntime();

    (await import("../hooks/module.js")).register(runtime.on, engineOptions(set));
    await runtime.dispatch("session.start", host.$, { sessionId: "session-under-test" }, passThrough());

    return runtime;
};

/** One compaction under the given settings and environment, and how many forks it ran. */
const compactedUnder = async (set, env) => {
    let forks = 0;
    const host = fakeApi({
        env: { MEMORY_HANDOFF_LIVE: undefined, ...env },
        fork: async () => {
            forks += 1;

            return forkReply();
        },
    });
    const runtime = await started(host, set);

    await runtime.dispatch("session.compact", host.$, compactInput(), passThrough());

    return { forks, outcome: host.rowsIn("index.jsonl")[0].outcome };
};

describe("an untouched setting falls through to its variable", () => {
    it("goes live on MEMORY_HANDOFF_LIVE=1 when live was never set", async () => {
        const { forks, outcome } = await compactedUnder({}, { MEMORY_HANDOFF_LIVE: "1" });

        assert.equal(forks, 1);
        assert.notEqual(outcome, "rehearsed");
    });

    it("asks the retrieval for the k and the timeout the variables set when neither was set", async () => {
        const host = fakeApi({ env: { MEMORY_HANDOFF_INJECT_K: "9", MEMORY_HANDOFF_INJECT_TIMEOUT_MS: "1400" } });
        const runtime = await started(host);

        await runtime.dispatch("prompt.submit", host.$, promptInput(), passThrough());

        const call = host.childrenOf("search").at(0);

        assert.equal(call.argv[call.argv.indexOf("--k") + 1], "9");
        assert.equal(call.timeoutMs, 1400);
    });

    it("caps the injected block at the entries the variable sets when the row was never set", async () => {
        const host = fakeApi({ env: { MEMORY_HANDOFF_INJECT_MAX_ENTRIES: "2" }, search: searchDocument(5) });
        const runtime = await started(host);

        await runtime.dispatch("prompt.submit", host.$, promptInput(), passThrough());

        assert.deepEqual(host.adminDocs("injection").at(0).memoryIds, [1, 2]);
    });

    it("caps the injected block at the characters the variable sets when the row was never set", async () => {
        const host = fakeApi({ env: { MEMORY_HANDOFF_INJECT_MAX_CHARS: "150" }, search: searchDocument(3) });
        const runtime = await started(host);
        const next = passThrough();

        await runtime.dispatch("prompt.submit", host.$, promptInput(), next);

        assert.ok(host.adminDocs("injection").at(0).memoryIds.length < 3);
        assert.ok((next.calls.at(-1)?.context ?? [])[0].length <= 150);
    });
});

describe("a setting the person chose wins over the variable", () => {
    it("stays rehearsing when live is set off, whatever MEMORY_HANDOFF_LIVE says", async () => {
        const { forks, outcome } = await compactedUnder({ live: false }, { MEMORY_HANDOFF_LIVE: "1" });

        assert.equal(forks, 0);
        assert.equal(outcome, "rehearsed");
    });

    it("goes live when live is set on and the variable is absent", async () => {
        const { forks, outcome } = await compactedUnder({ live: true }, {});

        assert.equal(forks, 1);
        assert.notEqual(outcome, "rehearsed");
    });
});

// The engine hands a declared default to the module as a set value, and `opt`
// reads a boolean false as set, so a `"default": false` would shadow the
// variable for everyone who never opened the config menu.
describe("the manifest", () => {
    it("declares no boolean default of false", () => {
        const masking = Object.entries(manifest.userConfig)
            .filter(([, spec]) => spec.default === false)
            .map(([key]) => key);

        assert.deepEqual(masking, []);
    });
});
