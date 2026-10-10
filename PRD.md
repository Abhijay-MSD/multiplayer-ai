# Multiplayer AI — Product Requirements Document

> **Working name:** Multiplayer AI (placeholder, rename freely)
> **One line:** A shared room where a whole team watches and steers one live AI agent together, the way Google Docs made writing collaborative.
> **Status:** Draft v0.2 · Open-source prototype, runs on your own computer
> **Author:** see LICENSE
> **Last updated:** 8 Oct 2026
> **Changelog (5 Oct 2026):** Steering is now controller-only. Only the current controller can send directives and only their directives trigger a reply. Everyone can post comments (room chat the agent never sees). This replaces the old rule that all directives are accepted (Sections 5, 6, 7, 8 FR-5/FR-5b/FR-8, 11, 13, 25).
> **Changelog (5 Oct 2026, identity and access):** People are identified by a secret per-room token the server issues, not by a name the client sends. Names are unique in a room. Taking control for yourself is allowed only when nobody is controller or the controller is Away; handing control to someone else is the controller's call alone. The browser no longer reads the database: live updates come from the server (Sections 9, 12, 13, 15).
> **Changelog (8 Oct 2026, local first):** Multiplayer AI now runs on the person's own computer by default: one command (`npm start`), data in a local SQLite file, a first-run Setup for the provider and key, and Settings (export, delete, key). Supabase storage is optional, frozen, and unverified in this version. Sharing is host-controlled: by default only the host's computer can reach it; the host can let people on the same Wi-Fi in (a link with a secret in its fragment, a QR code, host-approved control, a cap on guests' messages). Fonts are bundled, so the web page requests nothing from any other host. A fourth provider (Claude, through its Messages API) was added and is **not yet confirmed against the real service**. Code blocks in replies can be copied or downloaded, and a room has an Outputs tab. Sections 1, 6, 9, 10, 14, 15, 16, 17, 23 and 24 are updated; where this document still describes the hosted design (Supabase, free tiers), it says so. Out of scope for now: accounts, billing, a hosted version, a desktop app, a browser extension, sharing over the internet (tunnels), and letting the agent run code or shell commands (a design note only: `docs/agent-tools.md`).

---

## 0. How to read this document

This PRD is written to be the single source of truth for the prototype. Sections 1 to 6 are the "why and what." Sections 7 to 18 are the "how it works" (engineering). Sections 19 to 21 are the frontend: information architecture, the sitemap, and a full design system built specifically to avoid looking AI-generated. Sections 22 onward cover metrics, risks, and the build order.

If you only read three sections before building: read **6 (Scope)**, **11 (MCP tools)**, and **20 (Design system)**.

---

## 1. Summary

Today, using an AI agent is a single-player activity. One person opens a chat, types, and gets back a result only they can see. If a teammate needs to weigh in, the best you can do is paste the transcript or send a screenshot. The live thing, the agent actually working, is trapped in one person's window.

Multiplayer AI makes the session itself the shared surface. One person starts an agent on a task, gets a link, and drops it to their team. Anyone who opens that link lands in the same live session: same transcript, same in-progress work, same state. Everyone can watch the agent work in real time, anyone can send it a course-correction, and control can be handed from one person to another without restarting or re-explaining.

The prototype is open-source, runs on the host's own computer with the host's own model key, and is model-agnostic: Groq, Gemini, Claude and any OpenAI-compatible service are built, behind one thin adapter interface. What any provider charges is between the host and the provider; this document makes no claim about it.

---

## 2. Problem

**The core gap:** AI agents are becoming genuinely useful for real work (writing code, handling tickets, running research, building campaigns), but the interface around them assumes exactly one human. That assumption breaks the moment the work is a team's work.

Concrete pain points we are solving:

- **No shared visibility.** A teammate cannot see what your agent is doing right now. They see a snapshot at best, and only if you export it.
- **No shared control.** Two people cannot co-pilot one agent. You each run your own separate chat, duplicating context and drifting apart.
- **No handoff.** When you step away mid-task, there is no way to pass the live session, with all its context, to someone else. They start over.
- **Context re-explanation tax.** Bringing a colleague up to speed means re-pasting the task, the constraints, and everything the agent already figured out.

Who feels this most: small teams doing agent-assisted work where more than one brain needs to be on the same task. Engineering pairs debugging together, a support lead and an agent working a hard ticket, a founder and a contractor building something, a teacher walking a student through an agent's reasoning.

**Why now:** agents crossed the threshold from toy to tool in the last year, and the moment a tool is useful for work, it becomes something teams want to do together. The collaboration layer has not been built yet. Docs, design, and code all got their multiplayer moment (Google Docs, Figma, Live Share). Agents have not.

---

## 3. Vision and goals

**Vision:** the default way teams use AI is together, in a shared room, not alone in parallel windows.

### Goals (for the prototype)

1. Two or more people can be in the same live agent session at the same time.
2. Every participant sees new agent output and new directives appear live, without refreshing.
3. The controller can send directives that the running agent picks up; everyone else can comment to the room.
4. Control (who is currently the "driver") can be handed from one person to another.
5. The whole thing is genuinely open-source and runs on the host's own computer: clone it, run one command, paste a key. The time a first start takes has not been measured on a clean machine.
6. The frontend looks designed, not generated. It should be something a person would screenshot because it looks good, not because it looks like every other AI app.

### Non-goals (explicitly out of scope for v0)

- Building our own agent framework or model. We orchestrate an existing model through an adapter; we do not train or host one.
- Real-time shared *cursors* inside the transcript (Figma-style presence at the character level). Presence is at the participant and directive level, not the keystroke.
- Enterprise features: SSO, org management, role hierarchies, audit exports, SOC2. Later, not now.
- Native mobile apps. The web app is responsive; that is enough for v0.
- Billing and metering. The monetization section exists to record decisions, not to build.

---

## 4. Target users and personas

The wedge is small technical and semi-technical teams. Three personas frame the MVP:

**Priya, the engineering lead (primary).** Runs a 4-person team. Wants to debug and build alongside an agent with a teammate watching and jumping in, instead of screen-sharing a chat window. Cares about: low friction to invite, seeing what the agent is doing, not losing context on handoff.

**Sam, the solo builder validating with collaborators (primary).** Building something with a contractor in another timezone. Wants to leave an agent working, hand the session off at end of day, and have the contractor pick up exactly where it stopped. Cares about: persistence, clean handoff, bring-your-own-key so nobody argues about cost.

**Dana, the reviewer / lurker (secondary).** Gets sent a session link. Does not want to set anything up. Wants to open the link, watch, and occasionally drop a "actually, check the auth path first." Cares about: zero-setup join, read-mostly experience.

For the prototype, if Priya and Dana can share one session and both influence it, the concept is proven.

---

## 5. Key scenarios

**Scenario A — Pair debugging.** Priya starts a session: "figure out why the checkout webhook is dropping events." She sends the link to a teammate. Both watch the agent trace the code. The teammate spots a wrong assumption and sends a directive: "it's the retry logic, not the signature check." The agent adjusts. Neither had to restart.

**Scenario B — Timezone handoff.** Sam starts an agent scaffolding a feature, works with it for an hour, then hands control to his contractor and logs off. The contractor opens the same link next morning, sees the full history and current state, takes control, and continues. No re-briefing.

**Scenario C — Drive-by review.** Dana is tagged with a link in Slack. She opens it and watches the agent for thirty seconds. She spots a problem and posts a comment to the room, which the agent does not see. The controller reads it and acts on it. If Dana wants to steer the agent herself, she asks the controller to hand control to her; if the controller has gone away or nobody holds the seat, she takes it herself and then sends a directive. She never created an account beyond typing her name.

---

## 6. Scope

### In scope for MVP (v0)

| Capability | Included |
|---|---|
| Create a session with a task | Yes |
| Shareable join link | Yes |
| Join a live session by link (name only, no account) | Yes |
| Live-updating transcript for all participants | Yes |
| Send a directive to the running agent (controller only) | Yes |
| Post a comment to the room (anyone, agent never sees it) | Yes |
| Presence: who is in the room right now | Yes |
| Controller vs watcher roles | Yes |
| Hand off control to another participant | Yes |
| Agent runs via a pluggable provider (Groq, Gemini, Claude, or any OpenAI-compatible service) | Yes |
| Session persistence (reopen later) | Yes |
| Basic per-session usage guardrail (turn/token cap) | Yes |
| Runs on the person's own computer: one command, local data file, no accounts, no database to set up | Yes |
| First-run Setup and Settings (provider, key, export, delete) | Yes |
| Sharing on the same Wi-Fi, host-controlled (link with a secret, QR code, control policy, guest cap, remove a person) | Yes |
| Copy and download code from replies; an Outputs tab per room | Yes |
| Web page that requests nothing from other hosts (fonts bundled) | Yes |

### Deferred (post-MVP)

Accounts and auth beyond magic-link; multiple concurrent agents per room; file attachments other than text (text files can be attached from 0.2.0: see docs/agent-tools.md); branching a session; per-person permissions (a room is open to whoever the host gave its link, and the host decides who steers); sharing over the internet (tunnels are refused); a hosted version; billing; provider marketplace; mobile apps; keystroke-level presence; code execution or shell tools for the agent (design note only).

---

## 7. Core concepts and glossary

- **Session:** one shared agent working on one task. Has an id, a title, a task, a status (active / paused / done), and an ordered stream of events. The unit everything else attaches to.
- **Event:** one entry in the session stream. Kinds: `agent_message` (the agent said/did something), `directive` (the controller steered it), `comment` (a participant spoke to the room; the agent never sees it), `join` / `takeover` (presence changes), `status` (session state changed).
- **Participant:** a person in a session, identified by a display name that is unique in the room, and proven by a secret token the server issues when they create or join. There is no account. Has a role.
- **Role:** `controller` (currently driving; the only role that can message the agent) or `watcher` (present, can post comments, cannot message the agent; can take control only when nobody is controller or the controller is Away).
- **Directive:** a message from the controller that steers the running agent mid-task. Each one gets exactly one agent reply.
- **Comment:** a room chat message from any participant, controller included. It is visible to everyone in the room, is never sent to the model, and never triggers a reply.
- **Handoff / takeover:** transferring the controller role from one participant to another.
- **Provider:** the model backend actually doing the reasoning (Gemini, Claude, etc.), reached through a common adapter interface.

---

## 8. Functional requirements

Each requirement has an ID, a user story, and acceptance criteria.

**FR-1 — Create session**
As a user, I can start a new session by giving it a task, so the agent begins working.
Acceptance: at `/new` I give a task and my name. That creates a session row with me as controller and saves the task as the first directive; with `auto_start` (the web app sends it) the agent answers it straight away, and without it (MCP callers) nothing runs until `step_agent`. I land in the session room, and a "Share this link" panel shows the link with a copy button.

**FR-2 — Shareable link**
As a user, I can copy a link to my session and send it to someone.
Acceptance: the room displays a copy-able URL of the form `/s/:sessionId`. Opened on the host's own computer, in another browser, it reaches the same session. For other people on the host's Wi-Fi the host gets a different link, `/s/:sessionId/join#k=<secret>`, with a QR code, from Host controls (Section 15); without that secret a network guest cannot join.

**FR-3 — Join by link (no account)**
As an invited person, I can open the link, enter a display name, and land in the live room. A name someone in the room already uses is refused with a suggestion.
Acceptance: opening `/s/:sessionId` when not yet a participant prompts for a name, records me as a `watcher`, writes a `join` event, and shows me the full existing transcript.

**FR-4 — Live transcript**
As a participant, I see new events appear without refreshing.
Acceptance: when any participant or the agent produces an event, every connected client renders it within ~2 seconds. No manual refresh.

**FR-5 — Send directive (controller only)**
As the controller, I can send a directive to the running agent. Nobody else can.
Acceptance: the server checks the sender's role at the moment the directive is written. The current controller's directive writes a `directive` event visible to all and queues exactly one agent reply. Anyone else is rejected with a clear error ("Only the controller (Name) can message the agent. Ask them to hand control to you, or post a comment to the room instead."), nothing is written, and their text stays in the composer. If nobody is controller, no one can message the agent, but anyone can take control for themselves. If control changes while directives are queued, the queued directives stay attributed to whoever sent them and are still answered, in order.

**FR-5b — Comments**
As any participant (controller included), I can post a comment to the room.
Acceptance: `send_comment` writes a `comment` event visible to all. It never queues an agent step, never changes the agent's working state, and is excluded from the model context and from the rolling summary. A watcher's composer posts comments only. The controller's composer has two modes, "Message the agent" (default) and "Comment", and the active mode is visually unmistakable. Comments render as quiet room chat, clearly distinct from directives and agent output.

**FR-6 — Presence**
As a participant, I can see who else is currently in the room.
Acceptance: a presence list shows active participants, updates on join/leave within ~5 seconds, and marks the current controller.

**FR-7 — Roles and handoff**
As the controller, I can hand control to another participant who is here. As a watcher, I can take control myself only when nobody is controller or the controller is Away; otherwise I ask the controller, in a comment.
Acceptance: a takeover changes the `controller` for the session, writes a `takeover` event, and updates every client's presence display. Only one controller exists at a time.

**FR-8 — Agent stepping**
The agent advances the task, incorporating the latest directives.
Acceptance: after a controller directive or on continuation, the agent produces the next `agent_message`, answering that directive directly and attributed to its sender ("Replying to Name: ..."). Comments never trigger a step. See Section 13.

**FR-9 — Persistence**
As a user, I can close the tab and reopen the session later with full history.
Acceptance: reopening `/s/:sessionId` renders all past events in order and the current status.

**FR-10 — Usage guardrail**
As the operator, I want a per-session cap so a runaway loop cannot burn the whole budget.
Acceptance: a session stops calling the provider after a configurable max number of agent steps or token budget, and shows a clear "session reached its limit" state.


**FR-11 — Ended and archived rooms**
As a reader, I can still open a room that has ended or gone quiet, and I am told plainly that it is read-only.
Acceptance: a room whose controller set it to done is *ended*; a room with no new event for `ARCHIVE_AFTER_DAYS` (default 7) is *archived*. Archiving is worked out when the room is read, from the last event's time; nothing sweeps rooms. In both, every write is refused with status 410 (`ROOM_ENDED` or `ROOM_ARCHIVED`) and nothing is saved. People who were in the room can still open and read it, and see a notice where the composer would be. Nobody new can join. A controller can reopen an ended room; an archived one stays read-only.

**Failures the web app handles, by the server's error code:** `ROOM_NOT_FOUND` (404), `ROOM_ARCHIVED` and `ROOM_ENDED` (410), `RATE_LIMITED` (429, with `retry_after`), `AT_CAPACITY` (503), and a server that cannot be reached. Each has its own screen that says what happened and what to do next. The server produces all of these codes. `RATE_LIMITED` comes from the per-IP room limits and the per-person message limits, and `AT_CAPACITY` from the daily step budget; see `docs/limits.md`.

---

## 9. System architecture

Four moving parts. By default they all run on the host's computer:

```
  ┌──────────────┐        ┌────────────────────┐        ┌───────────────┐
  │   Frontend   │ ─────▶ │   MCP Server /     │ ─────▶ │  Model         │
  │ (web app)    │  REST  │   Orchestrator     │  HTTP  │  Provider      │
  │              │ ◀───── │  (Node)            │ ◀───── │ (your choice)  │
  └──────────────┘  live  └─────────┬──────────┘        └───────────────┘
                  stream            │ read/write
                                    ▼
                           ┌────────────────────┐
                           │  Local data file   │
                           │  (SQLite: sessions,│
                           │   events, people)  │
                           └────────────────────┘
```

- **Frontend (web app):** the shared room UI. Reads and writes everything through the orchestrator. It holds no database credentials. Live updates arrive over a stream the orchestrator serves, authenticated by the participant token.
- **MCP server / orchestrator (Node):** the brain wiring. Exposes MCP tools (so Claude Code, Claude Desktop, or a custom runner can also act as a participant), and runs the agent-stepping loop, calling the provider and writing results back to Supabase.
- **Storage:** the shared state, behind one storage interface (`server/store/`). The default is a local SQLite file in the data folder (`~/.multiplayer-ai`, or `MULTIPLAYER_AI_DATA_DIR`). Supabase Postgres is an optional second implementation, kept lazy and frozen and **not verified against a live project in this version** (`docs/supabase.md`). Either way only the orchestrator talks to it; browsers have no access.
- **Provider:** the actual model, behind an adapter interface so it is swappable. The key is the host's; it pays for every reply.

**Why MCP at all:** MCP is what lets any MCP-speaking client join the same session as "one more participant." A person in Claude Code and a person in the web app can act on the same session because both talk to the same MCP server. The web app is the friendly front door; MCP is the open protocol underneath.

**Why the orchestrator serves the live stream (instead of the browser subscribing to the database):** with Realtime the browser needs a database key and a read policy, so anyone holding the key could list every session. Serving the stream from the orchestrator keeps the database closed to browsers and lets access be checked per participant, and it revokes immediately. MCP is request/response and has no native push, so the stream is plain Server-Sent Events read with `fetch`, with the token in an `Authorization` header (never in a URL). The cost is one extra read hop, and a single-instance hub for now (see Section 12).

---

## 10. Data model

Three tables. The default store's schema is in `server/store/migrations/` (`001`, `002`; applied automatically, with a backup copy before any upgrade); the optional Supabase store's is in `supabase/migrations/`, applied in order:

**sessions**
`id` (uuid, pk) · `title` (text) · `task` (text) · `status` (active|paused|done) · `created_at` · `updated_at` · and, for sharing (local store only): `invite_version` (raised by Make a new link), `guest_step_cap`, `control_policy` (locked|ask|free)

**session_events**
`id` (bigint, pk) · `session_id` (fk) · `kind` (agent_message|directive|comment|join|takeover|status) · `author` (text, name or 'agent') · `content` (text) · `created_at`

**session_participants**
`session_id` (fk) · `name` (text) · `role` (controller|watcher) · `last_seen` (timestamptz) · pk (`session_id`, `name`) · and, local store only, `is_host`

A trigger bumps `sessions.updated_at` on every new event. Participants also carry a hash of their access token, its expiry and a revoked-at time (Section 15). With Supabase storage, row-level security is on with no policies, so browsers cannot read or write any table; only the orchestrator's service key can. With the local file, the file is readable only by the host's account and only the orchestrator opens it.

---

## 11. MCP server — tool specification

The orchestrator exposes these tools over MCP. This is the contract any client (web app, Claude Code, custom runner) uses.

| Tool | Input | Effect / Output |
|---|---|---|
| `create_session` | `task`, `title?`, `creator_name`, `auto_start?` | Creates a session, seeds first event, makes the creator controller. Returns `session_id`, the creator's `token` (shown once), and the share URL. With `auto_start: true` the agent starts on the task at once; otherwise nothing runs until `step_agent`. |
| `join_session` | `session_id`, `name`, `token?` | With a still-valid `token` for this room: you are that participant again. Otherwise adds a new watcher under `name` (refused, with a suggestion, if the name is in use), writes a `join` event, and returns a new `token` (shown once) plus current state and the full transcript. |
| `get_session` | `session_id`, `token` | Participants only. Returns session metadata, participants, and ordered events. |
| `send_directive` | `session_id`, `token`, `content` | Controller only. The server reads the caller's role from the token's record when the directive is written; anyone else is rejected and nothing is written. Writes a `directive` event authored by the token's owner and queues one agent reply. |
| `send_comment` | `session_id`, `token`, `content` | Any participant. Writes a `comment` event. Never queues a step and never touches the agent's working state. Excluded from the model context. |
| `step_agent` | `session_id`, `token` | Controller only. Advances the agent one step: gathers transcript + pending directives, calls the provider, writes the resulting `agent_message`. Enforces the usage cap. Not available to browsers over REST. |
| `take_control` | `session_id`, `token`, `target?` | Without `target`: the caller takes control, allowed only when nobody is controller or the controller is Away. With `target`: the controller hands control to that participant, who must be here. Writes a `takeover` event. |
| `set_status` | `session_id`, `token`, `status` | Controller only. Pauses / resumes / ends the session. Not available to browsers over REST. |
| `heartbeat` | `session_id`, `token` | Updates the caller's `last_seen` for presence. |
| `leave_session` | `session_id`, `token` | Marks the caller Away at once (they closed the tab). Keeps their place and token. |

The live stream is not an MCP tool: browsers read `GET /api/stream/:session_id` (Section 12).

Design notes:

- Tools are intentionally small and stateless in themselves; all state lives in Postgres so any client sees the same truth.
- `step_agent` is the only tool that spends money (calls the provider). The cap lives here.
- The web app can call these via a thin REST wrapper; MCP clients call them directly. Same effects either way.

---

## 12. Realtime and sync design

- Each client, on entering a room, calls `join_session` (full transcript, state, and its token), then opens `GET /api/stream/:session_id?after=<newest event id>` with `Authorization: Bearer <token>`. The server replays any events after that id, then pushes new events, participant changes and session changes.
- While anyone is connected to a room, the server reads that room's rows every few seconds, and immediately after any write made through the orchestrator. A change made through the orchestrator therefore reaches viewers after about one database round trip, and a change made by another process (for example an MCP client running its own copy) within the poll interval.
- The server sends a keep-alive comment every 15 to 25 seconds. A client that hears nothing for 45 seconds reconnects, with backoff, and resumes from the newest event id it has, so nothing is missed or shown twice. If it is too far behind to replay, it reloads the room.
- A token that is revoked or expires ends an open stream at the next read.
- New events are appended to local state as they arrive; the transcript is an append-only log, so ordering is simply by `created_at` / `id`.
- Presence is derived from `session_participants.last_seen`; clients send a `heartbeat` every ~20 seconds and are shown as "away" if not seen in ~60 seconds.
- The agent-stepping loop runs server-side in the orchestrator, not in any browser, so it keeps going even if the person who started it closes their tab.

Target latency: an event produced anywhere is visible everywhere within 2 seconds under normal conditions. Fan-out is in the memory of one orchestrator process; running several instances would need a shared channel (for example Postgres `LISTEN/NOTIFY`) and is not built.

---

## 13. Concurrency and conflict resolution

*Rewritten 5 Oct 2026. The earlier "controller-priority with a visible queue" policy, where every participant could send directives, is replaced.*

**The problem:** two people steering one agent at nearly the same moment ("focus on auth" and "skip auth, do billing") makes the agent thrash.

**Policy: a single steering seat.**

1. Only the current controller can send directives to the agent, and only a controller directive triggers a reply. There is exactly one controller at a time (Section 8, FR-7).
2. Because only one person can steer, directives cannot conflict between people. Replies are strictly serial, one per directive, in the order sent. There is no priority label and no acknowledgement preamble in the agent's replies; each answers its directive directly.
3. Everyone else, and the controller too, can post comments. Comments are visible to the room, never reach the model, and never trigger a reply. A watcher who disagrees comments, or asks the controller to hand over the seat.
4. If nobody is controller, nobody can message the agent. Taking control for yourself is allowed only when nobody is controller, or the controller is Away (no heartbeat for about 60 seconds). While the controller is here, no one else can take the seat; they ask the controller, who hands it over.
   Handing control to someone else is the controller's call alone, and the person receiving it must be here. A refused request changes nothing.
5. The server enforces the rule in `send_directive`, reading the controller when the directive is written, so a handoff that landed a moment earlier is respected even if the sender's screen is stale. The sender sees the rejection and keeps their text.
6. If control changes while directives are queued, the queued directives keep the author who sent them and are still answered, in order. The step that answers them does not consult the current controller.

**Identity:** who is acting is decided by the participant's secret token, never by a name in the request, and the name and role come from the server's record of that token. A stolen or guessed name gives no control: a name in use cannot be joined under, and acting needs the token.

**Known limits:** a name is unique in a room ignoring letter case, and a name or title that holds control characters, line breaks or invisible characters (text-direction marks, zero-width characters) is refused, but look-alike characters from other alphabets are not caught. The controller check and the insert are separate database calls, so a handoff landing in the few milliseconds between them lets that one directive through; it is attributed to its sender and answered. A handoff is also two writes (demote, then promote), so for a moment nobody is controller and a directive sent in that instant is rejected.

**Why this replaces the old rule:** open directives let anyone redirect the agent mid-task, which the controller then had to out-prioritise. Splitting the room into one driver and many commenters keeps the drive-by scenario (watch, comment, or ask for the wheel) without the conflicts. Comments give watchers a voice without a seat.

**Deferred:** the agent asking a clarifying question when a new directive contradicts an earlier one.

---

## 14. Provider abstraction

A single interface isolates the model so the whole app is provider-agnostic:

```
callModel({ messages, tools }) -> { text, toolCalls }
```

- Implementations for **Groq**, **Gemini**, **Claude** (Messages API, plain requests) and any **OpenAI-compatible** address (including a model on the host's own computer). The host chooses in Setup or Settings; the key is saved locally or set in the environment.
- The Claude adapter's details have not been checked against the provider's documentation or a real key, so they are **unconfirmed** and listed as such in `docs/providers.md`; a real key and Test key are needed to confirm it.
- A failed reply shows people in the room only a category ("the provider didn't accept the key"); the provider's own words go, with keys hidden, to the host's terminal.
- Each adapter normalizes that provider's request/response shape and tool-calling semantics into our internal format.

Switching providers is a config value, not a rewrite. The multiplayer layer never knows or cares which model answered.

Cost note: replies are paid for by the host's key, whoever asked for them. Providers set their own prices and limits and change them, so this document states none. Guests are capped per room to protect the host's key (Section 15).

---

## 15. Security, privacy, and abuse prevention

The prototype ships permissive so it is easy to run, but these are the known gaps to close before real users:

- **Identity:** each person who creates or joins a room gets a secret token from the server. Only a hash is stored. Every call that acts for a participant presents it, and the server derives name and role from it. Tokens expire (default 30 days, `TOKEN_TTL_DAYS`) and can be revoked. A token for one room does not work in another.
- **Database access:** browsers have none. With Supabase storage, row-level security is on with no policies and the anon role has no privileges on the tables; with the local file there is no database service at all. Live updates are served by the orchestrator to authenticated participants only. Anyone who joins a room under a name can read that room's transcript, as intended; anyone without a participant token reads nothing. Treat the room link as the invitation: whoever has it can join.
- **API keys stay server-side:** the provider key lives only on the host's computer: in the environment, or saved in `settings.json` in the data folder as plain text readable only by the host's account (`docs/providers.md` says what that does and doesn't protect). It is never sent to the browser, never shown again after saving (only its last four characters), and hidden from terminal output and error messages. `scripts/scan-secrets.mjs` looks for key-shaped strings in files, history and the built app.
- **Local mode (the default):** only the host's computer can reach the app. Requests must carry the expected Host and Origin; anything carrying a proxy or tunnel header is refused. Setup, Settings, export and delete need a one-time sign-in link and a cookie; they do not exist on any network address. The web page requests nothing from other hosts (tested), and `docs/privacy.md` lists what is stored and what is sent.
- **Sharing on the same Wi-Fi (host-controlled):** one chosen private address, never every interface; the link carries a per-room secret in its fragment (sent once in a request body, then removed from the address bar); only the host starts rooms; the host decides whether guests may take control (locked, ask, or free), caps guests' messages (20 per room by default), can make a new link and can remove a person. The link uses plain `http`, which anyone on the network who can capture traffic can read; this is stated beside every link, and tunnels are not supported. Details and the manual checklist for a real phone: `docs/sharing.md`. Real phones and Windows or Linux are **untested**.
- **Usage caps:** per-session step caps (Section 10, FR-10) plus a global daily step budget (`DAILY_STEP_BUDGET`, default 200 per UTC day, stored in the database) protect the operator's budget from runaway loops and abuse. When it is spent, steps are refused with `AT_CAPACITY` and nothing is written; reading, joining and comments keep working. If the budget can't be read, steps are refused.
- **Rate limiting:** per IP, 5 rooms started and 30 new joins per hour; per person per room, 6 messages to the agent and 20 comments per minute. Over a limit the server answers 429 with the wait. They live in memory and reset on restart. The IP comes from `TRUST_PROXY_HOPS`; a wrong value breaks the per-IP limits (`docs/limits.md`).
- **Size limits:** a task, message or comment is at most 4000 characters, a title is cut to 120, a name is at most 40, a room holds 25 people, and a request body is at most 32 KB. The database checks the text sizes too (migration 0004).
- **Startup checks:** the server validates its environment and the existence of the budget table before it listens, and stops with every problem listed.
- **Bring your own key:** a design only, in `docs/byok-design.md`.
- **Input handling:** treat directives and any content the agent pulls in as untrusted. The agent must not be given tools that take irreversible actions without a human confirming.
- **No sensitive data in v0:** the join flow collects only a display name. No emails, no PII beyond a chosen name. `docs/privacy.md` describes what the software stores and sends; it is not legal advice.
- **Outputs:** code in replies can be copied or downloaded as plain text under a name cut down to safe characters; Multiplayer AI never opens, renders or runs it (`docs/outputs.md`).

---

## 16. Non-functional requirements

- **Setup time:** clone, `cd`, `npm start`, open the link it prints, paste a key. No database, no account, no file to edit. The first start installs packages (internet needed) and takes a minute or so; this has not been timed on a clean machine.
- **Performance:** live updates within 2 seconds; first paint of the room under 1.5 seconds on a normal connection.
- **Cost:** the software is free and needs no hosting. Model replies cost whatever the host's provider charges; this document makes no claim about any provider's free tier.
- **Accessibility:** keyboard reachable, visible focus states, respects reduced-motion, meets WCAG AA contrast. (Called out again in the design system.)
- **Responsiveness:** fully usable from ~360px wide up.
- **Browser support:** current Chrome, Safari, Firefox, Edge as a goal; the browser tests run in Chromium only.
- **Operating systems:** run on macOS with Node 24; the server tests and a Docker image have also run on Linux (containers, Node 22.13.0, 22.23.3 and 24). Windows and Linux desktops are untested and not claimed. The supported Node versions are 22.13 and newer (23.4 and newer on the 23 line), because that is where `node:sqlite` needs no flag.

---

## 17. Open-source plan

**License:** MIT (permissive, standard for an OSS agent tool, lowers the barrier to people trying and forking it).

**Repository layout:**

```
multiplayer-ai/
  README.md              ← what it is, download, three commands, honest limits, screenshot
  CONTRIBUTING.md  LICENSE
  .env.example           ← every setting, no real secrets
  scripts/               ← start (the one command), copy check, secrets scan
  server/                ← MCP server + orchestrator (Node)
    server.js  local.js
    providers/           ← groq, gemini, anthropic (Claude), compat
    store/               ← the storage interface; SQLite (default), memory (tests), Supabase (optional)
    tools/               ← one file per MCP tool
  web/                   ← the frontend app (React + Vite); web/qa has the browser tests
  supabase/migrations/   ← the optional Supabase schema (frozen)
  docs/                  ← sharing, providers, privacy, limits, Docker, themes, design notes
```

**Contribution:** `CONTRIBUTING.md`, `SECURITY.md` (private vulnerability reporting through GitHub) and an issue template exist; a code of conduct and a short roadmap in the README do not yet. CI (`.github/workflows/ci.yml`) is written and has never been run. Issues labelled `good first issue` for the obvious small pieces (extra provider adapters, presence polish).

**Positioning to the world:** "bring your own key, host it yourself, own your data." That is the honest and appealing pitch for an OSS agent tool, and it sidesteps the cost and billing questions entirely for anyone who self-hosts.

---

## 18. Monetization (recorded for later, not built now)

Decisions parked so they are not lost:

- **Model:** likely a hosted version (we run it, users do not self-host) on a subscription, with self-hosting always free. Standard open-core shape.
- **Payments:** a merchant-of-record such as Lemon Squeezy or Paddle handles payment processing, fraud, and global sales tax, which removes most of the compliance burden of taking payments.
- **Open legal question:** a merchant of record handles tax collection, but it does not answer whether the operator needs a licence to run a business where they live. That needs advice from someone qualified in that place.

---

## 19. Frontend: information architecture and sitemap

Two surfaces: a small marketing site (explains and converts) and the app (does the work). The app's center of gravity is one screen, the session room; everything else is scaffolding around it.

```
Multiplayer AI
│
├── Marketing
│   ├── /                      Landing (hero = a real live session, not a mockup)
│   ├── /how-it-works          The three-step story: start · share · steer
│   ├── /docs                  Docs home
│   │   ├── /docs/quickstart       Run it in 15 minutes
│   │   ├── /docs/mcp-setup         Connect Claude Code / Desktop as a participant
│   │   ├── /docs/self-hosting      Deploy your own
│   │   └── /docs/architecture      How it works under the hood
│   ├── /changelog             What shipped
│   └── /privacy               What is stored and what is sent
│
└── App
    ├── /login                 Magic-link sign in (creators only; joiners skip this)
    ├── /app                   Dashboard: your sessions (active + past)
    ├── /app/new               Create a session (task input)
    ├── /s/:id                 ★ The session room — the core screen
    ├── /s/:id/join            Join flow (name entry) for link-openers
    ├── /app/settings          Account
    │   └── /app/settings/providers   Model provider + key config
    ├── 404                    Not found
    └── /error                 Graceful failure
```

Primary navigation in the app is deliberately thin: Sessions (dashboard), New session, Settings. The room itself has no global nav chrome competing with the live content; it is a focused workspace.

---

## 20. Design system (built to not look AI-generated)

The goal is a genuinely beautiful interface, not brutalist, and free of every tell that marks a UI as machine-generated. This section first lists what we are banning and why, then defines the actual system.

### 20.1 What we are avoiding, and why

Recent write-ups converge on a specific fingerprint for AI-generated UI. The shared point across all of them is that these are not ugly choices, they are *non-choices*, the statistical median a model reaches for when nobody decided anything. Per multiple 2026 sources, the tells cluster tightly.

The single most common tell is a permanent dark theme, followed by gradient backgrounds and icon-card grids. The canonical "AI slop" signature is the Inter typeface, an indigo-to-purple gradient, three rounded cards in a row, and a hero that could belong to ten thousand other products. Anthropic's own frontend design guidance explicitly rules out Inter, Roboto, Arial, and Space Grotesk before a component is written.

Our banned list, drawn from that research and enforced throughout:

**Typography**
- No Inter, Roboto, Open Sans, Arial. No Space Grotesk, Geist, or Instrument Serif (the overused "intentional" combos are now their own tell).
- No serif-italic single accent word inside an otherwise sans headline (a specific, tired pattern).

**Color**
- No indigo/blue-to-purple gradients. No "vibe-code" lavender-purple anywhere.
- No permanent dark mode as the default reflex. No neon-on-dark with glowing borders.
- No warm-cream (#F4F1EA-ish) background paired with a terracotta accent, which has itself become a recognizable AI-default and reads as the Claude-interaction palette.

**Layout and components**
- No three (or four) rounded feature cards in a row on white.
- No generic icon-card grid as the main content pattern.
- No single oversized centered line-icon sitting above a heading.
- No glassmorphism-on-everything, no floating gradient orbs or 3D blobs behind the hero.

**Imagery**
- No too-smooth plastic 3D illustrations. No generic stock ("diverse team at a laptop").

**Copy**
- No "transform your workflow," no "supercharge," no "unleash." No emoji as bullet points.

**Motion**
- No hover states that do nothing. No identical fade-in on every element. Buttons ease, they do not snap. Motion only where it carries meaning.

### 20.2 The chosen direction: "Signal Room"

Rather than default to anything above, the design is grounded in the product's own world. Multiplayer AI is a live control room where several people gather around one performing agent. The reference points are recording studios, radio control rooms, and orchestra pits: warm, tactile, a little analog, with a clear sense of a *live signal* running through the space. Editorial and warm, not cold and techy.

The one bold thing on the page, the signature, is the **live signal**: a single animated waveform/pulse that represents the agent thinking and working. Everything else stays quiet so that one element carries the room. This follows the "spend your boldness in one place" principle.

### 20.3 Color

A warm, slightly analog palette. Deliberately not cream-and-terracotta, not purple, not neon.

| Token | Hex | Use |
|---|---|---|
| `ink` | `#1B211E` | Primary text, dark surfaces (a warm near-black with a green undertone, never pure #000) |
| `paper` | `#FBFAF6` | Primary background (soft warm chalk, distinct from the AI-default cream) |
| `paper-sunk` | `#F1EFE8` | Recessed panels, transcript background |
| `signal` | `#E4952B` | THE accent: the live signal, marigold. Warm, energetic, not purple, not terracotta-red. Used sparingly. |
| `pine` | `#2F6D5B` | Controller state, "you have the room" affordances |
| `slate` | `#3E4C7A` | Links, secondary interactive (a muted indigo-slate, low saturation, not a gradient) |
| `clay` | `#B7543B` | Warnings, "at limit" states |
| `line` | `#E0DCD1` | Hairlines, borders (warm, low-contrast) |
| `muted` | `#6B6A61` | Secondary text |

Participant identity colors (for avatars and directive attribution), muted and sophisticated, never neon: pine `#2F6D5B`, clay `#B7543B`, slate `#3E4C7A`, plum `#6B4A6E`, ochre `#8A6D2F`. Assigned in order as people join.

Light theme is the default. A dark theme may exist, but it is opt-in, not the reflex, and if built it is warm charcoal, not neon-on-black.

### 20.4 Typography

Three roles, none of them on the banned list, all available as free web fonts:

- **Display — Fraunces.** A warm, high-contrast "old-style" serif with real character and optical sizing. Used with restraint for large headlines and the product name. Carries the editorial, studio personality.
- **UI / body — Hanken Grotesk.** A humanist grotesque that is legible and friendly without being Inter. Handles all interface text and body copy.
- **Signal / transcript — Spline Sans Mono.** A monospace for the agent's live output and any code, giving the transcript the texture of a signal readout, deliberately different from the surrounding UI so the "live" content feels like its own material.

Type scale (major-third-ish, tuned): 13 / 15 / 17 / 21 / 27 / 36 / 52 / 72. Display sizes use Fraunces; 13 to 21 use Hanken; the transcript uses Spline Sans Mono at 15. Line length capped at ~68 characters for reading comfort.

### 20.5 Spacing, radius, elevation

- **Spacing scale:** 4, 8, 12, 16, 24, 32, 48, 64, 96. Generous whitespace; the room breathes.
- **Radius:** a restrained 6px on most elements, 2px on inputs. Not pill-shaped, not sharp-cornered (sharp all-around would drift brutalist).
- **Elevation:** shadows are used, but softly and rarely (one or two levels), warm-tinted, never the default soft-blue drop shadow on every card. Structure comes mostly from the warm hairline (`line`) and from spacing, not from shadow.

### 20.6 Motion

- Purposeful only. The live signal pulses continuously (that is the point of it). Everything else moves on interaction.
- Buttons and controls ease in ~160ms with a gentle curve; they never snap.
- New transcript events slide in subtly and settle; they do not all use the same generic fade.
- A handoff animates the controller indicator moving to the new person, so the change is felt, not just stated.
- `prefers-reduced-motion` disables the signal animation (replaced with a static state) and all transitions.

### 20.7 Signature element in detail

The **live signal** is a horizontal waveform rendered in `signal` marigold, sitting at the top of the session room. When the agent is actively working it animates (a real, meaningful pulse tied to activity); when idle it flattens to a calm line; when at the usage limit it stills and shifts toward `clay`. It doubles as status: one glance tells the room whether the agent is thinking, waiting, or done. This is the one element allowed to be loud. Everything else recedes around it.

### 20.8 Components (house style)

- **Buttons:** solid `ink` for primary, warm outline for secondary, text-only for tertiary. The one place `signal` appears as a fill is the single most important action in a given view.
- **Transcript entries:** distinguished by author color and a small role tag, not by boxes-in-boxes. Agent output in mono, human directives in the UI face, so the two read as different materials.
- **Presence:** small color-coded avatars with the controller wearing a subtle `pine` ring. Live, warm, not a cold "online dot."
- **Composer:** a single calm field with a clear send affordance, always available. Watchers get a comment-only field plus a "take control" hint. The controller gets a two-mode toggle, "Message the agent" (default, marigold) and "Comment" (neutral), so the colour says where the text goes.
- **Empty and error states:** written in the interface's own voice, specific about what to do next, never a shrug or an apology.

---

## 21. Screen-by-screen UX spec

**Landing (`/`).** The hero is not a headline over a gradient. It is a live (or realistically simulated) session playing out, so the first thing a visitor sees is the actual product being multiplayer. A short, plain thesis line in Fraunces sits beside it. Below: the three-step story (start, share, steer) told as a genuine sequence, not as three equal feature cards. One clear primary action: start a session.

**Dashboard (`/app`).** A calm list of your sessions, active ones surfaced first with their live signal state shown inline, so you can see at a glance which rooms are working right now. Not a card grid; a readable list with real information density.

**Create (`/app/new`).** A single focused task input, large and inviting, in Fraunces. Minimal chrome. Submitting drops you straight into the room.

**Session room (`/s/:id`) — the core.** A three-region workspace:
- Top: the live signal (signature) plus session title and the copy-link control.
- Center: the transcript, the stage, where agent output (mono) and human directives (UI face, color-coded) stream live.
- Right rail: presence (who is here, who is driving) and the handoff control.
- Bottom: the composer, always available (comment-only for watchers).
No competing global nav. The live content is the interface.

**Join (`/s/:id/join`).** One field: your name. One button: enter the room. Nothing else. This is the zero-setup path for the drive-by reviewer; it must feel instant.

**Settings / providers (`/app/settings/providers`).** Choose the model provider and paste a key (stored server-side). Plain, honest copy about where the key goes and what it costs.

**404 / error.** In-voice, warm, points back to something useful. An empty screen is an invitation to act, not a dead end.

---

## 22. Analytics and success metrics

For a prototype, the question is only "does multiplayer actually happen and does it help?" Track:

- **Activation:** sessions that get at least a second participant (the whole point). Target: a meaningful share of sessions become multiplayer.
- **Live influence:** sessions where a non-creator sends at least one directive.
- **Handoffs:** number of control handoffs (proves the timezone/pairing scenarios).
- **Retention:** creators who start a second session within a week.
- **Time-to-join:** median seconds from opening a link to being in the room (should be very low).

Qualitative signal matters more than volume at this stage: did any real pair or team use it for actual work and come back.

---

## 23. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| A provider's rate limits or prices bottleneck concurrent sessions | Medium | Provider swap is a setting; guests are capped per room; the daily budget and per-room step limit protect the host's key. |
| Runaway agent loop burns budget | Medium | Per-session and global usage caps (FR-10) from day one. |
| Conflicting directives cause thrash | Medium | Controller-priority policy (Section 13) with a visible queue. |
| A shared link is read on the network (plain http) | Medium | Stated beside every link; same-Wi-Fi only; the host decides who steers; tunnels refused. A real phone on a real network has not been tested. |
| "Multiplayer" underwhelms because clients are single-user | Medium | Own the framing: the shared experience lives in our web app, not inside a third-party client's native UI. |
| Design drifts toward generic under time pressure | Medium | The banned-list in Section 20 is a checklist to run the built UI against before shipping. |
| Legal/licensing for paid version | Low (for now) | Deferred; self-hosting is free and needs no licence. Get real advice before charging. |

---

## 24. Roadmap and build order

**Milestone 0 — Skeleton (day 1).** Repo, schema applied to a fresh Supabase project (as first planned; the default is now a local file that needs no setup), env wired, empty MCP server responding.

**Milestone 1 — Single-player loop (days 2-3).** `create_session`, `step_agent` with the Gemini adapter, transcript persisting and rendering. One person, one agent, working, saved.

**Milestone 2 — Multiplayer core (days 4-6).** `join_session`, a live stream, `send_directive`, presence. Two browsers, same live room. This is the proof point.

**Milestone 3 — Roles and handoff (days 7-8).** Controller/watcher, `take_control`, conflict policy, the signal signature element.

**Milestone 4 — Polish and ship (days 9-12).** The full design system applied, landing page, docs, README with screenshots, MIT license, public repo. Run the built UI against the Section 20 banned-list.

**Done since (8 Oct 2026):** local storage and one-command start; first-run Setup and Settings; Docker; host-controlled sharing on the same Wi-Fi; bundled fonts; a Claude adapter (unconfirmed); copy and download of code with an Outputs tab; README, CONTRIBUTING, CI file (never run) and a secrets scan.

**Not yet done:** a run against a real provider key and a real phone on a real network, and a check of the project name.

**Built since (0.2.0 candidate).** The agent can list, read, write and append to the room's text files (docs/agent-tools.md); Stop and a usage line after each answer; the Files tab, attaching text files, and exporting the conversation and the files; the host's brief and "Your rooms"; retry, search and copy; simple tables and http links in replies. **Fast-follows (post-v0).** Clarifying-question conflict handling; attachments that are not text; anything beyond text files for the agent (code, shell, web: not planned); sharing beyond the same network.

---

## 25. Open questions

1. ~~Should watchers be able to send directives by default, or should that be a per-session setting?~~ **Resolved (5 Oct 2026):** no. Only the controller can message the agent. Watchers post comments, or ask the controller to hand over the seat (or take it when the controller is away). No per-session setting in v0.
2. ~~How much agent "tool use" do we allow?~~ **Answered for 0.2.0:** four tools (list, read, write and append) on the room's text files, off in shared rooms by default, and nothing that runs code, uses a shell or reaches the network (docs/agent-tools.md).
3. Does the creator need an account (magic link) in v0, or can even creation be name-only until there is something worth saving?
4. What is the right default usage cap that protects budget without cutting real sessions short?
5. Product name: keep "Multiplayer AI" or something else. (Placeholder.)

---

*End of PRD v0.2.*
