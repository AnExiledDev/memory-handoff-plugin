/**
 * The fork's reply, turned into candidate rows or into reasons.
 *
 * Total by construction: every line is either a row or a rejection carrying why,
 * and nothing here throws. A generation that cannot be parsed is a `generations`
 * row with a count and a reason on it, never a lost dispatch, because this runs
 * inside `session.compact` and a throw there is somebody's compaction.
 *
 * Linear in the length of the reply. Parsing is the hook's own compute, and the
 * hook's own compute is what the ten second dispatch budget measures, so a
 * quadratic scan here would spend the budget the fork itself did not.
 */

/** The four types the schema's CHECK takes, and `auto-memory.md`'s vocabulary. */
export const TYPES = ["user", "feedback", "project", "reference"];

/** The schema's own caps. A row over one of these is rejected, never clipped. */
export const TITLE_CAP = 200;

export const BODY_CAP = 4000;

const OPEN = "<memories>";

const CLOSE = "</memories>";

/**
 * @typedef {object} MemoryRow
 * @property {string} type
 * @property {string} title
 * @property {string} body
 * @property {number} importance
 * @property {string | null} supersedesHint
 */

/**
 * @typedef {object} ParsedReply
 * @property {MemoryRow[]} rows
 * @property {{ line: number, reason: string }[]} rejected
 * @property {null | "length" | "truncated row"} hitCap
 * @property {boolean} hadBlock
 */

/**
 * Reads one fork reply.
 *
 * `line` on a rejection is the 1-based line number inside the reply, and 0 when
 * the whole reply is the problem, which is the prose case: no `<memories>` block
 * at all is one rejection reading `no block`, and no second paid call to ask
 * again (a repair is another fork over the same transcript, and a model that
 * ignored the format once is not cheap to talk round).
 *
 * @param {string} text
 * @returns {ParsedReply}
 */
export const parseReply = (text) => {
    const reply = typeof text === "string" ? text : "";
    const opensAt = reply.indexOf(OPEN);

    if (opensAt === -1) {
        return { rows: [], rejected: [{ line: 0, reason: "no block" }], hitCap: null, hadBlock: false };
    }

    const closesAt = reply.indexOf(CLOSE, opensAt);
    const bodyStart = opensAt + OPEN.length;
    const inside = closesAt === -1 ? reply.slice(bodyStart) : reply.slice(bodyStart, closesAt);
    const firstLine = lineOf(reply, bodyStart);
    const rows = [];
    const rejected = [];
    let lastLine = "";

    inside.split("\n").forEach((raw, index) => {
        const line = raw.trim();

        if (line === "") {
            return;
        }

        lastLine = line;

        const read = rowFrom(line);

        if (read.row === null) {
            rejected.push({ line: firstLine + index, reason: read.reason });

            return;
        }

        rows.push(read.row);
    });

    return { rows, rejected, hitCap: capReason(closesAt === -1, lastLine), hadBlock: true };
};

/**
 * Whether the reply stopped at the engine's output ceiling, and how it showed.
 *
 * A closed block is a finished answer whatever its length. An unclosed one ended
 * somewhere it did not choose: mid-row when the last line is not a whole JSON
 * object, and between rows when it is. That is compact-handoff's own
 * `length` / `truncated row` distinction, kept because the two want different
 * readings later - a run that ran out of room versus one that lost a memory.
 *
 * @param {boolean} unclosed
 * @param {string} lastLine
 * @returns {null | "length" | "truncated row"}
 */
const capReason = (unclosed, lastLine) => {
    if (!unclosed) {
        return null;
    }

    return isWholeObject(lastLine) ? "length" : "truncated row";
};

const isWholeObject = (line) => {
    try {
        return typeof JSON.parse(line) === "object";
    } catch {
        return false;
    }
};

/**
 * One line, read as a memory or refused with the reason a human would give.
 *
 * Unknown keys are ignored rather than refused: a model adding a `why` field is
 * answering the question, and the schema stores what it stores.
 *
 * @param {string} line
 * @returns {{ row: MemoryRow | null, reason: string }}
 */
const rowFrom = (line) => {
    let parsed = null;

    try {
        parsed = JSON.parse(line);
    } catch {
        return refuse("not JSON");
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return refuse("not an object");
    }

    const { type, title, body, importance } = parsed;

    if (typeof type !== "string" || !TYPES.includes(type)) {
        return refuse(`unknown type ${quoted(type)}`);
    }

    if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
        return refuse(`importance ${quoted(importance)} is not a whole number from 1 to 5`);
    }

    const titleRead = textField(title, "title", TITLE_CAP);

    if (titleRead.reason !== null) {
        return refuse(titleRead.reason);
    }

    const bodyRead = textField(body, "body", BODY_CAP);

    if (bodyRead.reason !== null) {
        return refuse(bodyRead.reason);
    }

    return {
        row: {
            type,
            title: titleRead.text,
            body: bodyRead.text,
            importance,
            supersedesHint: hintFrom(parsed.supersedes_hint),
        },
        reason: "",
    };
};

/** @param {unknown} value @param {string} name @param {number} cap */
const textField = (value, name, cap) => {
    if (typeof value !== "string" || value.trim() === "") {
        return { text: "", reason: `${name} is missing` };
    }

    const text = value.trim();

    if (text.length > cap) {
        return { text: "", reason: `${name} is ${text.length} characters, over the ${cap} the schema takes` };
    }

    return { text, reason: null };
};

/** A hint that is not a string is dropped, because the row itself is still good. */
const hintFrom = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

const refuse = (reason) => ({ row: null, reason });

/** How a refused value is named back, short enough for a row field. */
const quoted = (value) => (typeof value === "string" ? `"${value.slice(0, 40)}"` : String(value).slice(0, 40));

/** Which line of the whole reply an offset falls on, 1-based. */
const lineOf = (reply, offset) => {
    let line = 1;

    for (let at = 0; at < offset; at += 1) {
        if (reply[at] === "\n") {
            line += 1;
        }
    }

    return line;
};
