-- memory-handoff, migration 001: the whole store as of 0.2.0.
--
-- Valid on SQLite 3.37.2, which is the older of the two SQLite builds on the
-- box this was written for (the system `sqlite3`, against 3.53.0 inside
-- `bun:sqlite`). So: no STRICT tables, no RETURNING, no `->>` operator.
--
-- No PRAGMA lines live here. `journal_mode`, `foreign_keys` and `busy_timeout`
-- are connection state rather than schema, two of the three do not survive the
-- connection that ran them, and a migration file that sets them hides from the
-- adapter that it is the one responsible. `schema/bun-sqlite.js` sets all three
-- on open.

-- One row, ever. The CHECK is what makes "the version" a fact rather than a
-- query that can answer twice.
CREATE TABLE schema_meta (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  version    INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);

-- What a model call cost, normalised into columns rather than kept as JSON,
-- because a status command has to sum a day of these.
--
-- `usd` NULL means unknown and is never a zero; a real zero (no model call was
-- made) carries `cost_note`. The CHECK is that rule: a zero with nothing to
-- explain it is refused. `cost_unknown_reason` is set exactly when `usd` is
-- NULL, by convention rather than by CHECK, so a writer can record a reason
-- beside a price it did manage to work out.
--
-- `cache_read_waived_usd` is priced at list and deliberately not added to
-- `usd`: on a subscription a cache read costs nothing. `basis` says which
-- arithmetic produced the row, which is the only way to sum a mixed history.
CREATE TABLE costs (
  id                          INTEGER PRIMARY KEY,
  at                          TEXT NOT NULL,
  kind                        TEXT NOT NULL CHECK (kind IN
                                ('generation','query-embed','rerank','retrieval','injection')),
  model                       TEXT,
  usd                         REAL,
  cache_read_waived_usd       REAL,
  input_tokens                INTEGER,
  output_tokens               INTEGER,
  cache_read_input_tokens     INTEGER,
  cache_creation_input_tokens INTEGER,
  basis                       TEXT NOT NULL,
  priced                      TEXT,
  prices_taken                TEXT,
  cost_unknown_reason         TEXT,
  cost_note                   TEXT,
  CHECK (usd IS NULL OR usd > 0 OR cost_note IS NOT NULL)
);

-- One row per attempt to turn a compaction into memories, including the
-- attempts that wrote nothing. An outcome of 'wrote' with zero
-- `memories_written` is legitimate only for a fork that answered an empty list.
CREATE TABLE generations (
  id               INTEGER PRIMARY KEY,
  at               TEXT NOT NULL,
  session_id       TEXT,
  compaction_n     INTEGER,
  trigger          TEXT,
  agent_id         TEXT,
  project          TEXT NOT NULL,
  messages_in      INTEGER,
  transcript_chars INTEGER,
  outcome          TEXT NOT NULL CHECK (outcome IN
                     ('wrote','cold','empty','skipped','failed','overBudget')),
  outcome_reason   TEXT,
  memories_written INTEGER NOT NULL DEFAULT 0,
  parsed_rows      INTEGER,
  rejected_rows    INTEGER,
  hit_output_cap   INTEGER,
  elapsed_ms       INTEGER,
  cost_id          INTEGER REFERENCES costs(id),
  plugin           TEXT,
  engine           TEXT
);

