/**
 * A runtime to dispatch hooks against, in memory.
 *
 * Trimmed from compact-handoff's fixtures, which is where the two engine
 * disagreements these fakes encode were measured: `$.clock.now()` answers a
 * Promise although it is declared `number`, and `$.fs` has no append, so every
 * row goes out through `$.process.run`.
 */

/**
 * The `on` the runtime hands `register`, remembering what was registered.
 *
 * `dispatch` picks a handler the way the engine does: a matcher whose every key
 * the input carries wins, and the unmatched registration is the fallback, so
 * the `precompute` hook and the general `session.compact` hook are both
 * reachable from one place.
 */
export const fakeRuntime = () => {
    const registered = [];
    const on = (event, first, second) => {
        registered.push({
            event,
            match: second === undefined ? null : first,
            handler: second === undefined ? first : second,
        });
    };

    const handlerFor = (event, input) => {
        const candidates = registered.filter((entry) => entry.event === event);
        const matched = candidates.find(
            (entry) => entry.match !== null && Object.entries(entry.match).every(([key, value]) => input?.[key] === value),
        );

        return (matched ?? candidates.find((entry) => entry.match === null))?.handler ?? null;
    };

    return {
        on,
        registered,
        dispatch: async (event, $, input, next = passThrough()) => {
            const handler = handlerFor(event, input);

            if (handler === null) {
                throw new Error(`nothing is registered for ${event}`);
            }

            return handler($, input, next);
        },
    };
};

/** The `next` a dispatch carries: answers, and remembers that it was reached. */
export const passThrough = () => {
    const next = (input) => {
        next.calls.push(input);

        return { passedThrough: true };
    };

    next.calls = [];
    next.signal = undefined;

    return next;
};

/** The event a compaction carries, as both the hook and the seam see it. */
export const compactInput = (extra = {}) => ({
    trigger: "manual",
    agentId: null,
    instructions: "",
    messages: [
        { role: "user", text: "go", toolUses: [] },
        { role: "assistant", text: "done", toolUses: [] },
    ],
    ...extra,
});

/** What a fork answers when the placeholder prompt is honoured. */
export const forkReply = (memories = 2) => ({
    text: `{"memories":${JSON.stringify(
        Array.from({ length: memories }, (_, index) => ({
            text: `memory ${index}`,
            type: "fact",
            importance: 2,
        })),
    )}}`,
    usage: {
        input_tokens: 12,
        cache_read_input_tokens: 48_000,
        cache_creation_input_tokens: 0,
        output_tokens: 120,
    },
});

/** The tool compact-handoff raises, and the whole of the seam between them. */
export const SEAM_TOOL = "mcp__memory-handoff__before_compact";

/**
 * compact-handoff's seam, as the contract describes it: a noun on `$` taking a
 * tool name, and a raise of that tool when a compaction is about to happen.
 *
 * Nothing but strings crosses it. `raise` goes through the runtime exactly as
 * `$.tool.call` does, because the hook that answers is the one registered for
 * that tool name and nothing else reaches it.
 */
export const fakeSeam = (version = "0.6.0") => {
    const subscribers = [];

    return {
        subscribers,
        noun: {
            beforeCompact: async (options) => {
                const tool = options?.tool;

                subscribers.push({ tool, name: options?.name ?? tool });

                return { subscribed: true, tool };
            },
            version: async () => version,
        },
        /** Raise the subscribed tool the way compact-handoff's dispatch does. */
        raise: async (runtime, $, event = {}) =>
            runtime.dispatch(
                "tool.call",
                $,
                {
                    tool: subscribers.at(-1)?.tool ?? SEAM_TOOL,
                    trigger: event.trigger ?? "manual",
                    messageCount: event.messageCount ?? 2,
                },
                passThrough(),
            ),
    };
};

/**
 * The `$` a hook is handed.
 *
 * `clock.now` deliberately answers a Promise, which is what engine 2.1.273 does
 * against a declaration saying `number`; nothing in the module may depend on
 * it. Anything a test steers goes in `overrides`.
 */
export const fakeApi = (overrides = {}) => {
    const files = new Map(Object.entries(overrides.files ?? {}));
    const store = new Map();
    const env = { HOME: "/home/nobody", MEMORY_HANDOFF_LIVE: "1", ...overrides.env };
    const appends = [];
    const tools = [];

    files.set("/plugin/.claude-plugin/plugin.json", JSON.stringify({ version: "0.1.0-test" }));

    const $ = {
        plugin: { root: "/plugin" },
        env: { get: async (name) => env[name] },
        store: {
            get: async (key) => store.get(key),
            set: async (key, value) => void store.set(key, value),
            delete: async (key) => void store.delete(key),
        },
        fs: {
            read: async (path) => {
                if (!files.has(path)) {
                    throw new Error(`no such file: ${path}`);
                }

                return files.get(path);
            },
            write: async (path, text) => void files.set(path, text),
            exists: async (path) => files.has(path),
            list: async () => [],
        },
        // `appendRow` is the only caller, as
        // `sh -c '... "$1"' memory-handoff <file>` with the row on stdin.
        process: {
            run: async (argv, options = {}) => {
                appends.push({ file: argv.at(-1), line: (options.stdin ?? "").trimEnd() });

                return { code: 0, stdout: "", stderr: "" };
            },
        },
        model: {
            fork: overrides.fork ?? (async () => forkReply()),
        },
        tool: { register: async (spec) => void tools.push(spec) },
        session: {
            id: async () => "session-under-test",
            cwd: async () => "/repo",
            model: async () => "claude-sonnet-5",
            messages: async () => overrides.messages ?? [],
            usage: async () => ({ context: { tokens: 48_000, window: 200_000, percent: 24 } }),
            ...overrides.session,
        },
        ui: { toast: () => {}, log: () => {} },
        clock: { now: () => Promise.resolve(Date.now()), sleep: async () => {} },
    };

    if (overrides.seam !== undefined) {
        $.compactHandoff = overrides.seam;
    }

    return {
        $,
        files,
        store,
        tools,
        appends,
        /** Every row appended to a log whose path ends in `name`, parsed. */
        rowsIn: (name) => appends.filter((entry) => entry.file.endsWith(name)).map((entry) => JSON.parse(entry.line)),
    };
};
