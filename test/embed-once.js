/**
 * One embedding, printed as JSON, in a process of its own.
 *
 * Determinism across two calls inside one process proves very little: the
 * session is the same object and the arena is warm. The test spawns this twice
 * and compares the bytes, which is the reading a stored vector and a
 * re-embedded one actually depend on.
 *
 *     bun test/embed-once.js "some text" query
 */

import { createRuntime } from "../runtime/infer.js";

const text = process.argv[2] ?? "the monitor tick pulls the checkout every five minutes";
const kind = process.argv[3] === "query" ? "query" : "document";
const result = await createRuntime().embed([text], { kind });

if (!result.ok) {
    console.error(result.reason);
    process.exit(1);
}

console.log(JSON.stringify({ vector: result.vectors[0], dim: result.dim, model: result.model, truncated: result.truncated[0] }));
