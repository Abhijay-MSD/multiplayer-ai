-- Schema version 4: a room the host archived.
--
--   sessions.archived_at   when the host archived the room from "Your rooms"; NULL for a room that was not. An archived room is
--                          read-only, like one that has been quiet for ARCHIVE_AFTER_DAYS. Unarchiving clears it.
--
-- Existing rooms get NULL: none was archived by a person.

ALTER TABLE sessions ADD COLUMN archived_at TEXT;
