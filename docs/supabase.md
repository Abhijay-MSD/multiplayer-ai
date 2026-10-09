# Supabase storage (optional)

Multiplayer AI keeps its data in a local file by default. Supabase is the other choice:
a Postgres database you run, for a copy that other people reach over the internet.

**Status: frozen, and not yet checked against a real project.** The
code that talks to Supabase is the same set of queries it always used, moved into
`server/store/supabase.js`, and it is tested against an in-memory stand-in
(`server/test/fakeSupabase.js`). The stand-in does not enforce Postgres rules, so
that is not proof. The check below does the proving.

## Use it

1. Run each file in `supabase/migrations/`, in order (`0001` to `0004`), in the
   Supabase SQL editor.
2. Install the library, which is not part of the default install. It has its own small
   package folder, `server/supabase-lib`, so installing it cannot change what
   `npm start` installs, and the server's own `npm ci` cannot remove it:

   ```bash
   cd "<the repo>/server/supabase-lib" && npm ci
   ```

   (Do not use `npm install --no-save @supabase/supabase-js` in `server/`. It does
   nothing useful there.)
3. Set `MULTIPLAYER_AI_STORE=supabase`, `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (the
   `service_role` key; it stays on the server). With this store the old defaults
   apply: the daily step budget of 200 and the per-IP limits.

`SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in `server/.env` do nothing by themselves
any more. Without `MULTIPLAYER_AI_STORE=supabase` the server uses the local file, and says so
when it starts.

## Check it against your project

This runs the storage rules against your real project. It creates a few rooms titled
`live-check ...` and deletes them at the end. It never calls the daily budget function
(that would spend a real step); it only reads the budget table. It prints no key.

```bash
cd "<the repo>/server/supabase-lib" && npm ci
cd .. && MULTIPLAYER_AI_LIVE_SUPABASE=1 node --test test/supabase.live.test.js
```

It reads `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` from the environment or from
`server/.env`. All tests should pass. A failure names the rule that did not hold.

## Known differences from the local file

- Names are unique per room by Postgres `lower(name)`. The local file uses the app's own
  comparison (compatibility forms such as full-width letters count as the same). The app
  checks names itself before inserting, so people see the same behavior either way.
- Handing control over is two statements on Supabase and one transaction locally.
- Supabase does not report its own writes to the live stream, so the stream reads the
  database every 3 seconds, as before. The local file reports them at once.
