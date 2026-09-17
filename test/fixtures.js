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

/** What a fork answers when the generation prompt is honoured. */
export const forkReply = (memories = 2) => ({
    text: [
        "<memories>",
        ...Array.from({ length: memories }, (_, index) =>
            JSON.stringify({
                type: "project",
                title: `memory ${index}`,
                body: `the ${index}th thing this conversation established`,
                importance: 2,
            }),
        ),
        "</memories>",
    ].join("\n"),
    usage: {
        input_tokens: 12,
        cache_read_input_tokens: 48_000,
        cache_creation_input_tokens: 0,
        output_tokens: 120,
    },
});

/**
 * The same reply, from a fork charged for half the context: a cold one.
 *
 * The text is a well-formed answer on purpose. A cold fork's reply reads like
 * any other summary, so the only thing that can tell is the usage, and a
 * fixture that answered badly would pass for the wrong reason.
 */
export const coldForkReply = (memories = 2) => ({
    ...forkReply(memories),
    usage: {
        input_tokens: 4_000,
        cache_read_input_tokens: 20_000,
        cache_creation_input_tokens: 0,
        output_tokens: 120,
    },
});

/**
 * `git` as the hook reads it: a remote and a toplevel, unless a test says the
 * checkout has neither.
 */
const gitAnswer = (argv, git) => {
    const wanted = argv.includes("--show-toplevel") ? git.toplevel ?? "/repo" : git.remoteUrl ?? "git@github.com:owner/repo.git";

    return wanted === null ? { exitCode: 128, stdout: "", stderr: "not a git repository" } : { exitCode: 0, stdout: `${wanted}\n`, stderr: "" };
};

/** The Bun writer: remembers the document it was handed and answers as it does. */
const writerAnswer = (writes, stdin, override) => {
    const doc = JSON.parse(stdin);

    writes.push(doc);

    if (override !== undefined) {
        return override;
    }

    return {
        exitCode: 0,
        stdout: `${JSON.stringify({
            ok: true,
            memoriesWritten: doc.rows.length,
            ids: doc.rows.map((_, index) => index + 1),
            generationId: writes.length,
            costId: writes.length,
            project: "github.com/owner/repo",
            projectKind: "remote",
        })}\n`,
        stderr: "",
    };
};

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

/** The event a person's Enter carries, as `prompt.submit` stamps it. */
export const promptInput = (extra = {}) => ({
    text: "why did the cron job stop",
    wait: false,
    origin: { kind: "composer" },
    ...extra,
});

/** What a retrieval answers when the database has something to say. */
export const searchDocument = (results = 2, extra = {}) => ({
    retrievalId: 7,
    degraded: null,
    matchExpression: '"cron" OR "stop"',
    results: Array.from({ length: results }, (_, index) => ({
        rank: index + 1,
        memoryId: index + 1,
        title: `memory ${index + 1}`,
        body: `the ${index + 1}th thing an earlier session established`,
        type: "project",
        importance: 3,
        scores: { fts: -0.8, vector: null, merge: 0.016, rerank: 2.25 - index },
    })),
    ...extra,
});

/** Which child a call to `$.process.run` is, by the script at the end of its argv. */
const childKind = (argv) => {
    const script = String(argv?.[1] ?? "");

    if (script.endsWith("search-cli.js")) return "search";
    if (script.endsWith("explain-cli.js")) return "explain";
    if (script.endsWith("memory-admin.js")) return "admin";

    return null;
};

/**
 * The three Bun children the injection path shells, answered as they answer.
 *
 * An override may be a function, which is how a test makes one of them time out
 * (`$.process.run` rejects on `timeoutMs`, so the fake throws) or exit non-zero.
 */
const childAnswer = async (kind, argv, options, overrides) => {
    const override = overrides[kind];

    if (typeof override === "function") {
        return override(argv, options);
    }

    if (kind === "search") {
        return { exitCode: 0, stdout: `${JSON.stringify(override ?? searchDocument())}\n`, stderr: "retrieval 7\n" };
    }

    if (kind === "explain") {
        return {
            exitCode: 0,
            stdout: `${JSON.stringify(override ?? { retrieval: { id: 7, origin: "tool" }, candidates: [] }, null, 2)}\n`,
            stderr: "",
        };
    }

    return { exitCode: 0, stdout: `${JSON.stringify(override ?? adminAnswer(argv, options))}\n`, stderr: "" };
};