-- The memories themselves.
--
-- `project` is the normalised git remote, then the git toplevel path, then the
-- cwd; the raw cwd and which of the three answered go in `source`, never in the
-- key. The empty string is refused so that a future global scope has to be a
-- deliberate schema bump rather than a writer with an unset variable.
--
-- `title` and `body` are capped because a model that ignores the length
-- instruction must not be able to store an unbounded blob the reranker then has
-- to read. The writer clips first and records the original length in
-- `source.clipped`.
--
-- Update is insert-plus-supersede: the successor carries `supersedes`, the
-- ancestor's `status` becomes 'superseded', and `memories_one_successor` makes
-- a second successor for one ancestor impossible.
CREATE TABLE memories (
  id            INTEGER PRIMARY KEY,
  uuid          TEXT NOT NULL UNIQUE,
  project       TEXT NOT NULL CHECK (project <> ''),
  type          TEXT NOT NULL CHECK (type IN ('user','feedback','project','reference')),
  title         TEXT NOT NULL CHECK (length(title) <= 200),
  body          TEXT NOT NULL CHECK (length(body) <= 4000),
  importance    INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
  status        TEXT NOT NULL CHECK (status IN ('active','superseded','invalidated','deleted')),
  supersedes    INTEGER REFERENCES memories(id),
  source        TEXT NOT NULL CHECK (json_valid(source)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  generation_id INTEGER REFERENCES generations(id)
);

CREATE INDEX memories_lookup ON memories(project, status, type, created_at);

CREATE UNIQUE INDEX memories_one_successor
  ON memories(supersedes) WHERE supersedes IS NOT NULL;

-- Only `status`, `updated_at` and `supersedes` may ever be written twice. The
-- rule is here rather than in prose because the FTS index below is
-- external-content: an UPDATE that rewrote `body` would leave the index holding
-- text that is no longer in the table, and nothing would say so.
CREATE TRIGGER memories_immutable
BEFORE UPDATE ON memories
FOR EACH ROW
WHEN OLD.uuid          IS NOT NEW.uuid
  OR OLD.project       IS NOT NEW.project
  OR OLD.type          IS NOT NEW.type
  OR OLD.title         IS NOT NEW.title
  OR OLD.body          IS NOT NEW.body
  OR OLD.importance    IS NOT NEW.importance
  OR OLD.source        IS NOT NEW.source
  OR OLD.created_at    IS NOT NEW.created_at
  OR OLD.generation_id IS NOT NEW.generation_id
BEGIN
  SELECT RAISE(ABORT, 'memories is immutable except status, updated_at and supersedes');
END;

-- FTS5 over the text only. Every metadata filter is a join against `memories`,
-- not a column here, so the index never has to be rewritten when a status
-- changes. The documented query shape weights the title:
-- `bm25(memories_fts, 3.0, 1.0)`.
CREATE VIRTUAL TABLE memories_fts USING fts5(
  title, body,
  content='memories', content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
END;

CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO memories_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

-- 384 float32 is 1536 bytes a memory, so 20,000 memories is 30.7 MB resident
-- and a brute-force scan of that many dot products is single-digit
-- milliseconds. That is the number at which sqlite-vec becomes the answer;
-- `dtype = 'i8'` is the cheaper lever before it.
--
-- Keyed on (memory_id, model) so an embedding written for a model that is later
-- replaced coexists with its successor. Retrieval names the model it queries
-- and never mixes two vector spaces.
CREATE TABLE embeddings (
  memory_id  INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  dtype      TEXT NOT NULL CHECK (dtype IN ('f32','i8')),
  normalised INTEGER NOT NULL DEFAULT 1,
  vector     BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, model)
) WITHOUT ROWID;

-- One row per retrieval, whatever it returned, so a retrieval that found
-- nothing is as inspectable as one that found ten.
CREATE TABLE retrievals (
  id           INTEGER PRIMARY KEY,
  at           TEXT NOT NULL,
  session_id   TEXT,
  turn_id      TEXT,
  origin       TEXT NOT NULL CHECK (origin IN ('prompt','tool','manual')),
  query_text   TEXT NOT NULL,
  query_source TEXT NOT NULL CHECK (query_source IN ('raw-prompt','extracted')),
  filters      TEXT NOT NULL CHECK (json_valid(filters)),
  k            INTEGER NOT NULL,
  fts_n        INTEGER,
  vector_n     INTEGER,
  merged_n     INTEGER,
  reranked_n   INTEGER,
  returned_n   INTEGER NOT NULL,
  ms_total     INTEGER,
  ms_embed     INTEGER,
  ms_fts       INTEGER,
  ms_vector    INTEGER,
  ms_rerank    INTEGER,
  degraded     TEXT,
  cost_id      INTEGER REFERENCES costs(id)
);

-- Every candidate a retrieval considered, including the ones it threw away:
-- `filtered_reason` says why, and `final_rank` is NULL when it did not make
-- top-k. Without the discarded rows a bad retrieval is unexplainable.
--
-- `bm25()` is negative and lower is better; cosine is higher is better. The
-- two score columns are kept apart for that reason.
CREATE TABLE retrieval_candidates (
  retrieval_id    INTEGER NOT NULL REFERENCES retrievals(id) ON DELETE CASCADE,
  memory_id       INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  from_fts        INTEGER NOT NULL DEFAULT 0,
  from_vector     INTEGER NOT NULL DEFAULT 0,
  fts_rank        INTEGER,
  fts_score       REAL,
  vector_rank     INTEGER,
  vector_score    REAL,
  merge_score     REAL,
  merge_rank      INTEGER,
  rerank_score    REAL,
  final_rank      INTEGER,
  filtered_reason TEXT,
  PRIMARY KEY (retrieval_id, memory_id)
);

-- What was actually put in front of the model. `memory_ids` is a JSON array of
-- ids in injected order, so a purged memory leaves the record of having been
-- injected intact and takes only its text away.
CREATE TABLE injections (
  id            INTEGER PRIMARY KEY,
  retrieval_id  INTEGER NOT NULL REFERENCES retrievals(id),
  at            TEXT NOT NULL,
  session_id    TEXT,
  turn_id       TEXT,
  memory_ids    TEXT NOT NULL CHECK (json_valid(memory_ids)),
  entries       INTEGER NOT NULL,
  chars         INTEGER NOT NULL,
  approx_tokens INTEGER NOT NULL,
  cap_chars     INTEGER NOT NULL,
  cap_entries   INTEGER NOT NULL,
  dropped       INTEGER NOT NULL DEFAULT 0,
  clipped_chars INTEGER NOT NULL DEFAULT 0
);

INSERT INTO schema_meta (id, version, applied_at)
  VALUES (1, 1, strftime('%Y-%m-%dT%H:%M:%SZ','now'));
