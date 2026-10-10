# Cost and abuse limits

What stops one person, or one script, from running up the model bill or filling
rooms with junk. Every limit can be set in `server/.env`; the defaults are
placeholders. Change them to fit your provider's quota and your traffic.

A blank setting uses the default. A setting that is filled in but isn't a whole
number above 0 stops the server at startup, with every problem listed, so a
typo can't quietly turn into the default.

| Setting | Default | What it limits |
|---|---|---|
| `DAILY_STEP_BUDGET` | 200 | Agent replies per UTC day, all rooms together |
| `CREATE_LIMIT_PER_HOUR` | 5 | Rooms one IP may start per hour |
| `JOIN_LIMIT_PER_HOUR` | 30 | New people one IP may add per hour |
| `DIRECTIVE_LIMIT_PER_MIN` | 6 | Messages to the agent, per person per room |
| `COMMENT_LIMIT_PER_MIN` | 20 | Room comments, per person per room |
| `MAX_PARTICIPANTS_PER_ROOM` | 25 | People in one room |
| `MAX_MESSAGE_CHARS` | 4000 | A task, message or comment (lower only) |
| `MAX_TITLE_CHARS` | 120 | A session title; longer ones are cut (lower only) |
| `MAX_BODY_KB` | 32 | One JSON request |
| `TRUST_PROXY_HOPS` | 0 | Proxies in front of the server (see below) |
| `MAX_FILE_KB` | 200 | One room file, in KB (1 KB = 1024 bytes) |
| `MAX_FILES_PER_ROOM` | 50 | Files in one room |
| `MAX_ROOM_FILES_KB` | 2048 | Everything one room's files hold, counting kept versions |
| `TOOL_CALLS_PER_DIRECTIVE` | 12 | File tool calls to answer one message |
| `MODEL_CALLS_PER_DIRECTIVE` | 8 | Model calls to answer one message, when the agent uses file tools |
| `TOOL_RESULT_KB` | 20 | The most a tool result fed back to the model may hold |
| `DIRECTIVE_SECONDS` | 120 | Time to answer one message, when the agent uses file tools |
| `MODEL_CALLS_PER_ROOM` | 200 | Model calls one room may make in all |
| `MAX_OUTPUT_TOKENS` | blank | The longest answer one reply may be asked for, in tokens (see below) |

"Lower only": the database checks and the web inputs are fixed at 4000 and 120
characters, so these two settings can be set below that, never above. The server
refuses to start if they are.

The server prints every limit at startup, so the log shows what is in force.

## On a local copy

When storage is the local data file (the default), three of these are **off unless
you set them**: `DAILY_STEP_BUDGET`, `CREATE_LIMIT_PER_HOUR` and `JOIN_LIMIT_PER_HOUR`.
The model key is yours, on your computer, and by default only this computer can reach
the app. If you let people on your Wi-Fi in (see [sharing.md](sharing.md)), every reply they
cause is paid for by your key; guests are limited to `GUEST_STEP_CAP_PER_ROOM` messages to
the agent per room. Set any of the three to a whole number to turn it on. Everything else
keeps its default, including the per-person pacing and the cap on agent replies per
room (`MAX_STEPS_PER_SESSION`, 50 if blank). With Supabase storage all three keep the
defaults in the table above.

## How long a reply may be

`MAX_OUTPUT_TOKENS` is the most one reply is asked for, in tokens (a token is a few characters; a word is about 1.3 tokens).

- **Blank:** what is sent depends on the provider. One provider's API makes the caller send a number, so Multiplayer AI sends 16000 tokens (roughly 12000 words) to it; to the others it sends no cap, and the provider's own default applies. That default depends on the provider, the model and your account: look it up. The list is in [providers.md](providers.md).
- **Set to a number:** it applies to every provider. Where the provider's limit counts the model's thinking tokens too, room for the thinking is added on top, so the number limits the answer, not the reasoning. A model whose own maximum is lower than the number may refuse the request.

