/**
 * The SQLite adapter. Every statement retrieval runs is in this file, and
 * nothing in here ranks anything or decides anything: it filters, it reads, it
 * writes the trace.
 *
 * Two rules the SQL here carries:
 *
 * **Filter before search.** `project`, `status` and the optional time range are
 * predicates on `memories`, joined to the FTS index and applied to the vector
 * scan before a single score is computed. That is what keeps the candidate set
 * small enough to rerank and what keeps another project's memories out of the
 * vector arm entirely, rather than filtering them out after they have already
 * displaced something.
 *
 * **Order inside the query, not after it.** SQLite's join order is free to
 * change and an unordered query hands back whatever the index gives, so every
 * ranked read ends `ORDER BY <score>, id ASC`. Two runs that disagree on a tie
 * is the bug that gets blamed on the reranker for a week.
 *
 * Every statement is valid on SQLite 3.37.2, the older of the two builds on
 * this box, because `/usr/bin/sqlite3` is what a human debugging a trace will
 * reach for.
 */

/** Title against body in `bm25()`. The schema documents this weighting; it is repeated in one call site, here. */
export const BM25_WEIGHTS = { title: 3.0, body: 1.0 };

/**
 * @typedef {object} Filters
 * @property {string} project
 * @property {string[]} status
 * @property {string[] | null} types
 * @property {string | null} since ISO timestamp, inclusive, against `created_at`.
 * @property {string | null} until ISO timestamp, inclusive, against `created_at`.
 */

/**
 * The shared predicate, as SQL and its parameters, over an alias for
 * `memories`. `types` is handled by the caller through `typeMode`, because both
 * sides of it are wanted: the candidates a type restriction kept, and the ones
 * it threw away, which earn a `retrieval_candidates` row with a reason.
 *
 * @param {Filters} filters
 * @param {"include" | "exclude" | "ignore"} typeMode
 * @param {string} alias
 * @returns {{ sql: string, params: (string | number)[] }}
 */
export const filterSql = (filters, typeMode = "include", alias = "m") => {
    const clauses = [`${alias}.project = ?`];
    /** @type {(string | number)[]} */
    const params = [filters.project];

    const status = filters.status.length > 0 ? filters.status : ["active"];

    clauses.push(`${alias}.status IN (${placeholders(status.length)})`);
    params.push(...status);

    if (filters.types !== null && typeMode !== "ignore") {
        const negate = typeMode === "exclude" ? "NOT " : "";

        clauses.push(`${alias}.type ${negate}IN (${placeholders(filters.types.length)})`);
        params.push(...filters.types);
    }

    if (filters.since !== null) {
        clauses.push(`${alias}.created_at >= ?`);
        params.push(filters.since);
    }

    if (filters.until !== null) {
        clauses.push(`${alias}.created_at <= ?`);
        params.push(filters.until);
    }

    return { sql: clauses.join(" AND "), params };
};

/**
 * The lexical arm: the filtered set, matched, ordered by BM25.
 *
 * **`bm25()` is negative and lower is better** (measured on this box: a trivial
 * single-row match returns -1.0e-06). Hence `ORDER BY score ASC`, and hence the
 * arm hands its rows out already ranked rather than letting a caller guess.
 *
 * @param {import("bun:sqlite").Database} db
 * @param {{ match: string, filters: Filters, limit: number, typeMode?: "include" | "exclude" }} spec
 * @returns {{ memoryId: number, score: number }[]}
 */
export const ftsHits = (db, spec) => {
    const where = filterSql(spec.filters, spec.typeMode ?? "include");
    const statement = db.query(
        `SELECT m.id AS memoryId, bm25(memories_fts, ${BM25_WEIGHTS.title}, ${BM25_WEIGHTS.body}) AS score
           FROM memories_fts
           JOIN memories m ON m.id = memories_fts.rowid
          WHERE memories_fts MATCH ?
            AND ${where.sql}
          ORDER BY score ASC, m.id ASC
          LIMIT ?`,
    );

    return /** @type {{ memoryId: number, score: number }[]} */ (
        statement.all(spec.match, ...where.params, spec.limit)
    );
};

/**
 * Every stored vector in the filtered set, with the memory's type, so the
 * caller can score them all in one pass and still tell which ones a type
 * restriction excluded.
 *
 * Brute force, per #SCHEMA's open decision: 384 floats is 1536 bytes, the dot
 * products are microseconds, and the real cost is pulling the blobs out of
 * SQLite. `vectors_scanned` goes on the trace so the day that stops being cheap
 * shows up in the data instead of as a feeling.
 *
 * @param {import("bun:sqlite").Database} db
 * @param {{ filters: Filters, model: string }} spec
 * @returns {{ memoryId: number, type: string, vector: Float32Array }[]}
 */
export const vectorRows = (db, spec) => {
    const where = filterSql(spec.filters, "ignore");
    const rows = /** @type {{ memoryId: number, type: string, vector: Uint8Array }[]} */ (
        db
            .query(
                `SELECT m.id AS memoryId, m.type AS type, e.vector AS vector
                   FROM embeddings e
                   JOIN memories m ON m.id = e.memory_id
                  WHERE e.model = ?
                    AND ${where.sql}
                  ORDER BY m.id ASC`,
            )
            .all(spec.model, ...where.params)
    );

    return rows.map((row) => ({ memoryId: row.memoryId, type: row.type, vector: toFloat32(row.vector) }));
};

