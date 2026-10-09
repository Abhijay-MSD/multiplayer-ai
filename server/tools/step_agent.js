import { asStore, defaultStore } from "../store/index.js";
import { callModel } from "../providers/index.js";
import { assembleContext } from "../context.js";
import { maybeUpdateSummary } from "../summary.js";
import { authenticateWriter } from "../rooms.js";
import { nudge } from "../hub.js";
import { maxStepsPerSession } from "../config.js";
import { toProviderFailure } from "../providers/failure.js";
import { escapeForLog } from "../safe-text.js";
import { getSettings } from "../settings.js";
import { roomState as stateOf } from "../rooms.js";
import { defaultBudget } from "../budget.js";
import { runAgentLoop } from "../agent/loop.js";
import { TOOL_DEFINITIONS } from "../agent/tools.js";
import { filesMessage } from "../agent/prompt.js";
import { usageLine } from "../agent/usage.js";
import { fileLimits, loopLimits } from "../files/limits.js";
import { NOTICE_NO_FORMAT, NOTICE_REJECTED, TOOL_FORMAT_CONFIRMED, firstNoticeFor, toolsTurnedOff, turnToolsOff } from "../agent/support.js";

// Test seam: the database and the model call can be swapped for fakes. `db` stays
// null until a test sets one; then the default store (opened at startup) is used.
// `provider` and `toolFormats` say which provider is answering and which have a confirmed tool format; `budget` is where
// the extra model calls of a tool loop are claimed. All three are seams for tests.
const deps = { db: null, call: callModel, summarize: maybeUpdateSummary, provider: () => getSettings().provider(), toolFormats: TOOL_FORMAT_CONFIRMED, budget: defaultBudget };
const db = () => asStore(deps.db ?? defaultStore());
export function setStepDeps(next) {
  Object.assign(deps, next);
}

const MAX_STEPS = maxStepsPerSession();

class StepSkipped extends Error {}
class StepStopped extends Error {}
class StepLimit extends Error {}

// session_id -> { jobs: Job[], busy: boolean, queued: Set<directiveId>,
//                 working: boolean, pending: Promise, current: { controller } | null }
// `current` is the step that is running: aborting its controller is what Stop does.
// `working` mirrors sessions.agent_working; `pending` is the latest write of it.
// One drain loop per session, so model calls for a session never overlap and
// replies are written in the order the directives were queued (FIFO).
// Job = { directiveId: number | null, waiter?: { resolve, reject } }
const queues = new Map();

/** Is a step queued or running for this room in this process? (Read only; used before deleting one room.) */
export const stepInProgressFor = (session_id) => {
  const q = queues.get(session_id);
  return Boolean(q && (q.busy || q.jobs.length > 0));
};

/** Is any step queued or running in this process? (Read only; used before deleting every room.) */
export const stepsInProgress = () => [...queues.values()].some((q) => q.busy || q.jobs.length > 0);

function queueFor(session_id) {
  let q = queues.get(session_id);
  if (!q) {
    q = { jobs: [], busy: false, queued: new Set(), working: false, pending: Promise.resolve(), current: null };
    queues.set(session_id, q);
  }
  return q;
}

function enqueue(session_id, job) {
  job.enqueuedAt = Date.now();
  const q = queueFor(session_id);
  if (job.directiveId != null) q.queued.add(job.directiveId);
  q.jobs.push(job);
  if (!q.busy) {
    drain(session_id, q).catch((e) =>
      console.error(`[multiplayer-ai] queue for ${session_id} crashed: ${escapeForLog(e?.message ?? e)}`)
    );
  }
}

/**
 * Stop: aborts the step that is running in the room, and drops the messages waiting behind it (saying so). Resolves to
 * { stopped, dropped }; { stopped: false } when nothing is running. `by` is the name of the person who pressed Stop.
 */
export async function stopRoom(session_id, by) {
  const q = queues.get(session_id);
  if (!q?.current || q.current.controller.signal.aborted) return { stopped: false, dropped: 0 };
  const waiting = q.jobs.splice(0);
  for (const j of waiting) {
    if (j.directiveId != null) q.queued.delete(j.directiveId);
    j.waiter?.reject(new StepStopped(`Stopped by ${by}`));
  }
  q.current.controller.abort({ stoppedBy: by });
  const dropped = waiting.length;
  if (dropped) await writeStatus(session_id, `${dropped} ${dropped === 1 ? "message that was waiting for the agent was" : "messages that were waiting for the agent were"} not answered.`);
  return { stopped: true, dropped };
}

