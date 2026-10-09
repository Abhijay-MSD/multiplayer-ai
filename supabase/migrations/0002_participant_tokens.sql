-- 0002: participant tokens and unique names.
--
-- Run in the Supabase SQL editor of the project, AFTER 0001. Safe to re-run,
-- and safe on a project that already has test rows (see "Existing rows").
--
-- Each person who creates or joins a room gets a secret token from the server.
-- Only its SHA-256 hash is stored here; the browser keeps the token itself.
-- The server derives who someone is (name, role) from the token, never from a
-- name the client sends.
--
-- Existing rows: participants that predate this migration have no token. They
-- cannot act (nothing authenticates as them), and their names can be reclaimed
-- by a new person once they have been away for a minute, so a room whose
-- controller predates this migration frees up by itself.

ALTER TABLE session_participants ADD COLUMN IF NOT EXISTS token_hash        text;
ALTER TABLE session_participants ADD COLUMN IF NOT EXISTS token_expires_at  timestamptz;
ALTER TABLE session_participants ADD COLUMN IF NOT EXISTS token_revoked_at  timestamptz;

-- One participant per token. Partial, because legacy rows have none.
CREATE UNIQUE INDEX IF NOT EXISTS session_participants_token_hash_idx
  ON session_participants (token_hash) WHERE token_hash IS NOT NULL;

-- Names are unique within a room regardless of letter case. If a test room
-- already has two names that differ only by case, rename the later ones first
-- ("sam" and "Sam" become "sam" and "Sam (2)") so the index can be built.
WITH ranked AS (
  SELECT session_id, name,
         row_number() OVER (PARTITION BY session_id, lower(name) ORDER BY last_seen DESC, name) AS rn
    FROM session_participants
)
UPDATE session_participants p
   SET name = p.name || ' (' || r.rn || ')'
  FROM ranked r
 WHERE p.session_id = r.session_id AND p.name = r.name AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS session_participants_name_ci_idx
  ON session_participants (session_id, lower(name));

-- A person cannot be called "agent" or "system", which are the authors the
-- server uses for the agent's replies and for status lines. NOT VALID checks
-- new and changed rows only, so existing test rows cannot make this fail.
ALTER TABLE session_participants DROP CONSTRAINT IF EXISTS session_participants_name_check;
ALTER TABLE session_participants ADD CONSTRAINT session_participants_name_check
  CHECK (char_length(btrim(name)) BETWEEN 1 AND 40 AND lower(btrim(name)) NOT IN ('agent', 'system'))
  NOT VALID;

-- ── Check it worked (optional) ───────────────────────────────────
--   select column_name from information_schema.columns
--    where table_name = 'session_participants' and column_name like 'token%';  -- 3 rows
--   select indexname from pg_indexes
--    where tablename = 'session_participants';  -- includes the two new indexes
