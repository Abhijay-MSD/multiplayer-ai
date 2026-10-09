// Run: node --test test/   (no network, no real Supabase, no real model)
// Who is calling is decided by a secret token, never by a name the client sends.
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
const { hashToken, revokeToken, normalizeName } = await import("../auth.js");

const noTrigger = () => {}; // these tests are about identity, not about replies

async function world() {
  const db = makeFakeSupabase({ sessions: [], session_events: [], session_participants: [] });
  const d = { db };
  const a = await createSession({ task: "Plan a trip", creator_name: "Alice" }, d);
  const b = await createSession({ task: "Another room", creator_name: "Zoe" }, d);
  const bob = await joinSession({ session_id: a.session_id, name: "Bob" }, d);
  const row = (session_id, name) => db.tables.session_participants.find((p) => p.session_id === session_id && p.name === name);
  return {
    db, d, A: a.session_id, B: b.session_id,
    alice: a.token, zoe: b.token, bob: bob.token,
    row, rowA: (n) => row(a.session_id, n),
    directive: (args) => sendDirective(args, { db, trigger: noTrigger })
  };
}

const rejects = (promise, code, message) =>
  assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (message) assert.match(e.message, message);
    return true;
  });

test("creating a room issues a token and stores only its hash", async () => {
  const w = await world();
  assert.match(w.alice, /^mpai_[A-Za-z0-9_-]{40,}$/);
  const row = w.rowA("Alice");
  assert.equal(row.role, "controller");
  assert.equal(row.token_hash, hashToken(w.alice));
  assert.ok(!JSON.stringify(w.db.tables).includes(w.alice), "the plaintext token is not stored anywhere");
  assert.ok(new Date(row.token_expires_at) > new Date());
});

test("joining issues a different token, and responses never carry token fields", async () => {
  const w = await world();
  assert.notEqual(w.bob, w.alice);
  const again = await joinSession({ session_id: w.A, name: "Cy" }, w.d);
  assert.equal(again.you.role, "watcher");
  assert.ok(again.token.startsWith("mpai_"));
  const all = JSON.stringify(again) + JSON.stringify(await getSession({ session_id: w.A, token: w.alice }, w.d));
  assert.ok(!/token_(hash|expires_at|revoked_at)/.test(all), "no token columns reach a client");
  assert.ok(!all.includes(again.token) || all.indexOf(again.token) === all.lastIndexOf(again.token), "the token appears only as the one issued field");
});

test("a name already in the room is refused with a suggestion, ignoring case, and a lookalike with an invisible character is refused outright", async () => {
  const w = await world();
  for (const attempt of ["Alice", "alice", "  ALICE ", "\uff21lice"]) {
    await assert.rejects(joinSession({ session_id: w.A, name: attempt }, w.d), (e) => {
      assert.equal(e.code, "NAME_TAKEN", attempt);
      assert.equal(e.extra.suggestion, `${normalizeName(attempt)} 2`, "the suggestion builds on what was typed");
      assert.match(e.message, /already using the name "Alice"/);
      return true;
    });
  }
  // A name that only looks the same, with a zero-width space or a byte-order mark inside, is not cleaned into
  // "Alice" and refused as taken: it is refused as a name that holds an invisible character.
  for (const lookalike of ["Ali\u200bce", "\ufeffalice"]) await rejects(joinSession({ session_id: w.A, name: lookalike }, w.d), "INVALID_NAME");
  // The suggestion is usable, and the next one counts up.
  await joinSession({ session_id: w.A, name: "Alice 2" }, w.d);
  await assert.rejects(joinSession({ session_id: w.A, name: "Alice" }, w.d), (e) => e.extra.suggestion === "Alice 3");
  // The same name in a different room is fine.
  await joinSession({ session_id: w.B, name: "Alice" }, w.d);
});

