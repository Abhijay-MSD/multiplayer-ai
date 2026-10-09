-- Schema version 5: the room brief.
--
--   sessions.brief   a short text the host sets for the room (at most 1500 characters). Everyone in the room can read it and the
--                    agent is given it as the host's instructions. Empty means none. Existing rooms get none.

ALTER TABLE sessions ADD COLUMN brief TEXT NOT NULL DEFAULT '' CHECK (length(brief) <= 1500);
