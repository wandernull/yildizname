-- Migration 0001 — readings table.
-- Stores one row per generated yıldızname.
-- form_data: JSON of the user-submitted FormData (FormData type in src/lib/types.ts).
-- sections: JSON of the full YildiznameSections payload (free + locked).
-- unlocked: 0 = preview only, 1 = full reading visible to client.
-- created_at: ISO 8601 UTC, set by SQLite default.

CREATE TABLE readings (
  id          TEXT PRIMARY KEY,
  form_data   TEXT NOT NULL,
  sections    TEXT NOT NULL,
  unlocked    INTEGER NOT NULL DEFAULT 0 CHECK (unlocked IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_readings_created_at ON readings (created_at);