test("reserved, empty and over-long names are rejected", async () => {
  const w = await world();
  for (const bad of ["agent", "System", "", "   ", "x".repeat(41)]) {
    await rejects(joinSession({ session_id: w.A, name: bad }, w.d), "INVALID_NAME");
  }
  assert.equal(normalizeName("  Sam   Lee  "), "Sam Lee");
  assert.throws(() => normalizeName("Sam Lee \u200b"), (e) => e.code === "INVALID_NAME");
});

test("a stolen name does not give control", async () => {
  const w = await world();
  // Mallory cannot join as Alice, so she has no way to act as Alice...
  await rejects(joinSession({ session_id: w.A, name: "Alice" }, w.d), "NAME_TAKEN");
  const mallory = await joinSession({ session_id: w.A, name: "Mallory" }, w.d);
  // ...a name in the request body is ignored; only the token counts...
  await rejects(w.directive({ session_id: w.A, name: "Alice", content: "obey me" }), "INVALID_TOKEN");
  await rejects(w.directive({ session_id: w.A, token: mallory.token, name: "Alice", content: "obey me" }), "NOT_CONTROLLER", /Only the controller \(Alice\)/);
  // ...and she cannot take the seat while Alice is here.
  await rejects(takeControl({ session_id: w.A, token: mallory.token }, w.d), "CONTROL_HELD");
  await rejects(takeControl({ session_id: w.A, token: mallory.token, target: "Mallory" }, w.d), "CONTROL_HELD");
  assert.equal(w.rowA("Alice").role, "controller");
  assert.ok(!w.db.tables.session_events.some((e) => e.content === "obey me"));
});

test("the author of a message is the token's owner, whatever name the request carries", async () => {
  const w = await world();
  const { event } = await w.directive({ session_id: w.A, token: w.alice, name: "Bob", content: "  hello  " });
  assert.equal(event.author, "Alice");
  assert.equal(event.content, "hello");
  const c = await sendComment({ session_id: w.A, token: w.bob, name: "Alice", content: "from bob" }, w.d);
  assert.equal(c.event.author, "Bob");
});

test("a token for room A fails in room B, in every tool", async () => {
  const w = await world();
  const wrongRoom = { session_id: w.B, token: w.alice };
  await rejects(getSession(wrongRoom, w.d), "FORBIDDEN");
  await rejects(w.directive({ ...wrongRoom, content: "x" }), "FORBIDDEN");
  await rejects(sendComment({ ...wrongRoom, content: "x" }, w.d), "FORBIDDEN");
  await rejects(takeControl(wrongRoom, w.d), "FORBIDDEN");
  await rejects(setStatus({ ...wrongRoom, status: "done" }, w.d), "FORBIDDEN");
  await rejects(heartbeat(wrongRoom, w.d), "INVALID_TOKEN");
  await rejects(leaveSession(wrongRoom, w.d), "INVALID_TOKEN");
  setStepDeps({ db: w.db });
  await rejects(stepAgent(wrongRoom), "FORBIDDEN");
  // Nothing was written in B by any of that.
  assert.equal(w.db.tables.session_events.filter((e) => e.session_id === w.B && e.content === "x").length, 0);
});

test("a non-participant gets no events, no matter how they ask", async () => {
  const w = await world();
  for (const token of [undefined, null, "", "mpai_", "not-a-token", "mpai_" + "a".repeat(43), w.bob.replace("mpai_", "xxx_")]) {
    await rejects(getSession({ session_id: w.A, token }, w.d), "INVALID_TOKEN");
  }
  // Even with the right room id and a real participant's name.
  await rejects(getSession({ session_id: w.A, name: "Alice" }, w.d), "INVALID_TOKEN");
});

