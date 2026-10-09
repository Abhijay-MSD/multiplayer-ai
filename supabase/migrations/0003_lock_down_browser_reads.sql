-- 0003: the browser no longer talks to the database.
--
-- Run in the Supabase SQL editor, AFTER 0002, and only once the server and web
-- app from this change are the ones pointed at this project. The web app now
-- reads everything through the server (a stream authenticated by the
-- participant token), so the anon key has no use for the tables any more.
-- Safe to re-run.
--
-- Result: with the anon key, listing sessions, events or participants returns
-- nothing / is refused. The server uses the service_role key, which bypasses
-- RLS, so it is unaffected.

DROP POLICY IF EXISTS "anyone can read sessions"             ON sessions;
DROP POLICY IF EXISTS "anyone can read session_events"       ON session_events;
DROP POLICY IF EXISTS "anyone can read session_participants" ON session_participants;

-- RLS stays enabled with no policies: deny by default.
ALTER TABLE sessions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_participants ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON sessions, session_events, session_participants FROM anon, authenticated;

-- Supabase Realtime is no longer used by the app. Take the tables out of the
-- publication so the database stops doing the work for nobody.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sessions', 'session_events', 'session_participants'] LOOP
    IF EXISTS (SELECT 1 FROM pg_publication_tables
                WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- ── Check it worked (optional) ───────────────────────────────────
--   select count(*) from pg_policies where schemaname = 'public';            -- 0
--   select count(*) from pg_publication_tables
--    where pubname = 'supabase_realtime' and schemaname = 'public';           -- 0
--   select has_table_privilege('anon', 'public.sessions', 'select');          -- false
