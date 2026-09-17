/**
 * The pane's tree, built from plain data.
 *
 * `$` never reaches here: the hook resolves the element table
 * (`$.ui.resolve(e)`) and hands it in, so the whole drawing is testable with
 * factories that record what they were asked for.
 *
 * Three rules the terminal surface enforces, each of which has cost somebody a
 * run:
 *
 * - **Children go in `props.children`.** `Box({}, child)` draws an empty frame
 *   and still settles the dispatch, so every call here passes `children`.
 * - **`div`, `span` and `b` stopped being elements at 2.1.267.** Only `Box` and
 *   `Text` are used below.
 * - **`Code` overdraws when it wraps**: at 2.1.269 it honours `wrap` when
 *   drawing and reports its height unwrapped, so a long line paints over the
 *   row beneath it. There is no `Code` here at all, and every line is broken to
 *   the body width before it is handed over.
 */

/** Where a line is broken when the pane's width is unknown. */
export const DEFAULT_COLUMNS = 80;

/** How far inside the body width a line is broken, for the frame and the padding. */
const GUTTER = 10;

/** How much of a prompt the list shows. */
const PROMPT_COLUMNS = 60;

/**
 * The whole pane.
 *
 * @param {{ Box: Function, Text: Function }} elements
 * @param {{ live: boolean, dbPath: string, injections: any[] }} view
 * @param {number} columns
 */
export const paneTree = (elements, view, columns = DEFAULT_COLUMNS) => {
    const { Box, Text } = elements;
    const width = Math.max(20, columns - GUTTER);
    const injections = Array.isArray(view?.injections) ? view.injections : [];

    return Box({
        flexDirection: "column",
        paddingX: 1,
        children: [
            Text({ key: "head", bold: true, children: headline(view, injections) }),
            ...(injections.length === 0
                ? [Text({ key: "none", dimColor: true, children: emptyLine(view) })]
                : injections.map((injection, index) => injectionBox(elements, injection, index, width))),
            Text({ key: "db", dimColor: true, children: fit(`db ${view?.dbPath ?? "(unknown)"}`, width) }),
        ],
    });
};

const headline = (view, injections) => {
    const total = injections.reduce((sum, injection) => sum + (injection.entries?.length ?? 0), 0);
    const mode = view?.live === true ? "" : "  (rehearsing: nothing was injected)";

    return `Memories  ${injections.length} prompts, ${total} memories${mode}`;
};

const emptyLine = (view) =>
    view?.live === true
        ? "Nothing injected yet this session."
        : "Nothing injected yet this session. MEMORY_HANDOFF_LIVE is off.";

/** One prompt: what was typed, what the retrieval was, and what went in. */
const injectionBox = (elements, injection, index, width) => {
    const { Box, Text } = elements;
    const entries = Array.isArray(injection?.entries) ? injection.entries : [];

    return Box({
        key: `injection-${index}`,
        flexDirection: "column",
        marginTop: 1,
        children: [
            Text({ key: "prompt", children: fit(`> ${injection?.prompt ?? ""}`, Math.min(width, PROMPT_COLUMNS + 2)) }),
            Text({ key: "trace", dimColor: true, children: fit(traceLine(injection), width) }),
            ...entries.map((entry, rank) =>
                Text({ key: `entry-${rank}`, children: fit(entryLine(rank + 1, entry), width) }),
            ),
        ],
    });
};

/**
 * The accounting line: which trace explains it, how much text it was, and what
 * did not go in. `memory_explain <id>` is the next thing a reader wants, so the
 * id is on every row rather than only on the ones that injected something.
 */
const traceLine = (injection) => {
    const parts = [
        `retrieval ${injection?.retrievalId ?? "-"}`,
        `${injection?.entries?.length ?? 0} in`,
        `${injection?.chars ?? 0} chars`,
        `~${injection?.approxTokens ?? 0} tokens (est)`,
    ];

    if ((injection?.dropped ?? 0) > 0) {
        parts.push(`${injection.dropped} dropped`);
    }

    if (typeof injection?.disposition === "string" && injection.disposition !== "injected") {
        parts.push(injection.disposition);
    }

    return parts.join("  ");
};

const entryLine = (rank, entry) => {
    const score = typeof entry?.score === "number" ? entry.score.toFixed(4) : "-";

    return `  ${rank}. [${entry?.memoryId ?? "-"}] ${entry?.title ?? ""}  ${entry?.scoreKind ?? "score"} ${score}`;
};

/**
 * One line, cut to the body width.
 *
 * Cutting rather than wrapping: the pane scrolls vertically and a wrapped line
 * is the `Code` overdraw bug in another element. The whole text is in the
 * database and `memory_explain` prints it.
 */
export const fit = (text, width) => {
    const line = String(text ?? "").replace(/\s+/gu, " ").trim();

    return line.length <= width ? line : `${line.slice(0, Math.max(1, width - 1))}…`;
};