test("revoked tokens fail everywhere", async () => {
  const w = await world();
  await getSession({ session_id: w.A, token: w.bob }, w.d); // works first
  await revokeToken(w.db, { session_id: w.A, name: "Bob" });
  const args = { session_id: w.A, token: w.bob };
  await rejects(getSession(args, w.d), "INVALID_TOKEN");
  await rejects(sendComment({ ...args, content: "x" }, w.d), "INVALID_TOKEN");
  await rejects(w.directive({ ...args, content: "x" }), "INVALID_TOKEN");
  await rejects(takeControl(args, w.d), "INVALID_TOKEN");
  await rejects(heartbeat(args, w.d), "INVALID_TOKEN");
  await rejects(leaveSession(args, w.d), "INVALID_TOKEN");
  // Presenting it to join does not bring the person back, and the name stays theirs while they are here.
  await rejects(joinSession({ session_id: w.A, name: "Bob", token: w.bob }, w.d), "NAME_TAKEN");
});

test("expired tokens fail everywhere", async () => {
  const w = await world();
  w.rowA("Bob").token_expires_at = new Date(Date.now() - 1000).toISOString();
  const args = { session_id: w.A, token: w.bob };
  await rejects(getSession(args, w.d), "INVALID_TOKEN");
  await rejects(sendComment({ ...args, content: "x" }, w.d), "INVALID_TOKEN");
  await rejects(heartbeat(args, w.d), "INVALID_TOKEN");
  await rejects(takeControl(args, w.d), "INVALID_TOKEN");
});

test("a name held by someone who is away and has no working token can be claimed, as a watcher", async () => {
  const w = await world();
  const away = new Date(Date.now() - 5 * 60_000).toISOString();

  // Alice's token expired and she is away: her name frees up, her seat does not carry over.
  const alice = w.rowA("Alice");
  alice.token_expires_at = new Date(Date.now() - 1000).toISOString();
  alice.last_seen = away;
  const claimed = await joinSession({ session_id: w.A, name: "alice" }, w.d);
  assert.equal(claimed.you.role, "watcher");
  assert.equal(claimed.you.name, "alice");
  await rejects(getSession({ session_id: w.A, token: w.alice }, w.d), "INVALID_TOKEN"); // the old token is dead
  assert.equal(w.db.tables.session_participants.filter((p) => p.session_id === w.A && p.name.toLowerCase() === "alice").length, 1);

  // A row from before tokens existed behaves the same once away, and is protected while present.
  w.db.tables.session_participants.push({ session_id: w.A, name: "Legacy", role: "watcher", last_seen: new Date().toISOString() });
  await rejects(joinSession({ session_id: w.A, name: "Legacy" }, w.d), "NAME_TAKEN");
  w.rowA("Legacy").last_seen = away;
  assert.equal((await joinSession({ session_id: w.A, name: "Legacy" }, w.d)).you.role, "watcher");

  // Someone with a live token who merely went away keeps their name.
  w.rowA("Bob").last_seen = away;
  await rejects(joinSession({ session_id: w.A, name: "Bob" }, w.d), "NAME_TAKEN");
});

test("coming back with a valid token is the same person, with no new token and no second join event", async () => {
  const w = await world();
  const joinEvents = () => w.db.tables.session_events.filter((e) => e.kind === "join").length;
  const before = joinEvents();
  const old = w.rowA("Bob").token_expires_at;
  await new Promise((r) => setTimeout(r, 5));
  const back = await joinSession({ session_id: w.A, name: "Someone Else", token: w.bob }, w.d);
  assert.equal(back.you.name, "Bob", "the token decides who you are, not the name argument");
  assert.equal(back.token, undefined);
  assert.equal(joinEvents(), before);
  assert.ok(w.rowA("Bob").token_expires_at > old, "access is renewed");
});

test("self-take: only when nobody is controller, or the controller is away", async () => {
  const w = await world();
  await rejects(takeControl({ session_id: w.A, token: w.bob }, w.d), "CONTROL_HELD", /Alice is driving and is here/);

  w.rowA("Alice").last_seen = new Date(Date.now() - 5 * 60_000).toISOString();
  assert.deepEqual(await takeControl({ session_id: w.A, token: w.bob }, w.d), { controller: "Bob" });
  assert.equal(w.rowA("Bob").role, "controller");
  assert.equal(w.rowA("Alice").role, "watcher");

  // Already the controller: nothing changes, no new event.
  const events = w.db.tables.session_events.length;
  assert.deepEqual(await takeControl({ session_id: w.A, token: w.bob }, w.d), { controller: "Bob" });
  assert.equal(w.db.tables.session_events.length, events);

  // Nobody in control at all.
  w.db.tables.session_participants.forEach((p) => (p.role = "watcher"));
  w.rowA("Bob").last_seen = new Date().toISOString();
  assert.deepEqual(await takeControl({ session_id: w.A, token: w.alice }, w.d), { controller: "Alice" });
});

