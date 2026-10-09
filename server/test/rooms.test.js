// Run: node --test test/   (no network, no real Supabase, no real model)
// Room states (open, ended, archived), what each allows, and auto_start.
import test from "node:test";
import assert from "node:assert/strict";
import { makeFakeSupabase } from "./fakeSupabase.js";

process.env.SUPABASE_URL ||= "http://localhost:0";
process.env.SUPABASE_SERVICE_KEY ||= "test";
const { createSession } = await import("../tools/create_session.js");
const { joinSession } = await import("../tools/join_session.js");
const { getSession } = await import("../tools/get_session.js");
const { sendDirective } = await import("../tools/send_directive.js");
const { sendComment } = await import("../tools/send_comment.js");
const { takeControl } = await import("../tools/take_control.js");
const { heartbeat } = await import("../tools/heartbeat.js");
const { leaveSession } = await import("../tools/leave_session.js");
const { setStatus } = await import("../tools/set_status.js");
const { stepAgent, setStepDeps } = await import("../tools/step_agent.js");
const { roomState, archiveAfterDays } = await import("../rooms.js");

const DAY = 86_400_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
};
const rejects = (promise, code) => assert.rejects(promise, (e) => (assert.equal(e.code, code, e.message), true));

test.beforeEach(() => {
  delete process.env.ARCHIVE_AFTER_DAYS;
});

async function world() {
  const db = makeFakeSupabase({ sessions: [], session_events: [], session_participants: [] });
  const d = { db, trigger: () => {} };
  const room = await createSession({ task: "Plan a trip", creator_name: "Alice" }, d);
  const bob = await joinSession({ session_id: room.session_id, name: "Bob" }, d);
  const session = db.tables.sessions.find((s) => s.id === room.session_id);
  session.updated_at = new Date().toISOString(); // the database trigger does this on every event
  return {
    db, d, session, id: room.session_id, alice: room.token, bob: bob.token,
    writes: () => db.tables.session_events.length,
    quiet: (ms) => (session.updated_at = ago(ms)),
    stepDb: () => setStepDeps({ db, call: async () => ({ text: "ok", model: "fake" }) })
  };
}

test("a room is archived after ARCHIVE_AFTER_DAYS without activity: 7 by default, from the env otherwise", () => {
  assert.equal(archiveAfterDays(), 7);
  assert.equal(roomState({ status: "active", updated_at: ago(6.9 * DAY) }), "open");
  assert.equal(roomState({ status: "active", updated_at: ago(7.1 * DAY) }), "archived");
  assert.equal(roomState({ status: "active" }), "open", "no timestamp counts as fresh");

  process.env.ARCHIVE_AFTER_DAYS = "1";
  assert.equal(archiveAfterDays(), 1);
  assert.equal(roomState({ status: "active", updated_at: ago(1.1 * DAY) }), "archived");
  for (const bad of ["", "abc", "0", "-3"]) {
    process.env.ARCHIVE_AFTER_DAYS = bad;
    assert.equal(archiveAfterDays(), 7, `"${bad}" falls back to 7`);
  }
});

test("ended, and archived wins over ended", () => {
  assert.equal(roomState({ status: "done", updated_at: ago(DAY) }), "ended");
  assert.equal(roomState({ status: "done", updated_at: ago(30 * DAY) }), "archived");
  assert.equal(roomState({ status: "paused", updated_at: ago(DAY) }), "open");
});

test("every write to an archived room is refused with 410 and writes nothing", async () => {
  const w = await world();
  w.stepDb();
  w.quiet(8 * DAY);
  const before = w.writes();
  await rejects(sendDirective({ session_id: w.id, token: w.alice, content: "hi" }, w.d), "ROOM_ARCHIVED");
  await rejects(sendComment({ session_id: w.id, token: w.bob, content: "hi" }, w.d), "ROOM_ARCHIVED");
  await rejects(takeControl({ session_id: w.id, token: w.bob }, w.d), "ROOM_ARCHIVED");
  await rejects(setStatus({ session_id: w.id, token: w.alice, status: "active" }, w.d), "ROOM_ARCHIVED");
  await rejects(stepAgent({ session_id: w.id, token: w.alice }), "ROOM_ARCHIVED");
  assert.equal(w.writes(), before);
  await assert.rejects(sendDirective({ session_id: w.id, token: w.alice, content: "hi" }, w.d), /archived after 7 days/);
});

test("a bad token is reported before the room being read-only", async () => {
  const w = await world();
  w.quiet(8 * DAY);
  await rejects(sendComment({ session_id: w.id, token: "mpai_nope", content: "hi" }, w.d), "INVALID_TOKEN");
});

test("people already in an archived room can still open and read it; presence still works", async () => {
  const w = await world();
  w.quiet(8 * DAY);
  const back = await joinSession({ session_id: w.id, token: w.bob }, w.d);
  assert.equal(back.room.state, "archived");
  assert.equal(back.room.archive_after_days, 7);
  assert.equal(back.you.name, "Bob");
  assert.ok(back.events.length > 0, "the transcript is readable");
  assert.equal((await getSession({ session_id: w.id, token: w.bob }, w.d)).room.state, "archived");
  await heartbeat({ session_id: w.id, token: w.bob }, w.d);
  await leaveSession({ session_id: w.id, token: w.bob }, w.d);
});

