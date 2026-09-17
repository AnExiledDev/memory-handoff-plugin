/**
 * Turning a prompt into the two things the arms need: an FTS5 MATCH expression
 * and the text the embedder sees. Pure — no database, no runtime, no clock.
 *
 * **Nothing from the prompt is ever interpolated raw into a MATCH.** A prompt
 * is full of FTS5 syntax that is either an operator or a syntax error: a bare
 * `"`, a `*`, a `-` prefix, `AND`, `OR`, `NOT`, `NEAR`, an unbalanced
 * parenthesis. So the prompt is tokenised down to letters and digits, each
 * token is quoted as a string literal, and the quoted tokens are OR-joined.
 * Quoting a token that has already been stripped to `[\p{L}\p{N}]+` is belt and
 * braces, and it is deliberate: it is the rule that survives somebody widening
 * the tokeniser later.
 *
 * The query text is the raw prompt (`retrievals.query_source = 'raw-prompt'`),
 * decided in #683: zero cost, zero latency, and the column exists so an
 * extracted query can be compared against it on real traffic rather than
 * argued about now.
 */

/**
 * Tokens shorter than this carry no retrievable signal and match a large share
 * of the corpus through the porter stemmer. "y", "ok" and "a" are the prompts
 * this exists for.
 */
export const MIN_TOKEN_CHARS = 2;

/**
 * How many distinct tokens reach the MATCH expression.
 *
 * A pasted 4 KB stack trace tokenises into hundreds of terms, and an OR of
 * hundreds of terms matches most of the corpus at a cost linear in the terms.
 * The first 32 distinct content words of a prompt are the prompt; the tail is
 * the paste. Cut deterministically, from the front, and say so on the trace.
 */
export const MAX_MATCH_TOKENS = 32;

/**
 * How much of the prompt the embedder sees.
 *
 * Both models stop at 512 tokens and the runtime truncates at the tokenizer
 * anyway. Cutting here first, at a character count, is what makes the cut
 * deterministic and visible: English runs about four characters to a token, so
 * 2000 characters sits under the window even once bge's query prefix is added,
 * and the same text reaches the embedder on every run.
 */
export const MAX_QUERY_CHARS = 2000;

/**
 * How much of the prompt the reranker sees.
 *
 * Smaller than the embedder's window for two reasons, both measured on this box
 * on 2026-09-17 (30 candidates, the shipped int8 jina-reranker-v1-tiny-en).
 *
 * **Cost.** The reranker is a cross-encoder: one forward pass per (query,
 * document) pair, linear in query length. Thirty pairs took 6.6 s against 2000
 * characters and 1.3 s against 600, and `search()` gives any one runtime call
 * 5000 ms because the caller is a prompt on its way out. At 2000 characters the
 * call always lost that race, so a pasted log got merge order and no reranking
 * at all.
 *
 * **The window.** Query and document share one 512-token sequence. 2000
 * characters of query tokenise to 390, leaving 122 for the memory, so the
 * reranker was scoring a prompt against a document it could barely see. 600
 * characters tokenise to 123 and leave 389, which fits a memory's title and
 * body whole.
 *
 * The FTS5 arm still sees the full prompt, so a distinguishing word in the cut
 * tail reaches the merge order even when the reranker never sees it.
 */
export const MAX_RERANK_QUERY_CHARS = 600;

/**
 * The words dropped before the MATCH is built. Deliberately short: this is a
 * stopword list, not a linguistic model, and every word removed from a query is
 * recall somebody cannot get back.
 */
