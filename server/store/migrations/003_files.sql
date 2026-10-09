-- Schema version 3: files a room's agent can read and write.
--
--   sessions.files_enabled   the host's switch, per room: may the agent use the file tools in this room.
--                            Existing rooms get 0 (off); the host can turn it on in Host controls.
--   sessions.model_calls     how many model calls this room has made, for the per-room cap on calls.
--   room_files               one row per saved version of a file. The newest version of a name is the
--                            file; older rows are its history (the code keeps at most 10 per file).
--                            Files live here and nowhere else: no path is ever built from a name.
--
-- name_key is the name in lower case, so two names that differ only in letter case are the same file.
-- size is the length in bytes of content, and the database checks that it is.

ALTER TABLE sessions ADD COLUMN files_enabled INTEGER NOT NULL DEFAULT 0 CHECK (files_enabled IN (0, 1));
ALTER TABLE sessions ADD COLUMN model_calls INTEGER NOT NULL DEFAULT 0 CHECK (model_calls >= 0);

CREATE TABLE room_files (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name_key      TEXT    NOT NULL,
  version       INTEGER NOT NULL CHECK (version >= 1),
  name          TEXT    NOT NULL,
  content       TEXT    NOT NULL,
  size          INTEGER NOT NULL CHECK (size >= 0 AND size = length(CAST(content AS BLOB))),
  author        TEXT    NOT NULL,
  on_behalf_of  TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (length(name) BETWEEN 1 AND 64 AND name_key = lower(name)),
  UNIQUE (session_id, name_key, version)
);

CREATE INDEX room_files_session_idx ON room_files (session_id, name_key, version);

-- A saved file counts as activity in its room, like an event does.
CREATE TRIGGER room_file_bump_updated_at
AFTER INSERT ON room_files
FOR EACH ROW
BEGIN
  UPDATE sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.session_id;
END;
