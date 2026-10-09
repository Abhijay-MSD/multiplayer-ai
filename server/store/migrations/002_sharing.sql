-- Schema version 2: what sharing a room needs.
--
--   sessions.invite_version   the number the room's invite secret is derived from; raising it makes
--                             the old share link stop working for new joiners (people already in
--                             the room keep their tokens).
--   sessions.guest_step_cap   how many messages to the agent people other than the host may send in
--                             this room; NULL means the default in force.
--   sessions.control_policy   who may change the controller when the room is shared: 'locked' (only
--                             the host), 'ask' (the host approves each change) or 'free' (the usual rules).
--   session_participants.is_host   this person joined with the host's sign-in cookie.
--
-- Existing rooms get version 1, the default cap, the 'ask' policy and nobody marked as host.

ALTER TABLE sessions ADD COLUMN invite_version INTEGER NOT NULL DEFAULT 1 CHECK (invite_version >= 1);
ALTER TABLE sessions ADD COLUMN guest_step_cap INTEGER CHECK (guest_step_cap IS NULL OR guest_step_cap >= 0);
ALTER TABLE sessions ADD COLUMN control_policy TEXT NOT NULL DEFAULT 'ask' CHECK (control_policy IN ('locked', 'ask', 'free'));
ALTER TABLE session_participants ADD COLUMN is_host INTEGER NOT NULL DEFAULT 0 CHECK (is_host IN (0, 1));
