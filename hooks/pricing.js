/**
 * What a fork cost, from the four token counts it reports.
 *
 * The table is copied from compact-handoff's `hooks/lib.js` along with the date
 * it was read, because a wrong number here is silent: it mis-states a cost row
 * and the row still looks like a measurement. Re-read the page before changing
 * `PRICES_TAKEN`, and change the two together.
 *
 * Cache reads are priced and never charged. On a subscription a cache read costs
 * nothing, so the reads are kept as a token count and as what they would have
 * cost at list, and left out of `usd`. Operator, 2026-09-15: "Cache reads are
 * FREE for subscriptions."
 *
 * The Fable/Mythos split is not cosmetic: cache hits are 0.1x base input on
 * every model except Fable 5.1 and Mythos 5.1, which the page prices at 0.025x,
 * so one pattern over both generations under-charges a 5.1 cache read four
 * times. The specific row comes first; the first match wins.
 */

export const COST_BASIS = "subscription: cache reads free";

export const PRICES_TAKEN = "2026-09-14";

export const PRICES_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";

export const PRICES = [
    { match: /fable-5-1|mythos-5-1|fable5-1|mythos5-1/u, name: "Fable/Mythos 5.1", input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    { match: /fable|mythos/u, name: "Fable/Mythos 5", input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    { match: /opus-4-1|opus-4(?!\d)/u, name: "Opus 4.1", input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    { match: /opus/u, name: "Opus 5 / 4.5-4.8", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    { match: /sonnet-5|sonnet5/u, name: "Sonnet 5", input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    { match: /sonnet/u, name: "Sonnet 4.6 and earlier", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    { match: /haiku-3|haiku3/u, name: "Haiku 3.5", input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    { match: /haiku/u, name: "Haiku 4.5", input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
];

/** Which price row a model id falls under, or null when the table cannot say. */
export const priceRowFor = (model) => {
    const id = (model ?? "").toLowerCase();

    return id === "" ? null : PRICES.find((row) => row.match.test(id)) ?? null;
};

/** The four token counts a usage record carries, under either spelling. */
export const usageOf = (usage) => {
    if (usage === null || usage === undefined || typeof usage !== "object") {
        return null;
    }

    const pick = (...keys) => {
        for (const key of keys) {
            if (typeof usage[key] === "number") {
                return usage[key];
            }
        }

        return 0;
    };

    return {
        input: pick("input_tokens", "inputTokens"),
        output: pick("output_tokens", "outputTokens"),
        cacheRead: pick("cache_read_input_tokens", "cacheReadInputTokens"),
        cacheWrite: pick("cache_creation_input_tokens", "cacheCreationInputTokens"),
    };
};

/**
 * What one fork's usage cost, or null with the reason it cannot be said.
 *
 * Never 0 for an unknown. A zero here is summed into a per-day total and read as
 * "this compaction was free", which is the one reading the `costs` table's own
 * CHECK exists to make impossible.
 *
 * @param {unknown} usage
 * @param {string | null | undefined} model
 */
export const priceUsage = (usage, model) => {
    const tokens = usageOf(usage);

    if (tokens === null) {
        return { usd: null, reason: "no usage on the result", tokens: null, priced: null, cacheReadWaivedUsd: null };
    }

    const price = priceRowFor(model);

    if (price === null) {
        return { usd: null, reason: `no price for model ${model ?? "(unset)"}`, tokens, priced: null, cacheReadWaivedUsd: null };
    }

    const usd = (tokens.input * price.input + tokens.output * price.output + tokens.cacheWrite * price.cacheWrite) / 1_000_000;

    return {
        usd: round6(usd),
        reason: null,
        tokens,
        priced: price.name,
        cacheReadWaivedUsd: round6((tokens.cacheRead * price.cacheRead) / 1_000_000),
    };
};

const round6 = (value) => Math.round(value * 1_000_000) / 1_000_000;
