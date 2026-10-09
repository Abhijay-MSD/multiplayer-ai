// Run: node --test test/   (no network, no real Supabase, no real model)
import test from "node:test";
import assert from "node:assert/strict";
import { makeFakeSupabase } from "./fakeSupabase.js";

// These tests are about steering and streaming, not pacing: lift the per-person message limits
// (limits.test.js covers them) before the tools are imported.
process.env.DIRECTIVE_LIMIT_PER_MIN ||= "10000";
process.env.COMMENT_LIMIT_PER_MIN ||= "10000";
process.env.SUPABASE_URL ||= "http://localhost:0"; // supabase.js needs these to import; never used here
process.env.SUPABASE_SERVICE_KEY ||= "test";
const { sendDirective } = await import("../tools/send_directive.js");
const { sendComment } = await import("../tools/send_comment.js");
const { takeControl } = await import("../tools/take_control.js");
const { setStepDeps } = await import("../tools/step_agent.js");
const { hashToken } = await import("../auth.js");
const { maybeUpdateSummary } = await import("../summary.js");

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
// Each seeded participant holds a token; the database stores only its hash.
const TOK = { Alice: "mpai_alice", Bob: "mpai_bob", Cy: "mpai_cy" };
const credential = (who) => ({
  token_hash: hashToken(TOK[who]),
  token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  token_revoked_at: null
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
};

function world(dbOpts) {
  const db = makeFakeSupabase({
    sessions: [{ id: SID, task: "Plan a trip", status: "active", step_count: 0, agent_working: false }],
    session_events: [],
    session_participants: [
      { session_id: SID, name: "Alice", role: "controller", last_seen: new Date().toISOString(), ...credential("Alice") },
      { session_id: SID, name: "Bob", role: "watcher", last_seen: new Date().toISOString(), ...credential("Bob") },
      { session_id: SID, name: "Cy", role: "watcher", last_seen: new Date().toISOString(), ...credential("Cy") }
    ]
  }, dbOpts);
  const calls = [];
  let gate = null; // when set, model calls wait for it
  setStepDeps({
    db,
    summarize: maybeUpdateSummary, // tests that stub the summary do it after world()
    call: async ({ messages }) => {
      calls.push(messages);
      if (gate) await gate.promise;
      return { text: `reply #${calls.length}`, model: "fake" };
    }
  });
  const hold = () => {
    let release;
    gate = { promise: new Promise((r) => (release = r)) };
    return () => { gate = null; release(); };
  };
  const events = () => db.tables.session_events;
  const replies = () => events().filter((e) => e.kind === "agent_message");
  const idle = () => !db.tables.sessions[0].agent_working && calls.length === replies().length;
  const roleOf = (n) => db.tables.session_participants.find((p) => p.name === n).role;
  return { db, calls, hold, events, replies, idle, roleOf };
}
const asDb = (w) => ({ db: w.db });

test("a watcher's directive is rejected: nothing written, no step, clear error", async () => {
  const w = world();
  await assert.rejects(
    sendDirective({ session_id: SID, token: TOK.Bob, content: "do it my way" }, asDb(w)),
    /Only the controller \(Alice\) can message the agent\. Ask them to hand control to you/
  );
  await sleep(30);
  assert.equal(w.events().length, 0);
  assert.equal(w.calls.length, 0);
});

test("non-participants and a controller-less room are rejected", async () => {
  const w = world();
  await assert.rejects(sendDirective({ session_id: SID, token: "mpai_zed", content: "x" }, asDb(w)), /isn.t valid/);
  w.db.tables.session_participants.forEach((p) => (p.role = "watcher"));
  await assert.rejects(sendDirective({ session_id: SID, token: TOK.Alice, content: "x" }, asDb(w)), /Nobody is controller/);
  // ...but anyone can still take control for themselves when nobody holds it, then steer
  await takeControl({ session_id: SID, token: TOK.Bob }, asDb(w));
  await sendDirective({ session_id: SID, token: TOK.Bob, content: "now me" }, asDb(w));
  await waitFor(() => w.replies().length === 1 && w.idle());
});

test("a controller's directive triggers exactly one reply, attributed with reply_to", async () => {
  const w = world();
  const { event } = await sendDirective({ session_id: SID, token: TOK.Alice, content: "hi" }, asDb(w));
  await waitFor(() => w.replies().length === 1 && w.idle());
  await sleep(50);
  assert.equal(w.replies().length, 1);
  assert.equal(w.calls.length, 1);
  assert.equal(w.replies()[0].reply_to, event.id);
  assert.equal(w.db.tables.sessions[0].step_count, 1);
});

test("comments never trigger a step, never touch agent_working, and never reach the model", async () => {
  const w = world();
  const working = [];
  const sessionRow = w.db.tables.sessions[0];
  let v = sessionRow.agent_working;
  Object.defineProperty(sessionRow, "agent_working", { get: () => v, set: (x) => { working.push(x); v = x; } });

  await sendComment({ session_id: SID, token: TOK.Bob, content: "SECRET-WATCHER-COMMENT" }, asDb(w));
  await sendComment({ session_id: SID, token: TOK.Alice, content: "SECRET-CONTROLLER-COMMENT" }, asDb(w));
  await sleep(60);
  assert.equal(w.events().filter((e) => e.kind === "comment").length, 2);
  assert.equal(w.calls.length, 0);
  assert.equal(w.replies().length, 0);
  assert.deepEqual(working, []);

  await assert.rejects(sendComment({ session_id: SID, token: "mpai_zed", content: "x" }, asDb(w)), /isn.t valid/);
  await assert.rejects(sendComment({ session_id: SID, token: TOK.Bob, content: "   " }, asDb(w)), /empty/);

  await sendDirective({ session_id: SID, token: TOK.Alice, content: "hello agent" }, asDb(w));
  await waitFor(() => w.replies().length === 1 && w.idle());
  const sent = w.calls[0].map((m) => m.content).join("\n");
  assert.doesNotMatch(sent, /SECRET/);
  assert.match(sent, /hello agent/);
  assert.doesNotMatch(sent, /Priority directive|controller Alice|acted upon/i);
});

test("a handoff mid-queue keeps queued directives attributed to their senders and answers all of them in order", async () => {
  const w = world();
  const release = w.hold();
  const d1 = (await sendDirective({ session_id: SID, token: TOK.Alice, content: "first" }, asDb(w))).event;
  await waitFor(() => w.calls.length === 1); // d1 is in the model call
  const d2 = (await sendDirective({ session_id: SID, token: TOK.Alice, content: "second" }, asDb(w))).event;

  await takeControl({ session_id: SID, token: TOK.Alice, target: "Bob" }, asDb(w)); // handoff while d1 runs, d2 queued
  assert.equal(w.roleOf("Bob"), "controller");
  await assert.rejects(sendDirective({ session_id: SID, token: TOK.Alice, content: "too late" }, asDb(w)), /Only the controller \(Bob\)/);
  const d3 = (await sendDirective({ session_id: SID, token: TOK.Bob, content: "third" }, asDb(w))).event;

  release();
  await waitFor(() => w.replies().length === 3 && w.idle());

  assert.deepEqual(w.replies().map((r) => r.reply_to), [d1.id, d2.id, d3.id]);
  assert.deepEqual([d1, d2, d3].map((d) => w.events().find((e) => e.id === d.id).author), ["Alice", "Alice", "Bob"]);
  const lastUser = (i) => w.calls[i].at(-1).content;
  assert.equal(lastUser(1), "[Alice]: second");
  assert.equal(lastUser(2), "[Bob]: third");
  assert.ok(!w.events().some((e) => e.content === "too late"), "rejected text was not stored");
});

test("directives racing a handoff: no crash, each is either rejected cleanly or accepted and answered once", async () => {
  for (let i = 0; i < 40; i++) {
    const w = world();
    const results = await Promise.allSettled([
      sendDirective({ session_id: SID, token: TOK.Alice, content: `race ${i}` }, asDb(w)),
      takeControl({ session_id: SID, token: TOK.Alice, target: "Bob" }, asDb(w)),
      sendDirective({ session_id: SID, token: TOK.Bob, content: `bob ${i}` }, asDb(w))
    ]);
    for (const r of results) {
      if (r.status === "rejected") assert.match(r.reason.message, /Only the controller|Nobody is controller/);
    }
    const accepted = w.events().filter((e) => e.kind === "directive");
    await waitFor(() => w.replies().length === accepted.length && w.idle());
    await sleep(10);
    assert.equal(w.replies().length, accepted.length, "one reply per accepted directive, none lost");
    assert.deepEqual(new Set(w.replies().map((r) => r.reply_to)), new Set(accepted.map((d) => d.id)));
    assert.equal(w.db.tables.session_participants.filter((p) => p.role === "controller").length, 1);
  }
});

test("directive to reply costs 4 serial round trips, and agent_working still goes true then false", async () => {
  // With 100ms per query: check controller (1) + write directive (2) + session/events/participants in parallel (3)
  // + write reply (4). The working=true write overlaps (3) instead of adding a hop. Before this change it was 6 hops.
  const w = world({ latencyMs: 100 });
  const sessionRow = w.db.tables.sessions[0];
  const working = [];
  let v = sessionRow.agent_working;
  Object.defineProperty(sessionRow, "agent_working", { get: () => v, set: (x) => { working.push(x); v = x; } });

  const started = Date.now();
  await sendDirective({ session_id: SID, token: TOK.Alice, content: "hi" }, asDb(w));
  await waitFor(() => w.replies().length === 1);
  const toReply = Date.now() - started;
  await waitFor(() => w.idle());

  assert.ok(toReply < 500, `directive to reply took ${toReply}ms; expected about 400ms (4 hops), not 600ms (6 hops)`);
  assert.deepEqual(working, [true, false]);
});

// Records every write to the named columns of the session row: [{ k, v, t }].
function watchSession(w, keys) {
  const row = w.db.tables.sessions[0];
  const log = [];
  for (const k of keys) {
    let v = row[k];
    Object.defineProperty(row, k, { get: () => v, set: (x) => { log.push({ k, v: x, t: Date.now() }); v = x; } });
  }
  return log;
}

test("after the reply, step_count and agent_working=false are written together, and the summary starts after the flag is down", async () => {
  const w = world({ latencyMs: 100 });
  const log = watchSession(w, ["agent_working", "step_count"]);
  let summary = null;
  setStepDeps({ summarize: async () => (summary = { t: Date.now(), working: w.db.tables.sessions[0].agent_working }) });

  await sendDirective({ session_id: SID, token: TOK.Alice, content: "hi" }, asDb(w));
  await waitFor(() => summary);

  const stepCount = log.find((x) => x.k === "step_count");
  const flagDown = log.find((x) => x.k === "agent_working" && x.v === false);
  assert.ok(Math.abs(stepCount.t - flagDown.t) < 50, `writes landed ${Math.abs(stepCount.t - flagDown.t)}ms apart; one hop is 100ms`);
  assert.equal(summary.working, false, "the flag was already down when the summary started");
  assert.ok(summary.t >= flagDown.t && summary.t >= stepCount.t);
});

test("a directive sent during a summary waits for it, then gets its own reply and working cycle", async () => {
  const w = world({ latencyMs: 20 });
  const log = watchSession(w, ["agent_working"]);
  let release;
  const gate = new Promise((r) => (release = r));
  let summaries = 0;
  setStepDeps({ summarize: async () => { if (++summaries === 1) await gate; } });

  const first = await sendDirective({ session_id: SID, token: TOK.Alice, content: "one" }, asDb(w));
  await waitFor(() => summaries === 1); // reply one is saved, the summary is running
  assert.equal(w.db.tables.sessions[0].agent_working, false);
  assert.equal(w.replies().length, 1);

  const second = await sendDirective({ session_id: SID, token: TOK.Alice, content: "two" }, asDb(w));
  await sleep(200);
  assert.equal(w.replies().length, 1, "no step runs while the summary holds the queue");

  release();
  await waitFor(() => w.replies().length === 2 && summaries === 2 && w.idle());
  assert.deepEqual(w.replies().map((r) => r.reply_to), [first.event.id, second.event.id]);
  assert.deepEqual(log.map((x) => x.v), [true, false, true, false]);
});

test("directives queued back to back keep agent_working up between replies", async () => {
  const w = world({ latencyMs: 50 });
  const log = watchSession(w, ["agent_working"]);
  setStepDeps({ summarize: async () => {} });

  const [a, b] = await Promise.all([
    sendDirective({ session_id: SID, token: TOK.Alice, content: "one" }, asDb(w)),
    sendDirective({ session_id: SID, token: TOK.Alice, content: "two" }, asDb(w))
  ]);
  await waitFor(() => w.replies().length === 2 && w.idle());
  assert.deepEqual(w.replies().map((r) => r.reply_to).sort(), [a.event.id, b.event.id].sort());
  assert.deepEqual(log.map((x) => x.v), [true, false], "one working cycle for the whole burst");
  assert.equal(w.db.tables.sessions[0].step_count, 2);
});