The agent is told to do what a message asks at the length asked, and to say so and write in parts when the work will not fit in one reply. When the provider reports that it stopped a reply at its own length limit, the part that was written is saved as the reply, and the room shows the line **The reply reached its length limit** with a **Continue** button. Only the controller sees the button. It sends "Continue from where you stopped" as a message like any other, so everything that limits a message limits it: only the controller can send it, the host's limit on guest messages, `DIRECTIVE_LIMIT_PER_MIN`, the daily step budget and the step cap per room, and it counts as a step. For that message the agent is shown the start and the end of its newest reply, so it can find where it stopped.

**Token limits depend on the provider, the model and your account, and they change. Look them up in the provider's own documentation and in your account's settings.** That covers the longest reply a model can write, how many tokens an account may use per minute or per day, and what a provider does with a request that asks for more than its model allows (some refuse it). If a reply is cut short, or a request is refused, check those first, and set `MAX_OUTPUT_TOKENS` to a number your model allows. **None of this has been tested against real providers**: the requests were written from each provider's documentation and run against stand-ins.

## When the provider limits how fast the key can be used

Most providers also limit a key themselves, by tokens or requests per minute, per day or per month. **Per-minute limits depend on the provider, the model and your account, and they change. Look them up in the provider's own documentation and in your account's settings.** A free or new account is often limited far more tightly than a paid one.

**A single long task can pass a per-minute limit.** Every model call sends the room's context again: the instructions, the host's brief, the task, the recent messages (up to `MAX_CONTEXT_TOKENS`), and, when the agent uses files, the tool definitions and everything it has written or read so far in this answer. A task that writes a long document in sections makes several calls, and each one carries the sections written before it, so the tokens used in one minute grow faster than the document does. The limit counts what is asked for as well as what was used. **Ask for long work in smaller pieces**: one part at a time, or a shorter version first, and press Continue between them.

What the room is told is one of two sentences, and never the provider's own words, a model name, an organization, an account detail or an address:

- A wait of 120 seconds or less: "The model provider is limiting how fast this key can be used. Try again in about N seconds." (second, for one)
- A longer wait, or none: "The model provider is limiting this key. Check the provider's console for the limit, then try again."

A daily or monthly limit, or a billing or credit problem, always gets the second sentence, however short a wait came with it: it is not a wait of seconds. The host's terminal keeps the provider's own detail, with keys, organization identifiers and the query strings of addresses hidden, and says how long the provider asked to wait.

On that line the controller gets a **Continue** button. It sends "Continue from where you stopped" as a message like any other: it counts as a step, and everything that limits a message limits it (see "Sending a message again" below). Only the controller sees it; anyone else's attempt is refused and costs nothing. With the first sentence the button counts down the provider's wait, from when the line was written, and is ready when it is over; a screen reader is told the wait once and told when it is over, and the bar that empties does not move when the person prefers reduced motion. With the second sentence the button is ready at once.

Multiplayer AI does not add any automatic retry for this: the adapters make the same retries as before, and the next try is the person's, by pressing Continue. How the provider's wait is read from its answer is described in [providers.md](providers.md), and **it is tested only against stand-ins**, not against any real provider.

## Sending a message again

