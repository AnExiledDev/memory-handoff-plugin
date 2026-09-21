/**
 * The pane's tree, built from plain data.
 *
 * `$` never reaches here: the hook resolves the element table
 * (`$.ui.resolve(e)`) and hands it in, so the whole drawing is testable with
 * factories that record what they were asked for. What a press has to run is
 * handed in the same way, as `actions`, for the same reason.
 *
 * Four rules the terminal surface enforces, each of which has cost somebody a
 * run:
 *
 * - **Children go in `props.children`.** `Box({}, child)` draws an empty frame
 *   and still settles the dispatch, so every call here passes `children`.
 * - **`div`, `span` and `b` stopped being elements at 2.1.267.** Only `Box`,
 *   `Text`, `Button` and `Markdown` are used below.
 * - **`Code` overdraws when it wraps**: at 2.1.269 it honours `wrap` when
 *   drawing and reports its height unwrapped, so a long line paints over the
 *   row beneath it. There is no `Code` here at all, and every line this file
 *   writes itself is broken to the body width before it is handed over.
 * - **`Markdown` is a leaf with no children and a 10,000 character ceiling**,
 *   and it brings its own renderer, so the memory body below goes in whole
 *   rather than cut to the width like the lines around it.
 */

/** Where a line is broken when the pane's width is unknown. */
export const DEFAULT_COLUMNS = 80;

/** How far inside the body width a line is broken, for the frame and the padding. */
const GUTTER = 10;

/** How much of a prompt the list shows. */
const PROMPT_COLUMNS = 60;

/** `Markdown`'s own ceiling on `text`; over it the element is refused, not cut. */
const MARKDOWN_CEILING = 10000;

/**
 * The address of one memory row, and the key a press is answered under.
 *
 * Built from the position rather than the memory id: the same memory retrieved
 * for two prompts is two rows, and a key that collided would open both.
 */
export const rowKey = (injectionIndex, rank) => `entry:${injectionIndex}:${rank}`;

/**
 * The whole pane.
 *
 * @param {{ Box: Function, Text: Function, Button?: Function, Markdown?: Function }} elements
 * @param {{ live: boolean, dbPath: string, injections: any[], openKey?: string | null }} view
 * @param {number} columns
 * @param {{ toggle?: (key: string) => void }} actions
 */
export const paneTree = (elements, view, columns = DEFAULT_COLUMNS, actions = {}) => {
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
                : injections.map((injection, index) =>
                      injectionBox(elements, injection, index, width, view, actions),
                  )),
            Text({ key: "db", dimColor: true, children: fit(`db ${view?.dbPath ?? "(unknown)"}`, width) }),
        ],
    });
};

/**
 * Two knobs can leave the pane with memories it never attached, and the mode
 * has to name the one actually in force. `inject` is checked first because a
 * person who set it chose it, where `live` off is the shipped default.
 */
const headline = (view, injections) => {
    const total = injections.reduce((sum, injection) => sum + (injection.entries?.length ?? 0), 0);

    return `Memories  ${injections.length} prompts, ${total} memories${modeOf(view)}`;
};

const modeOf = (view) => {
    if (view?.injecting === false) return "  (storing only: nothing was injected)";

    return view?.live === true ? "" : "  (rehearsing: nothing was injected)";
};

const emptyLine = (view) => {
    if (view?.injecting === false) {
        return "Nothing injected yet this session. MEMORY_HANDOFF_INJECT is off.";
    }

    return view?.live === true
        ? "Nothing injected yet this session."
        : "Nothing injected yet this session. MEMORY_HANDOFF_LIVE is off.";
};

/** One prompt: what was typed, what the retrieval was, and what went in. */
const injectionBox = (elements, injection, index, width, view, actions) => {
    const { Box, Text } = elements;
    const entries = Array.isArray(injection?.entries) ? injection.entries : [];

    return Box({
        key: `injection-${index}`,
        flexDirection: "column",
        marginTop: 1,
        children: [
            Text({ key: "prompt", children: fit(`> ${injection?.prompt ?? ""}`, Math.min(width, PROMPT_COLUMNS + 2)) }),
            Text({ key: "trace", dimColor: true, children: fit(traceLine(injection), width) }),
            ...entries.flatMap((entry, rank) => memoryRow(elements, entry, index, rank, width, view, actions)),
        ],
    });
};

/**
 * One memory: the scored line, and its text beneath when it is the open one.
 *
 * The line is a `Button` wherever a press can be answered, so the person can
 * read what actually went into their prompt without leaving the pane and
 * without spending a turn on `memory_explain`. Where no press can be answered
 * — a surface with no `Button`, or a caller that handed in no `toggle` — it
 * stays the `Text` it was, and the pane is what it was before.
 *
 * `autoFocus` on the very first row means the pane's focus ring starts on
 * something Enter can act on rather than on nothing, as the declarations'
 * `autoFocus` is meant.
 */
const memoryRow = (elements, entry, injectionIndex, rank, width, view, actions) => {
    const { Text, Button, Markdown } = elements;
    const key = rowKey(injectionIndex, rank);
    const isOpen = view?.openKey === key;
    const label = fit(entryLine(rank + 1, entry, isOpen), width);
    const pressable = typeof Button === "function" && typeof actions?.toggle === "function";

    const line = pressable
        ? Button({
              key,
              plain: true,
              label,
              dimColor: isOpen !== true,
              ...(injectionIndex === 0 && rank === 0 ? { autoFocus: true } : {}),
              onPress: () => actions.toggle(key),
          })
        : Text({ key, children: label });

    if (isOpen !== true) {
        return [line];
    }

    return [line, ...bodyBlock({ Text, Markdown }, entry, key, width)];
};

/**
 * The memory's own text, drawn as the markdown it is.
 *
 * Nothing is cut to the width here: `Markdown` wraps and measures its own
 * wrapping, which is what makes it safe where `Code` is not. Over the
 * element's own ceiling the text is trimmed rather than handed over, because
 * a refused element takes the whole drawing with it.
 */
const bodyBlock = ({ Text, Markdown }, entry, key, width) => {
    const body = typeof entry?.body === "string" ? entry.body.trim() : "";

    if (body === "") {
        return [Text({ key: `${key}:empty`, dimColor: true, children: fit("    (no text stored for this memory)", width) })];
    }

    if (typeof Markdown !== "function") {
        return body.split("\n").map((line, index) => Text({ key: `${key}:line-${index}`, children: fit(`    ${line}`, width) }));
    }

    return [Markdown({ key: `${key}:body`, text: body.slice(0, MARKDOWN_CEILING) })];
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

const entryLine = (rank, entry, isOpen = false) => {
    const score = typeof entry?.score === "number" ? entry.score.toFixed(4) : "-";
    const marker = isOpen === true ? "v" : ">";

    return `  ${marker} ${rank}. [${entry?.memoryId ?? "-"}] ${entry?.title ?? ""}  ${entry?.scoreKind ?? "score"} ${score}`;
};

/**
 * One line, cut to the body width.
 *
 * Cutting rather than wrapping: the pane scrolls vertically and a wrapped line
 * is the `Code` overdraw bug in another element. The whole text is in the
 * database, `memory_explain` prints it, and since 0.7.0 a press on the row
 * opens it in place.
 */
export const fit = (text, width) => {
    const line = String(text ?? "").replace(/\s+/gu, " ").trim();

    return line.length <= width ? line : `${line.slice(0, Math.max(1, width - 1))}…`;
};
