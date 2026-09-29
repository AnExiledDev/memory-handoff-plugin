-- memory-handoff, migration 002: whether an injected memory showed up in the
-- turn it was handed to.
--
-- One row per (injection, memory) for a turn that was scored. The signal is an
-- echo: how many of the memory's own words, the ones the prompt did not
-- already carry, the model wrote back during that turn. It costs no model call.
-- It is a proxy for use, not a measurement of it; the README says what it does
-- and does not mean.
--
-- The absence of a row is a fact of its own and is never a negative: every
-- injection written before this migration, a turn that was interrupted or
-- errored, and a turn whose answer never reached the hook all have none, and
-- read as unknown.
--
-- Not on `memories`: that table is immutable past its status, and the signal
-- belongs to the injection. `memory_id` carries no foreign key for the reason
-- `injections.memory_ids` carries none, so a purged memory leaves its record
-- here intact. `IF NOT EXISTS` so a database that somehow holds the table
-- without the version stamp still migrates.
CREATE TABLE IF NOT EXISTS injection_echoes (
  injection_id   INTEGER NOT NULL REFERENCES injections(id),
  memory_id      INTEGER NOT NULL,
  at             TEXT NOT NULL,
  turn_id        TEXT,
  verdict        TEXT NOT NULL CHECK (verdict IN ('echoed','silent','indistinct')),
  distinct_terms INTEGER NOT NULL CHECK (distinct_terms >= 0),
  echoed_terms   INTEGER NOT NULL CHECK (echoed_terms >= 0 AND echoed_terms <= distinct_terms),
  echoed         TEXT NOT NULL CHECK (json_valid(echoed)),
  written_chars  INTEGER NOT NULL,
  PRIMARY KEY (injection_id, memory_id)
);

CREATE INDEX IF NOT EXISTS injection_echoes_memory ON injection_echoes(memory_id, verdict);