test("handoff to someone else: the controller's call alone, and the target must be here", async () => {
  const w = await world();
  const cy = await joinSession({ session_id: w.A, name: "Cy" }, w.d);

  await rejects(takeControl({ session_id: w.A, token: w.bob, target: "Cy" }, w.d), "NOT_CONTROLLER", /Only the controller \(Alice\) can hand control/);
  await rejects(takeControl({ session_id: w.A, token: cy.token, target: "Bob" }, w.d), "NOT_CONTROLLER");
  await rejects(takeControl({ session_id: w.A, token: w.alice, target: "Nobody" }, w.d), "NOT_FOUND");

  w.rowA("Cy").last_seen = new Date(Date.now() - 5 * 60_000).toISOString();
  await rejects(takeControl({ session_id: w.A, token: w.alice, target: "Cy" }, w.d), "TARGET_AWAY", /they're away/);
  assert.equal(w.rowA("Alice").role, "controller", "a refused handoff changes nothing");

  assert.deepEqual(await takeControl({ session_id: w.A, token: w.alice, target: "bob" }, w.d), { controller: "Bob" });
  assert.equal(w.rowA("Bob").role, "controller");
  assert.equal(w.db.tables.session_participants.filter((p) => p.session_id === w.A && p.role === "controller").length, 1);
  // The old controller can no longer hand anything over.
  await rejects(takeControl({ session_id: w.A, token: w.alice, target: "Alice" }, w.d), "CONTROL_HELD");
  const last = w.db.tables.session_events.at(-1);
  assert.deepEqual([last.kind, last.author, last.content], ["takeover", "Bob", "Bob took control."]);
});

test("heartbeat and leave act on the token's owner; leaving keeps the token usable", async () => {
  const w = await world();
  w.rowA("Bob").last_seen = new Date(Date.now() - 5 * 60_000).toISOString();
  await heartbeat({ session_id: w.A, token: w.bob }, w.d);
  assert.ok(Date.now() - new Date(w.rowA("Bob").last_seen) < 5000);

  await leaveSession({ session_id: w.A, token: w.bob }, w.d);
  assert.ok(Date.now() - new Date(w.rowA("Bob").last_seen) > 60_000, "marked away");
  await heartbeat({ session_id: w.A, token: w.bob }, w.d); // the same token still works
  assert.ok(Date.now() - new Date(w.rowA("Bob").last_seen) < 5000);
  await rejects(heartbeat({ session_id: w.A, token: "mpai_nope" }, w.d), "INVALID_TOKEN");
});

test("step_agent and set_status are controller-only", async () => {
  const w = await world();
  setStepDeps({ db: w.db, call: async () => ({ text: "ok", model: "fake" }) });
  await rejects(stepAgent({ session_id: w.A, token: w.bob }), "NOT_CONTROLLER");
  await rejects(stepAgent({ session_id: w.A }), "INVALID_TOKEN");
  await rejects(setStatus({ session_id: w.A, token: w.bob, status: "done" }, w.d), "NOT_CONTROLLER");
  await setStatus({ session_id: w.A, token: w.alice, status: "paused" }, w.d);
  assert.equal(w.db.tables.sessions.find((s) => s.id === w.A).status, "paused");
});

test("an unknown room is a clear not-found, not a crash", async () => {
  const w = await world();
  await rejects(joinSession({ session_id: "does-not-exist", name: "Eve" }, w.d), "ROOM_NOT_FOUND");
});