/**
 * A stored embedding as floats.
 *
 * The copy when the blob is not four-byte aligned is not optional: a
 * `Float32Array` view over an odd offset throws, and `bun:sqlite` hands back a
 * view into a larger buffer.
 *
 * @param {Uint8Array} blob
 * @returns {Float32Array}
 */
export const toFloat32 = (blob) => {
    const aligned = blob.byteOffset % 4 === 0 ? blob : new Uint8Array(blob);

    return new Float32Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 4));
};

/**
 * A vector as the blob the schema stores, for whatever writes `embeddings`.
 *
 * @param {number[] | Float32Array} vector
 * @returns {Uint8Array}
 */
export const vectorToBlob = (vector) => new Uint8Array(Float32Array.from(vector).buffer);

/**
 * Cosine, which is a dot product because both sides are unit-normalised. The
 * runtime normalises what it returns and `embeddings.normalised` records it;
 * nothing here re-normalises, so a vector written by something that did not
 * would score wrong rather than silently rescale.
 *
 * @param {Float32Array | number[]} left
 * @param {Float32Array | number[]} right
 * @returns {number}
 */
export const dot = (left, right) => {
    const width = Math.min(left.length, right.length);
    let total = 0;

    for (let index = 0; index < width; index += 1) {
        total += left[index] * right[index];
    }

    return total;
};

/**
 * The title and body of a set of memories, in `memory_id` order, for the
 * reranker and for the returned rows.
 *
 * @param {import("bun:sqlite").Database} db
 * @param {number[]} memoryIds
 * @returns {Map<number, { memoryId: number, title: string, body: string, type: string, importance: number, createdAt: string }>}
 */
export const textOf = (db, memoryIds) => {
    if (memoryIds.length === 0) {
        return new Map();
    }

    const rows = /** @type {any[]} */ (
        db
            .query(
                `SELECT id AS memoryId, title, body, type, importance, created_at AS createdAt
                   FROM memories
                  WHERE id IN (${placeholders(memoryIds.length)})
                  ORDER BY id ASC`,
            )
            .all(...memoryIds)
    );

    return new Map(rows.map((row) => [row.memoryId, row]));
};

/**
 * The retrieval, its candidates and its cost rows, in one transaction.
 *
 * All or none, for the same reason the generation writer is: a `retrievals` row
 * claiming candidates that are not there is worse than a retrieval nobody
 * recorded, and the explain view reads both tables as one fact.
 *
 * @param {import("bun:sqlite").Database} db
 * @param {{ retrieval: Record<string, unknown>, candidates: Record<string, unknown>[], costs: Record<string, unknown>[], retrievalCostIndex: number | null }} trace
 * @returns {{ retrievalId: number, costIds: number[] }}
 */
export const writeTrace = (db, trace) =>
    db.transaction(() => {
        const costIds = trace.costs.map((row) => insert(db, "costs", row));
        const costId = trace.retrievalCostIndex === null ? null : costIds[trace.retrievalCostIndex];
        const retrievalId = insert(db, "retrievals", { ...trace.retrieval, cost_id: costId });

        for (const candidate of trace.candidates) {
            insert(db, "retrieval_candidates", { ...candidate, retrieval_id: retrievalId });
        }

        return { retrievalId, costIds };
    })();

/**
 * One whole trace, read back from the database and from nothing else. This is
 * what makes `explain` an answer about what happened rather than a second
 * retrieval that might not agree with the first.
 *
 * @param {import("bun:sqlite").Database} db
 * @param {number} retrievalId
 * @returns {{ ok: true, retrieval: any, candidates: any[] } | { ok: false, reason: string }}
 */
export const readTrace = (db, retrievalId) => {
    const retrieval = db.query("SELECT * FROM retrievals WHERE id = ?").get(retrievalId);

    if (retrieval === null || retrieval === undefined) {
        return { ok: false, reason: `no retrieval ${retrievalId} in this database` };
    }

    // NULL sorts before everything in SQLite, so the returned rows would lead
    // with the cuts under a bare `ORDER BY final_rank`. The explicit
    // "has a final rank first" key puts the answer at the top where a human
    // reading the table expects it, and `memory_id` closes every tie.
    const candidates = db
        .query(
            `SELECT c.*, m.title AS title, m.type AS type, m.status AS status, m.importance AS importance
               FROM retrieval_candidates c
               LEFT JOIN memories m ON m.id = c.memory_id
              WHERE c.retrieval_id = ?
              ORDER BY (c.final_rank IS NULL) ASC, c.final_rank ASC,
                       (c.merge_rank IS NULL) ASC, c.merge_rank ASC, c.memory_id ASC`,
        )
        .all(retrievalId);

    return { ok: true, retrieval, candidates };
};

/** @param {import("bun:sqlite").Database} db @param {string} table @param {Record<string, unknown>} row @returns {number} */
const insert = (db, table, row) => {
    const columns = Object.keys(row);
    const statement = db.query(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders(columns.length)})`,
    );

    return Number(statement.run(...columns.map((column) => /** @type {any} */ (row[column]))).lastInsertRowid);
};

/** @param {number} count @returns {string} */
const placeholders = (count) => Array.from({ length: count }, () => "?").join(", ");
