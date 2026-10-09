-- 0004: the daily step budget, and size limits as a second guard.
--
-- Run in the Supabase SQL editor of your project, AFTER 0003. Safe to re-run,
-- and it only adds things: a server from before this change keeps working
-- against it. Run it BEFORE starting the new server, which refuses to start
-- while the usage_daily table is missing.
--
-- What it adds
--   usage_daily       one row per UTC day: how many agent steps were started.
--   claim_step(cap)   takes one step from today's budget in a single atomic
--                     statement and says whether it was allowed. When today's
--                     count has reached `cap` it takes nothing. Only the
--                     orchestrator (service_role) can call it or read the table.
--   size checks       the server already refuses oversize text; these checks
--                     keep the database honest if something writes around it.
--                     NOT VALID means only new and changed rows are checked, so
--                     rows from before this migration can't make it fail.
--
-- Do not test claim_step by calling it: every call spends a step from today's
-- budget. The checks at the bottom read catalogs only.

CREATE TABLE IF NOT EXISTS public.usage_daily (
  day   date    PRIMARY KEY,
  steps integer NOT NULL DEFAULT 0 CHECK (steps >= 0)
);

ALTER TABLE public.usage_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.usage_daily FROM anon, authenticated;
GRANT  ALL ON public.usage_daily TO service_role;

CREATE OR REPLACE FUNCTION public.claim_step(p_cap integer)
RETURNS TABLE (allowed boolean, used integer)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  d date := (now() AT TIME ZONE 'utc')::date;
  n integer;
BEGIN
  INSERT INTO public.usage_daily (day, steps) VALUES (d, 0) ON CONFLICT (day) DO NOTHING;
  UPDATE public.usage_daily SET steps = steps + 1
   WHERE day = d AND steps < p_cap
  RETURNING steps INTO n;
  IF n IS NULL THEN
    SELECT steps INTO n FROM public.usage_daily WHERE day = d;
    RETURN QUERY SELECT false, n;
  ELSE
    RETURN QUERY SELECT true, n;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_step(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_step(integer) TO service_role;

-- Size limits. Keep these in step with MAX_MESSAGE_CHARS and MAX_TITLE_CHARS
-- in server/config.js (the server may lower them, never raise them past these).
ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_size_check;
ALTER TABLE public.sessions ADD CONSTRAINT sessions_size_check
  CHECK (char_length(task) <= 4000 AND char_length(title) <= 120) NOT VALID;

ALTER TABLE public.session_events DROP CONSTRAINT IF EXISTS session_events_size_check;
ALTER TABLE public.session_events ADD CONSTRAINT session_events_size_check
  CHECK (kind NOT IN ('directive', 'comment') OR char_length(content) <= 4000) NOT VALID;

-- ── Check it worked (optional; these only read catalogs) ─────────
--   select has_table_privilege('anon', 'public.usage_daily', 'select');                 -- false
--   select has_table_privilege('service_role', 'public.usage_daily', 'select');         -- true
--   select has_function_privilege('anon', 'public.claim_step(integer)', 'execute');     -- false
--   select has_function_privilege('service_role', 'public.claim_step(integer)', 'execute'); -- true
--   select conname from pg_constraint where conname like '%size_check';                 -- 2 rows
