/**
 * The pure half of the usefulness signal: whether a memory handed to a turn
 * shows up in what that turn wrote.
 *
 * The signal is an echo, and it costs nothing: no model call, no tool the model
 * has to remember to call. A memory's distinctive words are the ones the prompt
 * did not already carry; if the model wrote enough of them back during the
 * turn, the memory is `echoed`, and if it wrote too few it is `silent`. A memory
 * with no word the prompt lacked is `indistinct`, because nothing it could add
 * is observable.
 *
 * It is a proxy and the README says so at length: an echo is not proof of use,
 * silence is not proof of uselessness, and a contradiction reads as an echo.
 * Nothing here touches `$`; `hooks/module.js` reads the transcript and writes
 * the rows.
 */

/** How many distinctive words must come back before a memory counts as echoed. */
export const ECHO_MIN_TERMS = 3;

/** How many of the echoed words a row keeps, so a row stays a row. */
export const ECHO_SAMPLE = 12;

/** Shorter than this and a word is too common to be anybody's evidence. */
const MIN_TERM_CHARS = 4;

/**
 * Words of four letters or more that say nothing about any one memory. Short on
 * purpose: a word missing here costs a coincidental echo, and the threshold is
 * three words, not one.
 */
const STOPWORDS = new Set(
    (
        "about above after again against also although always another anything because been before being below " +
        "between both cannot could does doing done down during each either else even ever every first from " +
        "further have having here into itself just know like made make many might more most much must need " +
        "never next only other ought over same should since some something still such than that their theirs " +
        "them themselves then there these they thing things this those though through under until upon very " +
        "want well were what when where whether which while whom whose will with within without would your " +
        "yours yourself sure okay yeah look looks looking think thanks please right"
    ).split(" "),
);

/**
 * The words of a text as a set: lower case, letters and digits, four or more of
 * them, stopwords out, and a trailing plural `s` folded off so "locks" and
 * "lock" are one word.
 *
 * @param {unknown} text
 * @returns {Set<string>}
 */
export const termsOf = (text) => {
    const terms = new Set();

    if (typeof text !== "string") {
        return terms;
    }

    for (const [word] of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
        const folded = foldPlural(word);

        if (folded.length >= MIN_TERM_CHARS && !STOPWORDS.has(folded) && !STOPWORDS.has(word)) {
            terms.add(folded);
        }
    }

    return terms;
};

const foldPlural = (word) => (word.length > MIN_TERM_CHARS && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);

/**
 * One memory's echo in one turn.
 *
 * @param {{ title?: unknown, body?: unknown }} memory What was injected.
 * @param {unknown} prompt The prompt the memory was injected with.
 * @param {string} writing What the turn wrote, from `turnWriting`.
 * @returns {{ verdict: "echoed" | "silent" | "indistinct", distinctTerms: number, echoedTerms: number, echoed: string[] }}
 */
export const echoOf = (memory, prompt, writing) => scoreAgainst(memory, termsOf(prompt), termsOf(writing));

/**
 * Every injected memory's echo in one turn, the prompt and the writing split
 * into words once for all of them.
 *
 * @param {{ memoryId: number, title?: unknown, body?: unknown }[]} memories
 * @param {unknown} prompt
 * @param {string} writing
 */
export const echoesOf = (memories, prompt, writing) => {
    const asked = termsOf(prompt);
    const written = termsOf(writing);

    return memories.map((memory) => ({ memoryId: memory.memoryId, ...scoreAgainst(memory, asked, written) }));
};

const scoreAgainst = (memory, asked, written) => {
    const distinctive = [...termsOf(`${memory?.title ?? ""}\n${memory?.body ?? ""}`)].filter((term) => !asked.has(term));
    const echoed = distinctive.filter((term) => written.has(term)).sort();

    return {
        verdict: verdictFor(distinctive.length, echoed.length),
        distinctTerms: distinctive.length,
        echoedTerms: echoed.length,
        echoed: echoed.slice(0, ECHO_SAMPLE),
    };
};

const verdictFor = (distinctTerms, echoedTerms) => {
    if (distinctTerms === 0) {
        return "indistinct";
    }

    return echoedTerms >= Math.min(ECHO_MIN_TERMS, distinctTerms) ? "echoed" : "silent";
};

/**
 * What the model wrote during the turn that just ended: every assistant text
 * and every string it passed to a tool at any depth of its arguments, back to
 * the prompt, then the final answer.
 *
 * Tool results are left out, because a file the model read is not a file the
 * model wrote, and so is the prompt, which already has its words subtracted. A
 * user message carrying tool results is part of the turn; the first user
 * message without any is where the turn began.
 *
 * @param {unknown} messages `$.session.messages()`, or whatever it answered.
 * @param {unknown} answer `turn.complete`'s `answer`.
 * @returns {string}
 */
export const turnWriting = (messages, answer) => {
    const parts = [];
    const transcript = Array.isArray(messages) ? messages : [];

    for (let index = transcript.length - 1; index >= 0; index -= 1) {
        const message = transcript[index];

        if (message?.role === "user") {
            if (Array.isArray(message.toolResults) && message.toolResults.length > 0) {
                continue;
            }

            break;
        }

        parts.unshift(...assistantWriting(message));
    }

    if (typeof answer === "string" && answer !== "") {
        parts.push(answer);
    }

    return parts.join("\n");
};

/** One assistant message's own words: its text, then its tools' string arguments. */
const assistantWriting = (message) => {
    const text = typeof message?.text === "string" && message.text !== "" ? [message.text] : [];
    const uses = Array.isArray(message?.toolUses) ? message.toolUses : [];
    const argumentsWritten = uses.flatMap((use) => stringsIn(use?.input));

    return [...text, ...argumentsWritten];
};

/** Every non-empty string in a tool's arguments, however deep: MultiEdit's `edits`, TodoWrite's `todos`, an MCP tool's objects. */
const stringsIn = (value) => {
    if (typeof value === "string") {
        return value === "" ? [] : [value];
    }

    if (Array.isArray(value)) {
        return value.flatMap(stringsIn);
    }

    if (value !== null && typeof value === "object") {
        return Object.values(value).flatMap(stringsIn);
    }

    return [];
};