/**
 * Manual step (MCP / REST step_agent). Answers every directive that has no
 * reply yet (e.g. the task seeded by create_session), in order; if there is
 * nothing unanswered it asks the agent to continue. Queues behind any step
 * already running, and resolves with the last step's result.
 */
export async function stepAgent({ session_id, token }) {
  // Steering is the controller's alone (PRD §13); this spends the model budget.
  await authenticateWriter(db(), { session_id, token }, { controller: true });
  const q = queueFor(session_id);
  const events = await db().listEvents(session_id, { columns: "id, kind, reply_to" });

  const replied = new Set(events.filter(e => e.kind === "agent_message").map(e => e.reply_to));
  const unanswered = events
    .filter(e => e.kind === "directive" && !replied.has(e.id) && !q.queued.has(e.id))
    .map(e => e.id);

  const ids = unanswered.length ? unanswered : [null];
  const done = ids.map(directiveId => new Promise((resolve, reject) => {
    enqueue(session_id, { directiveId, waiter: { resolve, reject } });
  }));
  // Earlier jobs' results are not returned; swallow their rejections so only the
  // last one (which we await) can surface, without unhandled-rejection noise.
  done.slice(0, -1).forEach(p => p.catch(() => {}));
  return done[done.length - 1];
}

/**
 * Fire-and-forget: queue a reply to one directive. Never throws; failures
 * become a `status` event.
 */
export function triggerStep(session_id, directiveId) {
  enqueue(session_id, { directiveId });
}

async function drain(session_id, q) {
  q.busy = true;
  try {
    do {
      try {
        while (q.jobs.length) await runJob(session_id, q, q.jobs.shift());
      } finally {
        await clearWorking(session_id, q); // already clear if the last reply cleared it
      }
    } while (q.jobs.length);
  } finally {
    q.busy = false;
  }
}

// agent_working=true. Not awaited by the caller, so the write overlaps the
// step's reads. A no-op while the flag is already up.
function markWorking(session_id, q) {
  if (q.working) return;
  q.working = true;
  q.pending = setWorking(session_id, true);
}

// agent_working=false, once the true write has landed. A no-op if already down.
async function clearWorking(session_id, q) {
  if (!q.working) return;
  q.working = false;
  await q.pending;
  await setWorking(session_id, false);
}

async function runJob(session_id, q, job) {
  const startedAt = Date.now();
  console.error(
    `[multiplayer-ai:timing] step session=${session_id.slice(0, 8)} directive=${job.directiveId} ` +
    `queue_wait=${startedAt - job.enqueuedAt}ms`
  );
  markWorking(session_id, q);
  // Called by runStep once the reply is saved. If nothing else is queued the
  // flag drops now, in parallel with the step_count write, rather than after
  // the summary; with more queued it stays up so the room doesn't flicker.
  const clearIfIdle = () => (q.jobs.length ? undefined : clearWorking(session_id, q));
  const controller = new AbortController();
  q.current = { controller };
  try {
    const { result, session, fellOut } = await runStep({ session_id, directiveId: job.directiveId, clearIfIdle, signal: controller.signal });
    console.error(
      `[multiplayer-ai:timing] step session=${session_id.slice(0, 8)} directive=${job.directiveId} ` +
      `total_directive_to_reply=${Date.now() - job.enqueuedAt}ms`
    );
    job.waiter?.resolve(result);
    // After the reply is written, the flag cleared and the caller released,
    // still inside this session's queue so it can't race the next step.
    await deps.summarize(db(), session, fellOut);
  } catch (e) {
    job.waiter?.reject(e);
    if (e instanceof StepSkipped) return;
    if (job.directiveId != null) await reportFailure(session_id, e);
    // The cap applies to every queued step alike; don't repeat the same status.
    if (e instanceof StepLimit) {
      for (const j of q.jobs.splice(0)) {
        if (j.directiveId != null) q.queued.delete(j.directiveId);
        j.waiter?.reject(e);
      }
    }
  } finally {
    if (job.directiveId != null) q.queued.delete(job.directiveId);
    q.current = null;
  }
}

