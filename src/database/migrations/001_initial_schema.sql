-- TimeLog migration 001: initial schema.
-- Run inside one transaction. The migration runner (not this file) inserts
-- (1, <epoch ms>) into schema_migrations after this script succeeds.
-- The connection must run PRAGMA foreign_keys = ON every time it opens.
-- Booleans are stored as INTEGER 0 or 1. Timestamps are INTEGER epoch ms (UTC).
-- Money is INTEGER minor units (2550 = 25.50).

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY CHECK (typeof(version) = 'integer' AND version > 0),
  applied_at INTEGER NOT NULL CHECK (typeof(applied_at) = 'integer' AND applied_at >= 0)
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY NOT NULL CHECK (length(key) > 0),
  value TEXT NOT NULL
);

CREATE TABLE clients (
  id         TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  name       TEXT NOT NULL CHECK (length(trim(name)) > 0 AND name = trim(name)),
  email      TEXT,
  address    TEXT,
  currency   TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','GBP','EUR','TJS','TRY','CNY','RUB','KZT','CHF','AED')),
  archived   INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
);

CREATE TABLE projects (
  id                TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  name              TEXT NOT NULL CHECK (length(trim(name)) > 0 AND name = trim(name)),
  client_id         TEXT REFERENCES clients (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  hourly_rate_minor INTEGER CHECK (
                      hourly_rate_minor IS NULL
                      OR (typeof(hourly_rate_minor) = 'integer' AND hourly_rate_minor >= 0)
                    ),
  currency          TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','GBP','EUR','TJS','TRY','CNY','RUB','KZT','CHF','AED')),
  archived          INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at        INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
);

CREATE TABLE time_entries (
  id                TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  project_id        TEXT REFERENCES projects (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  start_at          INTEGER NOT NULL CHECK (typeof(start_at) = 'integer' AND start_at >= 0),
  end_at            INTEGER CHECK (end_at IS NULL OR typeof(end_at) = 'integer'),
  note              TEXT NOT NULL DEFAULT '',
  billable          INTEGER NOT NULL DEFAULT 1 CHECK (billable IN (0, 1)),
  hourly_rate_minor INTEGER CHECK (
                      hourly_rate_minor IS NULL
                      OR (typeof(hourly_rate_minor) = 'integer' AND hourly_rate_minor >= 0)
                    ),
  currency          TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','GBP','EUR','TJS','TRY','CNY','RUB','KZT','CHF','AED')),
  -- Finished entries last 1 minute to 24 hours inclusive (this also forces end_at > start_at).
  CHECK (end_at IS NULL OR (end_at - start_at BETWEEN 60000 AND 86400000)),
  -- Entries without a project carry no rate and use USD.
  CHECK (project_id IS NOT NULL OR (hourly_rate_minor IS NULL AND currency = 'USD'))
);

-- At most one running timer.
CREATE UNIQUE INDEX one_running_entry ON time_entries ((1)) WHERE end_at IS NULL;
CREATE INDEX idx_time_entries_start_at   ON time_entries (start_at);
CREATE INDEX idx_time_entries_end_at     ON time_entries (end_at);
CREATE INDEX idx_time_entries_project_id ON time_entries (project_id);
CREATE INDEX idx_projects_client_id      ON projects (client_id);

-- NOCASE folds ASCII A-Z only. "Design" and "design" collide; "É" and "é" do not.
CREATE TABLE tags (
  id   TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  name TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(name)) > 0 AND name = trim(name)),
  UNIQUE (name)
);

CREATE TABLE entry_tags (
  entry_id TEXT NOT NULL REFERENCES time_entries (id) ON DELETE CASCADE ON UPDATE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (entry_id, tag_id)
) WITHOUT ROWID;

CREATE INDEX idx_entry_tags_tag_id ON entry_tags (tag_id);

CREATE TABLE invoices (
  id              TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  number          TEXT NOT NULL UNIQUE CHECK (length(number) > 0),
  sequence_number INTEGER NOT NULL UNIQUE CHECK (typeof(sequence_number) = 'integer' AND sequence_number > 0),
  client_id       TEXT NOT NULL REFERENCES clients (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  period_start    INTEGER NOT NULL CHECK (typeof(period_start) = 'integer' AND period_start >= 0),
  period_end      INTEGER NOT NULL CHECK (typeof(period_end) = 'integer'),
  currency        TEXT NOT NULL CHECK (currency IN ('USD','GBP','EUR','TJS','TRY','CNY','RUB','KZT','CHF','AED')),
  total_minor     INTEGER NOT NULL CHECK (typeof(total_minor) = 'integer' AND total_minor >= 0),
  lines_json      TEXT NOT NULL CHECK (length(lines_json) > 0),
  sender_json     TEXT NOT NULL CHECK (length(sender_json) > 0),
  client_json     TEXT NOT NULL CHECK (length(client_json) > 0),
  issued_at       INTEGER NOT NULL CHECK (typeof(issued_at) = 'integer' AND issued_at >= 0),
  CHECK (period_end > period_start)
);

CREATE INDEX idx_invoices_client_id ON invoices (client_id);