/** `schema/memory-admin.js`, answering each op as it does. */
const adminAnswer = (argv, options) => {
    const op = String(argv.at(-1));
    const doc = JSON.parse(options.stdin ?? "{}");

    if (op === "injection") {
        return { ok: true, injectionId: 1, retrievalId: doc.retrievalId ?? 1 };
    }

    if (op === "counts") {
        return {
            ok: true,
            memories: { total: 3, active: 3, deleted: 0 },
            projects: 1,
            generations: 1,
            retrievals: 1,
            injections: 1,
            spend: { rows: 1, usd: 0.0123, cacheReadWaivedUsd: 0.4, unpricedRows: 1 },
        };
    }

    if (op === "list") {
        return { ok: true, total: 1, limit: doc.limit ?? 20, offset: 0, status: ["active"], memories: [] };
    }

    return { ok: true, id: doc.id, mode: doc.purge === true ? "purged" : "tombstoned", title: "a memory", wasStatus: "active" };
};

/**
 * The terminal's element table, as `$.ui.resolve(e)` hands it over.
 *
 * Every factory records what it drew, so a test can walk the tree and see which
 * elements were used and how wide each line came out. `div`, `span` and `b`
 * stopped being elements at 2.1.267 and are deliberately absent: a module still
 * reaching for one fails here the way it fails in the engine.
 */
export const elementTable = () =>
    Object.fromEntries(
        ["Box", "Text", "Code", "Button", "Link", "Input", "Select"].map((name) => [
            name,
            (props = {}) => ({ element: name, props }),
        ]),
    );

/** Every node of a drawn tree, depth first. */
export const paneNodes = (node) => {
    if (Array.isArray(node)) {
        return node.flatMap((child) => paneNodes(child));
    }

    if (node === null || typeof node !== "object" || typeof node.element !== "string") {
        return [];
    }

    return [node, ...paneNodes(node.props?.children ?? [])];
};

/** Every line of text a tree draws, in order. */
export const paneLines = (tree) =>
    paneNodes(tree)
        .filter((node) => node.element === "Text")
        .map((node) => String(node.props.children ?? ""));

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
    const writes = [];
    const tools = [];
    const children = [];
    const opens = [];
    const closes = [];
    const invalidations = [];
    const logs = [];
    const elements = elementTable();

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
        // Three callers, told apart the way the shell would: `sh -c` appending a
        // row, `git` answering where the checkout is, and the Bun writer taking
        // a whole generation on stdin and answering JSON on stdout.
        process: {
            run: async (argv, options = {}) => {
                if (argv[0] === "git") {
                    return gitAnswer(argv, overrides.git ?? {});
                }

                if (String(argv.at(-1)).endsWith("write-generation.js")) {
                    return writerAnswer(writes, options.stdin ?? "", overrides.write);
                }

                const kind = childKind(argv);

                if (kind !== null) {
                    children.push({ kind, argv, stdin: options.stdin ?? null, timeoutMs: options.timeoutMs ?? null });

                    return childAnswer(kind, argv, options, overrides);
                }

                appends.push({ file: argv.at(-1), line: (options.stdin ?? "").trimEnd() });

                return { exitCode: 0, stdout: "", stderr: "" };
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
        ui: {
            toast: () => {},
            log: (text) => void logs.push(String(text)),
            open: overrides.open ?? (async (args) => void opens.push(args)),
            close: async (args) => void closes.push(args),
            invalidate: (what) => void invalidations.push(what),
            resolve: () => elements,
        },
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
        /** Every call into a Bun child, in order: `{ kind, argv, stdin, timeoutMs }`. */
        children,
        /** Every call into one child, by kind. */
        childrenOf: (kind) => children.filter((call) => call.kind === kind),
        /** Every document handed to `schema/memory-admin.js`, parsed, by op. */
        adminDocs: (op) =>
            children
                .filter((call) => call.kind === "admin" && String(call.argv.at(-1)) === op)
                .map((call) => JSON.parse(call.stdin ?? "{}")),
        opens,
        closes,
        invalidations,
        logs,
        elements,
        /** Every generation document handed to the writer, parsed. */
        writes,
        /** Every row appended to a log whose path ends in `name`, parsed. */
        rowsIn: (name) => appends.filter((entry) => entry.file.endsWith(name)).map((entry) => JSON.parse(entry.line)),
    };
};