test("nobody new can join an archived room, whatever name they bring", async () => {
  const w = await world();
  w.quiet(8 * DAY);
  await rejects(joinSession({ session_id: w.id, name: "Carol" }, w.d), "ROOM_ARCHIVED");
  await rejects(joinSession({ session_id: w.id, name: "Alice" }, w.d), "ROOM_ARCHIVED"); // not NAME_TAKEN
  await rejects(joinSession({ session_id: w.id }, w.d), "ROOM_ARCHIVED");
  assert.ok(!w.db.tables.session_participants.some((p) => p.name === "Carol"));
});

test("an ended room is read-only, can be reopened by its controller, and not by anyone else", async () => {
  const w = await world();
  await setStatus({ session_id: w.id, token: w.alice, status: "done" }, w.d);
  assert.equal((await joinSession({ session_id: w.id, token: w.bob }, w.d)).room.state, "ended");

  await rejects(sendDirective({ session_id: w.id, token: w.alice, content: "hi" }, w.d), "ROOM_ENDED");
  await rejects(sendComment({ session_id: w.id, token: w.bob, content: "hi" }, w.d), "ROOM_ENDED");
  await rejects(joinSession({ session_id: w.id, name: "Carol" }, w.d), "ROOM_ENDED");
  await rejects(setStatus({ session_id: w.id, token: w.bob, status: "active" }, w.d), "NOT_CONTROLLER");

  await setStatus({ session_id: w.id, token: w.alice, status: "active" }, w.d);
  await sendComment({ session_id: w.id, token: w.bob, content: "we're back" }, w.d);
  assert.equal((await getSession({ session_id: w.id, token: w.bob }, w.d)).room.state, "open");
});

test("a room that doesn't exist is a clear 404", async () => {
  const w = await world();
  const ghost = "00000000-0000-4000-8000-000000000000";
  await rejects(joinSession({ session_id: ghost, name: "Eve" }, w.d), "ROOM_NOT_FOUND");
  await rejects(sendComment({ session_id: ghost, token: w.bob, content: "x" }, w.d), "FORBIDDEN"); // a token for another room is checked first
  await assert.rejects(joinSession({ session_id: ghost, name: "Eve" }, w.d), (e) => e.status === 404 && /doesn't exist/.test(e.message));
});

// ── create_session and auto_start ───────────────────────────────────

test("auto_start queues the first reply for the task; without it nothing is queued (MCP callers keep the old behavior)", async () => {
  const db = makeFakeSupabase({ sessions: [], session_events: [], session_participants: [] });
  const queued = [];
  const d = { db, trigger: (...a) => queued.push(a) };

  const plain = await createSession({ task: "No auto start", creator_name: "Ann" }, d);
  assert.deepEqual(queued, []);
  assert.equal(plain.auto_start, false);
  assert.match(plain.next_step, /Call step_agent/);

  for (const notTrue of ["true", 1, null, undefined, false]) {
    await createSession({ task: "Still no", creator_name: "Bo", auto_start: notTrue }, d);
  }
  assert.deepEqual(queued, [], "only a real true starts the agent");

  const started = await createSession({ task: "  Start now  ", creator_name: "Cy", auto_start: true }, d);
  const directive = db.tables.session_events.find((e) => e.session_id === started.session_id && e.kind === "directive");
  assert.deepEqual(queued, [[started.session_id, directive.id]]);
  assert.equal(directive.content, "Start now", "the task is trimmed");
  assert.equal(directive.author, "Cy");
  assert.equal(started.auto_start, true);
});

test("with auto_start the first reply arrives on its own, once, through the real queue", async () => {
  const db = makeFakeSupabase({ sessions: [], session_events: [], session_participants: [] });
  const calls = [];
  setStepDeps({ db, summarize: async () => {}, call: async ({ messages }) => (calls.push(messages), { text: "first reply", model: "fake" }) });

  const room = await createSession({ task: "Plan the launch", creator_name: "Dana", auto_start: true }, { db });
  await waitFor(() => db.tables.session_events.some((e) => e.kind === "agent_message"));
  await sleep(40);
  const replies = db.tables.session_events.filter((e) => e.kind === "agent_message");
  const directive = db.tables.session_events.find((e) => e.kind === "directive");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].reply_to, directive.id);
  assert.equal(calls.at(-1).at(-1).content, "[Dana]: Plan the launch");
  assert.equal(db.tables.sessions.find((s) => s.id === room.session_id).step_count, 1);
});

test("a task is required, and the title defaults to its start", async () => {
  const db = makeFakeSupabase({ sessions: [], session_events: [], session_participants: [] });
  const d = { db, trigger: () => {} };
  for (const bad of [undefined, null, "", "   ", 42]) {
    await rejects(createSession({ task: bad, creator_name: "Ann" }, d), "BAD_REQUEST");
  }
  assert.equal(db.tables.sessions.length, 0, "nothing was created");
  const r = await createSession({ task: "x".repeat(100), creator_name: "Ann" }, d);
  assert.equal(r.title, "x".repeat(60));
  assert.equal((await createSession({ task: "A task", title: "  My title ", creator_name: "Ann" }, d)).title, "My title");
});