// The live "agent is working" flag the web app reads (sessions row → Realtime).
// Never fatal: if the column is missing, steps still run.
async function setWorking(session_id, working) {
  try {
    await db().updateSession(session_id, { agent_working: working });
  } catch (e) {
    console.error(`[multiplayer-ai] could not set agent_working=${working}: ${escapeForLog(e.message)}`);
  }
  nudge(session_id);
}

/**
 * Clears flags left behind if the server died mid-step, and tells each such room that its last message was not answered
 * (the work of that step is lost; files it had already written stay). Call once on boot.
 */
export async function resetWorkingFlags() {
  try {
    const stuck = (await db().listSessions({ limit: 100000 })).filter((r) => r.agent_working);
    for (const r of stuck) {
      await writeStatus(r.id, "The server stopped while the agent was working, so a message was not answered. Files it had already written are kept. Send the message again.");
    }
    await db().clearAgentWorking();
  } catch (e) {
    console.error(`[multiplayer-ai] could not reset agent_working flags: ${escapeForLog(e.message)}`);
  }
}

// What a room is told about a failed step. The step cap's message is ours, so it goes
// as written. Anything else is reduced to a category ("the provider didn't accept the
// key", "the provider is busy"): the provider's own words can hold an account name or
// part of a key, so they go to the host's terminal only, with keys hidden.
async function reportFailure(session_id, e) {
  if (e instanceof StepLimit) {
    const detail = String(e.message).split("\n")[0].slice(0, 300);
    console.error(`[multiplayer-ai] step failed for ${session_id}: ${escapeForLog(detail)}`);
    await writeStatus(session_id, `Agent stopped: ${detail}`);
    return;
  }
  const failure = toProviderFailure(e);
  console.error(
    `[multiplayer-ai] step failed for ${session_id}: ${failure.category}` +
    (failure.status ? ` (status ${failure.status})` : "") +
    (failure.detail ? `: ${failure.detail}` : "")
  );
  await writeStatus(session_id, `Agent could not reply: ${failure.message}`);
}

async function writeStatus(session_id, content) {
  try {
    await db().insertEvent({ session_id, kind: "status", author: "system", content });
  } catch (e) {
    console.error(`[multiplayer-ai] could not write status event: ${escapeForLog(e.message)}`);
  }
  nudge(session_id);
}

// Does the room still allow a tool loop? Asked before every model call and tool call, so a room that was archived or
// ended, a host who turned the files off, or a room that was deleted stops the loop at the next step.
async function roomAllows(session_id) {
  const room = await db().getSession(session_id);
  if (!room) return { reason: "deleted", line: null };
  const state = stateOf(room);
  if (state !== "open") return { reason: "room_closed", line: `Stopped: this room was ${state}.` };
  if (room.status !== "active") return { reason: "room_closed", line: `Stopped: this room was ${room.status}.` };
  if (!room.files_enabled) return { reason: "files_off", line: "Stopped: the host turned off file use for this room." };
  return null;
}


/**
 * Advances the agent one step, answering one directive (or continuing):
 *   1. Validates session is active and under the step cap.
 *   2. Assembles the model context (server/context.js).
 *   3. Calls the configured model provider (PROVIDER).
 *   4. Writes the agent_message (reply_to = the directive) and increments
 *      step_count.
 * Returns the step result plus what the post-reply summary pass needs.
 */
