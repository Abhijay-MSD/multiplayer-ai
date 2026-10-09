// Model context assembly — the one place that decides what the model sees.
//
// Stable order:
//   a) system prompt, then the host's brief for the room if there is one
//   b) pinned: the original task, and who the controller is
//   c) rolling summary of events that fell out of the window (if any)
//   d) the most recent events that fit MAX_CONTEXT_TOKENS, oldest first,
//      then the directive being answered, always in full
//
// Only directives and agent_messages reach the model. comment / join / leave /
// takeover / status events (including "Agent could not reply" errors) are noise:
// the allow-list below is the single place that decides it, and the rolling
// summary is built from what falls out of this same set, so it can't see them.

// Every directive comes from the session's controller (PRD §13), so there is no
// priority policy to explain. The author can differ across a handoff; later
// directives then simply supersede earlier ones.
import { asStore } from "./store/index.js";

export const SYSTEM_PROMPT =
  "You are an AI agent in a shared session. Only the session's controller can direct you; " +
  "each of their directives gets its own reply, in the order sent. " +
  "Answer only the last message; earlier ones are history. " +
  "If control changed hands, later directives take precedence over earlier ones. " +
  "Match the length of your answer to the question: a greeting or a short question gets one or two sentences. " +
  "Do not say which directive you are acting on and do not restate the question.";

export const MODEL_EVENT_KINDS = ["directive", "agent_message"];

const DEFAULT_MAX_CONTEXT_TOKENS = 6000;
const MAX_EVENT_CHARS = 2000; // cap for any single windowed event (~500 tokens)
const MAX_TASK_CHARS = 3000; // cap for the pinned original task
const FETCH_LIMIT = 1000; // newest candidate events considered per step

export const TRUNCATED_MARK = " …[truncated]";

export const estimateTokens = (text) => Math.ceil(String(text ?? "").length / 4);

export function maxContextTokens() {
  const n = Number(process.env.MAX_CONTEXT_TOKENS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_CONTEXT_TOKENS;
}

function cap(text, limit) {
  return text.length > limit ? text.slice(0, limit) + TRUNCATED_MARK : text;
}

/**
 * Pure core. `events` are the candidate directive/agent_message rows (any
 * order); `directiveId` is the directive being answered, or null to continue.
 * Returns { messages, stats, fellOut } where fellOut are the candidate events
 * (oldest first) that no longer fit the window.
 */
export function buildContext({ session, events, participants = [], directiveId = null, maxTokens = maxContextTokens() }) {
  const through = session?.summarized_through_event_id ?? 0;
  const summary = (session?.summary ?? "").trim();
  const controllers = participants.filter((p) => p.role === "controller").map((p) => p.name);
  const pinned =
    `Original task: ${cap(session?.task ?? "", MAX_TASK_CHARS)}\n` +
    `Controller: ${controllers.length ? controllers.join(", ") : "none"}`;

  const sorted = [...events].sort((a, b) => a.id - b.id);
  const current = directiveId == null ? null : sorted.find((e) => e.id === directiveId) ?? null;
  const cutoff = current ? current.id : Infinity;

  // Same visibility rule as before: every reply, and directives older than the
  // one being answered (newer ones wait for their own turn). Already-summarized
  // events are covered by the summary, so they are not repeated.
  const candidates = sorted.filter(
    (e) =>
      e.id > through &&
      e.id !== current?.id &&
      MODEL_EVENT_KINDS.includes(e.kind) &&
      (e.kind === "agent_message" || e.id < cutoff)
  );

  const toMessage = (e, truncate) => {
    const text = truncate ? cap(e.content, MAX_EVENT_CHARS) : e.content;
    return e.kind === "directive"
      ? { role: "user", content: `[${e.author}]: ${text}` }
      : { role: "assistant", content: text };
  };

  const currentMessage = current
    ? toMessage(current, false)
    : { role: "user", content: "Please continue working on the task." };

  // The host's brief, if there is one, as its own message: instructions from the host, never presented as something a person said.
  const brief = String(session?.brief ?? "").trim();
  const head = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(brief ? [{ role: "system", content: `Instructions from the host of this room (everyone in the room can read them):\n${brief}` }] : []),
    { role: "system", content: pinned },
    ...(summary ? [{ role: "system", content: `Summary of earlier events (no longer shown in full):\n${summary}` }] : [])
  ];

  const fixedTokens = [...head, currentMessage].reduce((n, m) => n + estimateTokens(m.content), 0);
  let remaining = maxTokens - fixedTokens;

  // Fill newest -> oldest until the budget is hit; the window stays contiguous.
  const window = [];
  let truncated = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const e = candidates[i];
    const m = toMessage(e, true);
    const cost = estimateTokens(m.content);
    if (cost > remaining) break;
    remaining -= cost;
    if (m.content.endsWith(TRUNCATED_MARK)) truncated++;
    window.unshift({ id: e.id, message: m });
  }

  const messages = [...head, ...window.map((w) => w.message), currentMessage];
  const included = new Set(window.map((w) => w.id));
  const fellOut = candidates.filter((e) => !included.has(e.id));

  return {
    messages,
    fellOut,
    stats: {
      currentFound: directiveId == null || current != null,
      considered: events.length,
      included: window.length + 1, // the window plus the directive being answered
      truncated,
      summarizedThrough: through,
      hasSummary: Boolean(summary),
      approxTokens: messages.reduce((n, m) => n + estimateTokens(m.content), 0)
    }
  };
}

/**
 * Fetches what a step needs and builds its context. Every step goes through
 * here. `db` is a store (or a Supabase client, which is wrapped).
 */
export async function assembleContext(db, sessionOrId, directiveId) {
  // Given a session row, the events query skips what the summary already covers.
  // Given just an id, the session row is fetched in parallel with the events and
  // participants (one round trip instead of two), and the covered events are
  // dropped by buildContext instead of by the query.
  const row = typeof sessionOrId === "object" ? sessionOrId : null;
  const sessionId = row ? row.id : sessionOrId;
  const store = asStore(db);
  const [events, participants, session] = await Promise.all([
    store.listEvents(sessionId, {
      kinds: MODEL_EVENT_KINDS,
      ...(row ? { afterId: row.summarized_through_event_id ?? 0 } : {}),
      order: "desc",
      limit: FETCH_LIMIT
    }),
    store.listParticipants(sessionId),
    row ?? store.getSession(sessionId)
  ]);
  if (!session) throw new Error("Session not found");

  // The directive being answered must be present even if it is not among the
  // newest rows (it always is in practice) or sits before the summary mark.
  if (directiveId != null && !events.some((e) => e.id === directiveId)) {
    const found = await store.getEvent(directiveId);
    if (found) events.push(found);
  }

  return { ...buildContext({ session, events, participants, directiveId }), session };
}
