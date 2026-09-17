// Seam detection, driven through the real engine.
//
// This plugin decides at `session.start` whether compact-handoff is there, and
// the whole of the decision is that reading a noun which does not exist throws.
// `bun test` cannot reach that: a stub `$` either carries the noun or does not,
// and either way it is the stub answering and not the engine. `claude plugin
// test` loads this plugin into a child of the Claude Code binary, so the fake
// below is folded onto `$` by the engine itself and the absent case is
// genuinely absent.
import { expect, test, tier } from "claude-code/testing";
import type { Register } from "claude-code";
import type { Engine } from "claude-code/testing";

tier("user");

const START = { cwd: "/tmp", surface: null, isInteractive: false };

const STATUS_TOOL = "mcp__memory-handoff__memory_status";

// A stand-in for compact-handoff: the same noun, the same two events, and a
// version no real release will ever carry, so a pass cannot come from the real
// plugin being installed on the machine running this. `register` closes over
// nothing at all, which the engine enforces, so every constant it needs is
// written inline.
const register: Register = (on) => {
    on("engine.create", async ($, e, next) => {
        const built = await next(e);

        return {
            ...built,
            compactHandoff: {
                beforeCompact: async (options: { tool: string }) => ({ subscribed: true, tool: options.tool }),
                version: async () => "9.9.9",
            },
        };
    });
};

const fakeCompactHandoff = { name: "fake-compact-handoff", register };

/**
 * The bottom of every chain this test drives.
 *
 * Nothing sits beneath the plugins in a test, so each engine call the plugin
 * makes has to be answered here or the hook that made it is skipped whole with
 * "no implementation for <event>". Keeping them in one list is the point: it is
 * a checked record of what this plugin asks the engine for on the seam path,
 * and a call added later shows up as a named failure rather than a silent one.
 *
 * The store is real, because the seam reading is written at `session.start` and
 * read back by `memory_status`; a store that forgot would pass the absent case
 * for the wrong reason.
 */
const bottom = (on: Parameters<Register>[0]) => {
    const store = new Map<string, unknown>();

    on("tool.register", async ($, e) => ({ value: e }));
    on("session.start", async ($, e) => ({ cwd: e.cwd }));
    on("session.id", async () => ({ value: "engine-test-session" }));
    on("session.cwd", async () => ({ value: "/tmp" }));
    // A directory of its own, so a test never reads or writes the real store.
    on("env.get", async ($, e) => ({ value: e.name === "MEMORY_HANDOFF_DIR" ? "/tmp/memory-handoff-engine-test" : undefined }));
    on("store.get", async ($, e) => ({ value: store.get(e.key) }));
    on("store.set", async ($, e) => {
        store.set(e.key, e.value);

        return { value: undefined };
    });
    on("fs.exists", async () => ({ value: false }));
    on("fs.read", async () => ({ value: "" }));
    on("fs.write", async () => ({ value: undefined }));
    on("process.run", async () => ({ value: { code: 1, stdout: "", stderr: "not run in a test" } }));
};

/** Starts a session with the bottom of the chain answered. */
const start = async (engine: Engine, on: Parameters<Register>[0]) => {
    bottom(on);

    await engine.session.start(START);
};

/** What `memory_status` reports, out of the JSON it answers with. */
const status = async (engine: Engine) => {
    const answer = await engine.tool.call({ tool: STATUS_TOOL, input: {} });

    return JSON.parse(JSON.parse(JSON.stringify(answer)).result);
};

test("with compact-handoff present the subscription is taken and its version recorded", { plugins: [fakeCompactHandoff] }, async (engine, on) => {
    await start(engine, on);

    const seen = await status(engine);

    expect(seen.seam.present).toBe(true);
    expect(seen.seam.version).toBe("9.9.9");
    expect(seen.seam.detail).toBe(null);
});

test("with compact-handoff absent the miss is recorded rather than thrown", async (engine, on) => {
    await start(engine, on);

    const seen = await status(engine);

    expect(seen.seam.present).toBe(false);
    expect(seen.seam.version).toBe(null);
    expect(seen.seam.detail).toMatch(/compactHandoff/);
});