export const STOPWORDS = new Set([
    "a", "about", "after", "again", "all", "also", "am", "an", "and", "any", "are", "as", "at",
    "be", "because", "been", "before", "being", "but", "by",
    "can", "could", "did", "do", "does", "doing", "done", "down",
    "each", "for", "from", "further", "get", "got",
    "had", "has", "have", "having", "he", "her", "here", "hers", "him", "his", "how",
    "i", "if", "in", "into", "is", "it", "its", "itself", "just",
    "let", "like", "me", "more", "most", "my", "no", "nor", "not", "now",
    "of", "off", "ok", "okay", "on", "once", "only", "or", "other", "ought", "our", "ours", "out", "over", "own",
    "please", "same", "she", "should", "so", "some", "such",
    "than", "thanks", "that", "the", "their", "theirs", "them", "then", "there", "these", "they",
    "this", "those", "through", "to", "too",
    "under", "until", "up", "us", "very", "was", "we", "were", "what", "when", "where", "which",
    "while", "who", "whom", "why", "will", "with", "would",
    "yes", "you", "your", "yours",
]);

/**
 * @typedef {object} MatchExpression
 * @property {string} expression The FTS5 MATCH expression, "" when there is nothing to match on.
 * @property {boolean} empty True when no token survived, so the caller skips the FTS arm entirely.
 * @property {string | null} emptyReason Why it is empty, for the trace.
 * @property {string[]} tokens The tokens that made it in, in order.
 * @property {{ stopword: number, short: number, overCap: number }} dropped
 */

/**
 * The MATCH expression for a prompt.
 *
 * @param {string} query
 * @returns {MatchExpression}
 */
export const buildMatch = (query) => {
    const raw = typeof query === "string" ? query : "";
    const words = raw.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");

    const dropped = { stopword: 0, short: 0, overCap: 0 };
    /** @type {string[]} */
    const tokens = [];
    const seen = new Set();

    for (const word of words) {
        if (word.length < MIN_TOKEN_CHARS) {
            dropped.short += 1;
            continue;
        }

        if (STOPWORDS.has(word)) {
            dropped.stopword += 1;
            continue;
        }

        if (seen.has(word)) continue;

        if (tokens.length >= MAX_MATCH_TOKENS) {
            dropped.overCap += 1;
            continue;
        }

        seen.add(word);
        tokens.push(word);
    }

    if (tokens.length === 0) {
        return { expression: "", empty: true, emptyReason: emptyReasonFor(raw, words), tokens, dropped };
    }

    return {
        expression: tokens.map(quoteToken).join(" OR "),
        empty: false,
        emptyReason: null,
        tokens,
        dropped,
    };
};

/**
 * The prompt as the embedder will see it, cut to a fixed character count.
 *
 * @param {string} query
 * @returns {{ text: string, truncated: boolean, chars: number }}
 */
export const truncateForEmbedding = (query) => cutTo(query, MAX_QUERY_CHARS);

/**
 * The prompt as the reranker will see it, cut to `MAX_RERANK_QUERY_CHARS`.
 *
 * A separate cut from the embedder's, and deliberately so: the two models cost
 * different amounts per character and divide the same 512-token window
 * differently. See `MAX_RERANK_QUERY_CHARS`.
 *
 * @param {string} query
 * @returns {{ text: string, truncated: boolean, chars: number }}
 */
export const truncateForRerank = (query) => cutTo(query, MAX_RERANK_QUERY_CHARS);

/**
 * One deterministic cut, from the front, reporting the length before it.
 *
 * @param {string} query
 * @param {number} limit
 * @returns {{ text: string, truncated: boolean, chars: number }}
 */
const cutTo = (query, limit) => {
    const raw = typeof query === "string" ? query : "";

    if (raw.length <= limit) {
        return { text: raw, truncated: false, chars: raw.length };
    }

    return { text: raw.slice(0, limit), truncated: true, chars: raw.length };
};

/**
 * An FTS5 string literal. Doubling an embedded `"` is FTS5's own escape, and
 * it is what stops a widened tokeniser from turning a prompt into syntax.
 *
 * @param {string} token
 * @returns {string}
 */
export const quoteToken = (token) => `"${token.replace(/"/gu, '""')}"`;

/** @param {string} raw @param {string[]} words @returns {string} */
const emptyReasonFor = (raw, words) => {
    if (raw.trim() === "") {
        return "the query is empty";
    }

    if (words.length === 0) {
        return "the query has no letters or digits in it";
    }

    return "every word in the query is a stopword or too short to search on";
};
