-- Multiplayer AI — shared state schema
--
-- Builds the whole current schema from scratch in a FRESH Supabase project:
--   Dashboard → SQL Editor → paste this file → Run
-- (or: supabase db push, if using the CLI).
--
-- It is one pass, not a migration: it will error on a project that already has
-- these tables. Order: tables, trigger, Realtime, then row-level security.
--
-- Who touches the database:
--   • The orchestrator (server/) uses the service_role key. That role bypasses
--     RLS, so it can do every read and write the code needs.
--   • The web app uses the anon key and only READS: it subscribes to Realtime
--     changes on all three tables (web/src/hooks/useSession.js). Every mutation
--     goes through the orchestrator's tools (web/src/api.js).

-- ── sessions ──────────────────────────────────────────────────────
CREATE TABLE sessions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text        NOT NULL,
  task        text        NOT NULL,
  status      text        NOT NULL DEFAULT 'active'
                          CONSTRAINT sessions_status_check CHECK (status IN ('active', 'paused', 'done')),
  step_count  integer     NOT NULL DEFAULT 0,
  -- true while the orchestrator is running a step (the live "agent is working" signal)
  agent_working boolean   NOT NULL DEFAULT false,
  -- short running summary of events no longer sent to the model in full
  summary     text,
  -- highest event id already folded into the summary
  summarized_through_event_id bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── session_events ────────────────────────────────────────────────
CREATE TABLE session_events (
  id          bigint      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  session_id  uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- 'comment' is room chat the agent never sees
  kind        text        NOT NULL
                          CONSTRAINT session_events_kind_check
                          CHECK (kind IN ('agent_message','directive','join','takeover','status','comment')),
  author      text        NOT NULL,
  content     text        NOT NULL,
  -- the directive an agent_message answers
  reply_to    bigint      REFERENCES session_events(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX session_events_session_id_idx ON session_events(session_id);

-- ── session_participants ──────────────────────────────────────────
CREATE TABLE session_participants (
  session_id  uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  role        text        NOT NULL DEFAULT 'watcher'
                          CONSTRAINT session_participants_role_check CHECK (role IN ('controller', 'watcher')),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, name)
);

-- ── Trigger: bump sessions.updated_at on every new event ─────────
CREATE OR REPLACE FUNCTION bump_session_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.sessions SET updated_at = now() WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER session_event_bump_updated_at
AFTER INSERT ON session_events
FOR EACH ROW EXECUTE FUNCTION bump_session_updated_at();

-- ── Realtime on all three tables ──────────────────────────────────
-- Supabase Realtime broadcasts Postgres changes to every subscribed client,
-- which is what makes the session room "live" without a custom WebSocket layer.
ALTER PUBLICATION supabase_realtime ADD TABLE sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE session_events;
ALTER PUBLICATION supabase_realtime ADD TABLE session_participants;

-- ── Row-level security ────────────────────────────────────────────
-- RLS is on for every table. The browser (anon, or a signed-in user) may read
-- and subscribe; with RLS on, Realtime delivers a row only if a SELECT policy
-- lets that role see it. There are deliberately no INSERT/UPDATE/DELETE
-- policies: browsers cannot write, and the service_role key bypasses RLS.
--
-- Read access is still open to anyone holding the project's anon key (PRD §15):
-- treat session ids as unguessable but not secret, and scope reads to
-- participants before any real launch.
ALTER TABLE sessions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_participants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anyone can read sessions"
  ON sessions FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "anyone can read session_events"
  ON session_events FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "anyone can read session_participants"
  ON session_participants FOR SELECT TO anon, authenticated USING (true);

-- Table privileges, stated explicitly so this works whether or not the project
-- grants new public tables to the API roles by default. RLS decides which rows;
-- these decide which operations are possible at all.
GRANT SELECT ON sessions, session_events, session_participants TO anon, authenticated;
GRANT ALL    ON sessions, session_events, session_participants TO service_role;

-- ── Check it worked (optional; run after the above) ──────────────
--   select tablename, rowsecurity from pg_tables
--    where schemaname = 'public' and tablename like 'session%';             -- all three: true
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and schemaname = 'public';         -- all three listed
--   select tablename, policyname, cmd from pg_policies
--    where schemaname = 'public';                                           -- three SELECT policies
--   select conname from pg_constraint
--    where conrelid = 'public.session_events'::regclass and contype = 'c';  -- session_events_kind_check
