-- Multiplayer AI local data file, schema version 1.
--
-- The same rules as the Postgres migrations in supabase/migrations (0001 to
-- 0004), written for SQLite. Keep the two in step: rules.js is the third copy.
--
--   * Timestamps are ISO 8601 text in UTC with milliseconds ("2026-10-08T12:00:00.000Z"),
--     so comparing them as text is comparing them as times.
--   * Event ids are never reused (AUTOINCREMENT).
--   * Names are unique per room by name_key, which the store fills with the
--     app's own nameKey() (NFKC + lowercase). SQLite's lower() only folds ASCII.

CREATE TABLE sessions (
  id          TEXT    PRIMARY KEY,
  title       TEXT    NOT NULL,
  task        TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done')),
  step_count  INTEGER NOT NULL DEFAULT 0 CHECK (step_count >= 0),
  agent_working INTEGER NOT NULL DEFAULT 0 CHECK (agent_working IN (0, 1)),
  summary     TEXT,
  summarized_through_event_id INTEGER,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (length(task) <= 4000 AND length(title) <= 120)
);

CREATE TABLE session_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('agent_message', 'directive', 'join', 'takeover', 'status', 'comment')),
  author      TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  reply_to    INTEGER REFERENCES session_events(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (kind NOT IN ('directive', 'comment') OR length(content) <= 4000)
);

CREATE INDEX session_events_session_id_idx ON session_events (session_id, id);

CREATE TABLE session_participants (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'watcher' CHECK (role IN ('controller', 'watcher')),
  last_seen   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  token_hash        TEXT,
  token_expires_at  TEXT,
  token_revoked_at  TEXT,
  PRIMARY KEY (session_id, name),
  CHECK (length(trim(name)) BETWEEN 1 AND 40 AND lower(trim(name)) NOT IN ('agent', 'system'))
);

CREATE UNIQUE INDEX session_participants_name_key_idx ON session_participants (session_id, name_key);
CREATE UNIQUE INDEX session_participants_token_hash_idx ON session_participants (token_hash) WHERE token_hash IS NOT NULL;

-- Every new event bumps its room's updated_at. Archiving is worked out from it.
CREATE TRIGGER session_event_bump_updated_at
AFTER INSERT ON session_events
FOR EACH ROW
BEGIN
  UPDATE sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.session_id;
END;

-- The daily step budget: one row per UTC day.
CREATE TABLE usage_daily (
  day   TEXT    PRIMARY KEY,
  steps INTEGER NOT NULL DEFAULT 0 CHECK (steps >= 0)
);
