# Bring your own key: design

Status: a design only. Nothing here is built, and no code, table or setting
exists for it yet.

## Why

The demo pays for every step out of the operator's budget, which is why there is
a daily cap. A person who wants more than the cap, or wants their work billed to
their own account, could supply their own provider key. Their steps then cost
the operator nothing.

## What it must guarantee

1. The key is **encrypted at rest**, and the database alone can't decrypt it.
2. The key is **never logged**, including inside error messages.
3. The key is **never returned to any client**, including the person who set it.
4. It lives only as long as it is needed, and it goes when the room ends.

## Whose key, and where it lives

Today nobody has an account. A person is a name and a token inside one room, so
the key can't belong to a person across rooms. The first version is
**room-scoped**: the controller sets a key for a room, and that room's steps use
it. When accounts exist, a key can belong to an account and be chosen per room.
Only the table's owner column changes.

A new table, kept apart from `sessions` so the existing column allowlists and
exports can never pick it up by accident:

| Column | Purpose |
|---|---|
| `session_id` | Primary key, foreign key to `sessions`, `ON DELETE CASCADE` |
| `provider` | Which provider the key is for |
| `ciphertext`, `nonce` | The encrypted key and its random nonce |
| `key_version` | Which master key encrypted it, for rotation |
| `set_by`, `set_at` | Who set it and when. These are the only fields ever shown |

Row-level security is on with no policies, and the anon and signed-in roles have
no privileges, exactly as the other tables. Only the orchestrator's service role
can read it.

## Encryption

Application-level AES-256-GCM, done in the orchestrator before anything is sent
to the database.

- A master key of 32 random bytes in an environment variable on the server, such
  as `KEY_ENCRYPTION_KEY`, and never in the database or the repo. A second one,
  `KEY_ENCRYPTION_KEY_PREVIOUS`, is kept only while rotating.
- A fresh random 96-bit nonce for every encryption.
- The room id and provider name are bound in as authenticated data, so a
  ciphertext copied into another room's row fails to decrypt.
- Rotation: a script decrypts with the version recorded in `key_version` and
  re-encrypts with the current one.

Why not the database's own secret storage: it decrypts inside the database, so a
database leak or an over-broad query role can reach plaintext. With
application-level encryption a copy of the database alone gives only ciphertext.
The cost is that the server environment becomes the single place worth
protecting.

If the master key is missing, the server must refuse to accept a key, and must
not store one unencrypted.

## Getting the key in

- A dedicated controller-only tool, `set_room_key`, with the key in the request
  body and never in a URL (URLs end up in logs, history and referrers).
- Only over HTTPS. The tool is refused outright when `NODE_ENV` is production
  and the connection isn't secure.
- Before saving, one minimal test call with the key to confirm it works and
  belongs to the named provider. A bad key is refused with a plain message.
- Submissions are rate limited per IP and per room, because a tool that tests
  keys is also a way to check stolen ones.
- The web field is a password-type input that is never saved by the browser:
  not in local storage, not in session storage, not in a draft. It is cleared the
  moment the request is sent.

## Never logged

The existing logging records messages and timings, not request bodies. The new
risk is indirect: some provider libraries put the key in the request address or
echo it in an error, and the server logs those messages.

- Provider calls made with a room key pass their errors through a `redact()` step
  that removes the exact key and anything shaped like a key before the message is
  logged, written as a status line, or returned.
- Request logging, if it is ever added, must skip the `set_room_key` body.
- The key is not put in the step queue's jobs, in event rows, in the rolling
  summary's prompt, or in any exported transcript. The queue holds ids only; the
  step looks the key up itself, decrypts it for that one call, and drops it.
- A test sends a key with a recognizable marker through every error path and
  searches the captured log output, event rows and responses for it.

## Never returned

- There is no tool that reads a key. After saving, the only answer is
  `{ has_key: true, provider, set_by, set_at }`.
- The same summary, without the key or the ciphertext, goes to participants in
  the room state so everyone can see that steps are being billed to the
  controller's key.
- Reads of the table always name their columns. The ciphertext columns are
  selected in exactly one place, the step that needs them.
- `scripts/export-session.mjs` and the stream carry no key fields. A test checks
  this the way the stream already checks that no token fields are sent.
- Removing a key is a controller action that deletes the row.

## Lifetime

- The row goes with the room (`ON DELETE CASCADE`), and the key is deleted when
  the controller ends the room. Archiving is worked out on read and nothing
  sweeps, so decrypting is also refused in a room that is no longer open.
- A handoff doesn't move the key. It stays the setter's, and when the setter
  hands control to someone else the room goes back to the shared budget until
  the new controller sets one. (An open decision; see below.)

## How it fits with the limits

- Steps paid by a room key don't count against `DAILY_STEP_BUDGET`. That budget
  protects the operator's key.
- Message rate limits, size limits and the per-room step cap still apply. A key
  that is the user's own is not a reason to allow a runaway loop.
- If the user's key is rejected or out of quota, the step fails with a status
  line that says so. It does not fall back to the operator's key.

## Threats and answers

| Threat | Answer |
|---|---|
| Database copy leaks | Only ciphertext; no master key in it |
| Server environment leaks | The master key is exposed; this is the one place to guard. Rotate the master key and ask users to replace theirs |
| A watcher tries to read the key | No read path exists; the controller can't read it back either |
| Key appears in logs or error text | Redaction on every path that uses it, and a test that looks for it |
| Moved ciphertext | The room id is part of the authenticated data |
| Submission used to test stolen keys | Rate limits and controller-only access |

## Open decisions

1. Room-scoped first, or wait for accounts?
2. On a handoff, does the key stay with the setter or go to the new controller?
3. Should a key stay after a room is paused, or only while it is open?
4. Which providers are allowed? Each has its own error format to redact.