"Send my last message again" (the controller only, off while the agent is working) writes the controller's last message into the room again as a new message and asks the agent to answer it. Because it is a message, everything that limits a message limits it: only the controller can send it, the host's limit on guest messages (a guest who holds control can't use it to get past that limit), `DIRECTIVE_LIMIT_PER_MIN`, the daily step budget and the step cap per room.

## What each limit does when it is hit

- **Rooms and joins per IP** answer `429 RATE_LIMITED` with `retry_after`
  (seconds) in the body and a `Retry-After` header. The web app shows its
  "Too many attempts" screen with the wait. Coming back to a room with a valid
  token is not a new join and is never counted.
- **Messages per person** answer `429 RATE_LIMITED` too. The composer shows the
  text inline, keeps what was typed, and says how long to wait. A message
  refused for speed writes nothing and costs no step. Directives and comments
  have separate allowances, and each person in each room has their own.
- **The daily step budget** answers `503 AT_CAPACITY`. For a new room the web
  app shows "The demo is at capacity"; for a message the composer shows the same
  sentence inline. Nothing is written. Reading, joining, comments and rooms
  started without `auto_start` cost nothing and keep working.
- **Size limits** answer `400 BAD_REQUEST` with the length and the limit, shown
  next to the field. A request body over `MAX_BODY_KB` answers 413 with the same
  JSON shape. A title that is too long is not refused: it is cut to `MAX_TITLE_CHARS`
  before it is saved, on a whole character.
- **Names and titles with control characters** (an escape sequence, a line break, a tab, a text-direction mark, a
  zero-width character, which includes the joiner some multi-part emoji use) answer `400 INVALID_NAME` or `400 INVALID_TITLE`, and nothing is written. They are refused,
  not cleaned, so the name someone typed is the name shown. Anything untrusted that Multiplayer AI prints in its terminal,
  such as a provider's error text or a name, has control characters shown as `\x1b` or `\u{202e}` instead of being sent
  to the terminal as they are.
- **A full room** (`MAX_PARTICIPANTS_PER_ROOM`) refuses the next new person with
  a 400 shown beside the name field. People already in the room can still come
  back.

## The daily step budget

One counter across all rooms, kept in the database (`usage_daily`, migration
0004), so a restart can't refill it. The day is the UTC date, so it resets at
05:30 India time.

A step is counted when a directive is accepted: when a room is started with
`auto_start`, and when the controller sends a message. It is counted before
anything is written, and the queue is not involved. If the write that follows
fails, that step is still counted, so the count can run one high, never low.

Not counted: the MCP `step_agent` tool (the operator's own) and the short
rolling-summary calls. Those still count against the provider's own quota, so
leave headroom under it.

If the budget can't be read (the database is down, or migration 0004 isn't
applied) new steps are refused. A budget that can't be checked isn't
enforced, and the safe answer is no. At startup the server checks that the
`usage_daily` table exists, read-only, and refuses to start if it doesn't.
It cannot check from there that the `claim_step` function exists without
calling it, which would spend a step, so run the whole migration file.

## Rate limits reset on restart

The per-IP and per-person limits live in the server's memory, like the step
queue. A restart clears them. That is acceptable for one server process, and it
is why the daily budget is the one limit kept in the database. Running more than
one server process is not supported yet; each would keep its own counts.

## `TRUST_PROXY_HOPS`: getting the caller's IP right

The per-IP limits need to know who is calling. The server can see only the
address that connected to it. If your host puts a proxy or load balancer in
front, that address is the proxy's, and the real caller's address arrives in the
`X-Forwarded-For` header. That header can be written by anyone, so the server
only believes the part added by proxies you tell it about.

`TRUST_PROXY_HOPS` is the number of proxies between the internet and this
server.

| Setting | Right when | If it is wrong |
|---|---|---|
| `0` (default) | Browsers connect straight to this server (local development) | Behind a proxy, every caller looks like the proxy: **one shared bucket**. The first five people to start rooms use up everyone's allowance |
| `1` | One proxy or platform load balancer sits in front | Too low if there are really two: one shared bucket again |
| `2` or more | A CDN plus a load balancer, for example | **Too high and callers choose their own IP.** A script sends a made-up `X-Forwarded-For` with each request and gets a fresh allowance every time, so the per-IP limits stop working |

The setting is printed at startup, with what it means.

To find the right number, read your host's documentation for how many proxies
sit in front of the app. Then check it:

1. Set `CREATE_LIMIT_PER_HOUR=1` and restart.
2. Start a room from your own connection. It works.
3. Send the same request again with an extra header, for example
   `curl -H "X-Forwarded-For: 203.0.113.7" ...`. It must be refused with 429. If
   it goes through, `TRUST_PROXY_HOPS` is too high.
4. From a different network (a phone on mobile data), start a room. It must
   work. If it is refused, `TRUST_PROXY_HOPS` is too low.
5. Put `CREATE_LIMIT_PER_HOUR` back.

An IPv6 caller is counted by its /64 range, because one customer usually holds a
whole range and could otherwise use a fresh address for every request.

The MCP path has no IP and is not limited by IP: it is the operator's own
connection. Message limits and the step budget still apply to it.

## Applying the database part

Run `supabase/migrations/0004_usage_and_size_limits.sql` in the SQL editor of
your project, then restart the server. The file only adds things, so a server
from before this change keeps working against it.