async function runStep({ session_id, directiveId, clearIfIdle, signal }) {
  // ── 1+2. Fetch the session and assemble the context (system prompt, pinned
  //       task + controller, rolling summary, newest events within
  //       MAX_CONTEXT_TOKENS, and the directive being answered in full). The
  //       session row, events and participants are read in parallel. ────────
  const { messages, stats, fellOut, session } = await assembleContext(db(), session_id, directiveId);
  if (session.status !== "active") {
    throw new StepSkipped(`Session is "${session.status}" — only active sessions can be stepped.`);
  }
  if (session.step_count >= MAX_STEPS) {
    throw new StepLimit(
      `Session has reached the step limit (${MAX_STEPS}). ` +
      "Set a higher MAX_STEPS_PER_SESSION or end the session."
    );
  }
  if (!stats.currentFound) throw new StepSkipped(`Directive ${directiveId} no longer exists.`);
  console.error(
    `[multiplayer-ai:timing] step session=${session_id.slice(0, 8)} directive=${directiveId} ` +
    `events_considered=${stats.considered} events_included=${stats.included} ` +
    `truncated=${stats.truncated} summary=${stats.hasSummary} approx_context_tokens=${stats.approxTokens}`
  );

  // ── 3. Call the model, with the room's file tools if they are on ──────
  const store = db();
  const limits = loopLimits();
  if (store.supportsFiles && (session.model_calls ?? 0) >= limits.roomModelCalls) {
    throw new StepLimit(`This room has used all ${limits.roomModelCalls} model calls it is allowed (MODEL_CALLS_PER_ROOM).`);
  }
  let useTools = false;
  if (store.supportsFiles && session.files_enabled && !toolsTurnedOff(session_id)) {
    if (deps.toolFormats[deps.provider()] === true) useTools = true;
    else if (firstNoticeFor(session_id)) await writeStatus(session_id, NOTICE_NO_FORMAT);
  }

  let text, model, usedFallback, outcome = null, modelCalls = 1, toolCalls = 0, usage = null, usageComplete = false;
  if (!useTools) {
    try {
      const r = await deps.call({ messages, signal });
      ({ text, model, usedFallback } = r);
      usage = r.usage ?? null;
      usageComplete = Boolean(usage);
    } catch (e) {
      if (!signal.aborted) throw e;
      text = ""; // Stop aborted the request: there is no answer, and no failure to report
    }
  } else {
    const directive = directiveId != null ? await store.getEvent(directiveId) : null;
    const author = directive?.author ?? (await store.listParticipants(session_id)).find((p) => p.role === "controller")?.name ?? "the controller";
    const files = await store.listFiles(session_id);
    const withFiles = [...messages];
    withFiles.splice(2, 0, filesMessage(files)); // after the system prompt and the pinned task
    const base = session.model_calls ?? 0;
    outcome = await runAgentLoop({
      store, sessionId: session_id, author, messages: withFiles, call: deps.call, tools: TOOL_DEFINITIONS,
      limits, fileLimits: fileLimits(), roomCalls: base,
      signal,
      claim: () => deps.budget.claim(store),
      shouldStop: () => roomAllows(session_id),
      hooks: {
        line: (line) => writeStatus(session_id, line),
        noteCall: (n) => store.updateSession(session_id, { model_calls: base + n }).catch(() => {}),
        toolsRejected: async () => {
          turnToolsOff(session_id);
          await writeStatus(session_id, NOTICE_REJECTED);
        }
      }
    });
    ({ text, model, usedFallback, modelCalls, toolCalls, usage, usageComplete } = outcome);
    if (outcome.stopped?.line) await writeStatus(session_id, outcome.stopped.line);
  }

  // Stop was pressed. If the loop already said so, there is nothing more to say; a stop that came in after the model had
  // answered (or during a plain answer) is said here, and either way the answer that was in flight is dropped.
  const stopped = signal.aborted;
  if (stopped) {
    if (outcome?.stopped?.reason !== "stopped") await writeStatus(session_id, signal.reason?.stoppedBy ? `Stopped by ${signal.reason.stoppedBy}` : "Stopped");
    text = "";
  }

  // ── 4. Persist the agent_message event ─────────────────────────
  // If the fallback model answered, say so first so the room can see it.
  if (usedFallback) {
    await writeStatus(session_id, `Primary model was busy; this reply came from ${model}.`);
  }
  // A loop that was stopped before it said anything has no reply to write; the status lines say what happened.
  const event = text
    ? await db().insertEvent({ session_id, kind: "agent_message", author: "agent", content: text, reply_to: directiveId ?? null })
    : null;

  nudge(session_id); // viewers get the reply now, not after the step_count write
  await writeStatus(session_id, usageLine({ modelCalls, toolCalls, usage, usageComplete }));

  // ── 5. Increment step_count, and lower agent_working if idle, together ──
  const newStepCount = session.step_count + 1;
  await Promise.all([
    db().updateSession(session_id, { step_count: newStepCount, ...(store.supportsFiles && !outcome ? { model_calls: (session.model_calls ?? 0) + modelCalls } : {}) }).catch((e) =>
      console.error(`[multiplayer-ai] could not save step_count=${newStepCount}: ${escapeForLog(e.message)}`)
    ),
    clearIfIdle?.()
  ]);

  return {
    result: { event, step_count: newStepCount, steps_remaining: MAX_STEPS - newStepCount, ...(outcome?.stopped ? { stopped: outcome.stopped.reason } : {}) },
    session,
    fellOut
  };
}
