// Run: node --test test/   (no network, no real model)
// The storage rules, stated once and run against every store that has no
// outside dependency: memory, a SQLite file, and in-memory SQLite. A rule that
// holds on all three is a rule of the interface, not of one engine.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { makers, cleanup } from "./helpers/stores.js";
import { StoreError } from "../store/errors.js";

after(cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rejectsWith = (promise, code) =>
  assert.rejects(promise, (e) => e instanceof StoreError && e.code === code, `expected a ${code} StoreError`);

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const future = () => new Date(Date.now() + 86_400_000).toISOString();
const past = () => new Date(Date.now() - 86_400_000).toISOString();

// Alice's token is HASH_A in the first room a store has; a second room gets its own, since a hash belongs to one person.
let rooms = 0;
async function room(store) {
  const session = await store.createSession({ title: "Trip", task: "Plan a trip" });
  const hash = rooms++ === 0 || !(await store.findByTokenHash(HASH_A)) ? HASH_A : String(rooms).padStart(64, "c");
  await store.insertParticipant({ session_id: session.id, name: "Alice", role: "controller", token_hash: hash, token_expires_at: future() });
  return session;
}

for (const [name, make] of Object.entries(makers)) {
  const t = (title, fn) => test(`[${name}] ${title}`, async () => fn(await make()));

  // ── sessions ───────────────────────────────────────────────────────
  t("a new session is active, at step 0, not working, with timestamps and no summary", async (s) => {
    const row = await s.createSession({ title: "T", task: "do it" });
    assert.match(row.id, /^[0-9a-f-]{36}$/);
    assert.equal(row.status, "active");
    assert.equal(row.step_count, 0);
    assert.strictEqual(row.agent_working, false);
    assert.equal(row.summary, null);
    assert.equal(row.summarized_through_event_id, null);
    assert.match(row.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.deepEqual(await s.getSession(row.id), row);
    assert.equal(await s.getSession("00000000-0000-0000-0000-000000000000"), null);
  });

  t("updateSession changes only what it is given, and agent_working stays a boolean", async (s) => {
    const { id } = await s.createSession({ title: "T", task: "x" });
    await s.updateSession(id, { agent_working: true, step_count: 3 });
    let row = await s.getSession(id);
    assert.strictEqual(row.agent_working, true);
    assert.equal(row.step_count, 3);
    assert.equal(row.status, "active");
    await s.updateSession(id, { summary: "so far", summarized_through_event_id: 7 });
    row = await s.getSession(id);
    assert.equal(row.summary, "so far");
    assert.equal(row.summarized_through_event_id, 7);
  });

  t("clearAgentWorking lowers the flag in every room", async (s) => {
    const a = await s.createSession({ title: "A", task: "x" });
    const b = await s.createSession({ title: "B", task: "x" });
    await s.updateSession(a.id, { agent_working: true });
    await s.updateSession(b.id, { agent_working: true });
    await s.clearAgentWorking();
    assert.strictEqual((await s.getSession(a.id)).agent_working, false);
    assert.strictEqual((await s.getSession(b.id)).agent_working, false);
  });

  t("rules on sessions: status must be known, text has a length limit, step_count is not negative", async (s) => {
    const { id } = await s.createSession({ title: "T", task: "x" });
    await rejectsWith(s.updateSession(id, { status: "finished" }), "CONSTRAINT");
    await rejectsWith(s.updateSession(id, { step_count: -1 }), "CONSTRAINT");
    await rejectsWith(s.updateSession(id, { task: "a different task" }), "CONSTRAINT"); // not a changeable field
    await s.updateSession(id, { title: "renamed" });
    assert.equal((await s.getSession(id)).title, "renamed");
    for (const bad of ["", "   ", "T".repeat(121), 5, null]) await rejectsWith(s.updateSession(id, { title: bad }), "CONSTRAINT");
    await s.updateSession(id, { title: "T".repeat(120) });
    await rejectsWith(s.updateSession(id, { archived_at: 5 }), "CONSTRAINT");
    await s.updateSession(id, { archived_at: "2026-10-09T00:00:00.000Z" });
    assert.equal((await s.getSession(id)).archived_at, "2026-10-09T00:00:00.000Z");
    await s.updateSession(id, { archived_at: null });
    assert.equal((await s.getSession(id)).archived_at, null);
    await rejectsWith(s.createSession({ title: "T", task: "x".repeat(4001) }), "CONSTRAINT");
    await rejectsWith(s.createSession({ title: "T".repeat(121), task: "x" }), "CONSTRAINT");
    assert.ok(await s.createSession({ title: "T".repeat(120), task: "x".repeat(4000) }), "the limits themselves are allowed");
    assert.equal((await s.getSession(id)).status, "active", "a refused change changed nothing");
  });

  // ── events ─────────────────────────────────────────────────────────
  t("events get rising ids, come back in id order, and can be filtered, windowed and limited", async (s) => {
    const { id } = await room(s);
    const add = (kind, content, extra = {}) => s.insertEvent({ session_id: id, kind, author: "Alice", content, ...extra });
    const e1 = await add("join", "joined");
    const e2 = await add("directive", "hello");
    const e3 = await add("comment", "chat");
    const e4 = await add("agent_message", "hi", { reply_to: e2.id });
    assert.ok(e1.id < e2.id && e2.id < e3.id && e3.id < e4.id);
    assert.equal(e4.reply_to, e2.id);
    assert.equal(e1.reply_to, null);

    assert.deepEqual((await s.listEvents(id)).map((e) => e.id), [e1.id, e2.id, e3.id, e4.id]);
    assert.deepEqual((await s.listEvents(id, { kinds: ["directive", "agent_message"] })).map((e) => e.id), [e2.id, e4.id]);
    assert.deepEqual((await s.listEvents(id, { afterId: e1.id, uptoId: e3.id })).map((e) => e.id), [e2.id, e3.id]);
    assert.deepEqual((await s.listEvents(id, { order: "desc", limit: 2 })).map((e) => e.id), [e4.id, e3.id]);
    assert.deepEqual(await s.listEvents(id, { columns: "id, kind" }), [
      { id: e1.id, kind: "join" }, { id: e2.id, kind: "directive" }, { id: e3.id, kind: "comment" }, { id: e4.id, kind: "agent_message" }
    ]);
    assert.deepEqual(await s.getEvent(e3.id), e3);
    assert.equal(await s.getEvent(999999), null);
  });

  t("one room's events are never listed in another", async (s) => {
    const a = await room(s);
    const b = await s.createSession({ title: "B", task: "x" });
    await s.insertEvent({ session_id: a.id, kind: "comment", author: "Alice", content: "only in A" });
    assert.deepEqual(await s.listEvents(b.id), []);
  });

  t("rules on events: a known kind, a room that exists, a reply to an event that exists, a length limit on directives and comments", async (s) => {
    const { id } = await room(s);
    const ev = (extra) => s.insertEvent({ session_id: id, kind: "comment", author: "Alice", content: "x", ...extra });
    await rejectsWith(ev({ kind: "shout" }), "CONSTRAINT");
    await rejectsWith(ev({ session_id: "00000000-0000-0000-0000-000000000000" }), "CONSTRAINT");
    await rejectsWith(ev({ reply_to: 424242 }), "CONSTRAINT");
    await rejectsWith(ev({ content: "x".repeat(4001) }), "CONSTRAINT");
    await rejectsWith(ev({ kind: "directive", content: "x".repeat(4001) }), "CONSTRAINT");
    assert.ok(await ev({ content: "x".repeat(4000) }));
    assert.ok(await ev({ kind: "agent_message", content: "y".repeat(9000) }), "a reply is not length-limited");
    assert.equal((await s.listEvents(id)).length, 2);
  });

  t("text is counted in characters, not bytes: 4000 emoji fit, 4001 do not", async (s) => {
    const { id } = await room(s);
    const ev = (n) => s.insertEvent({ session_id: id, kind: "comment", author: "Alice", content: "😀".repeat(n) });
    assert.ok(await ev(4000));
    await rejectsWith(ev(4001), "CONSTRAINT");
  });

  t("every new event moves the room's updated_at forward", async (s) => {
    const { id, updated_at: before } = await room(s);
    await sleep(8);
    await s.insertEvent({ session_id: id, kind: "comment", author: "Alice", content: "x" });
    const after1 = (await s.getSession(id)).updated_at;
    assert.ok(after1 > before, `${after1} should be after ${before}`);
    await sleep(8);
    await s.insertEvent({ session_id: id, kind: "comment", author: "Alice", content: "y" });
    assert.ok((await s.getSession(id)).updated_at > after1);
  });

  t("event ids are never handed out twice, even after the newest event is gone with its room", async (s) => {
    const a = await room(s);
    const e = await s.insertEvent({ session_id: a.id, kind: "comment", author: "Alice", content: "x" });
    await s.deleteSession(a.id);
    const b = await room(s);
    const e2 = await s.insertEvent({ session_id: b.id, kind: "comment", author: "Alice", content: "x" });
    assert.ok(e2.id > e.id);
  });

  // ── deleting a room ────────────────────────────────────────────────
  t("deleting a room deletes its events and people, and leaves other rooms alone", async (s) => {
    const a = await room(s);
    const b = await room(s);
    await s.insertEvent({ session_id: a.id, kind: "comment", author: "Alice", content: "in A" });
    await s.insertEvent({ session_id: b.id, kind: "comment", author: "Alice", content: "in B" });
    await s.deleteSession(a.id);
    assert.equal(await s.getSession(a.id), null);
    assert.deepEqual(await s.listEvents(a.id), []);
    assert.deepEqual(await s.listParticipants(a.id), []);
    assert.equal((await s.listEvents(b.id)).length, 1);
    assert.equal((await s.listParticipants(b.id)).length, 1);
    await s.deleteSession(a.id); // already gone: nothing happens
  });

  // ── participants ───────────────────────────────────────────────────
  t("listParticipants returns the public columns and never a token hash unless it is asked for", async (s) => {
    const { id } = await room(s);
    const [pub] = await s.listParticipants(id);
    assert.deepEqual(Object.keys(pub).sort(), ["last_seen", "name", "role", "session_id"]);
    assert.ok(!JSON.stringify(pub).includes(HASH_A));
    const [full] = await s.listParticipants(id, { columns: "name, token_hash, token_expires_at" });
    assert.equal(full.token_hash, HASH_A);
    await assert.rejects(s.listParticipants(id, { columns: "name; DROP TABLE sessions" }), StoreError);
    await assert.rejects(s.listParticipants(id, { columns: "name_key" }), StoreError, "the internal name key is not a column anyone can read");
  });

  t("a name is unique within a room regardless of case and compatibility forms, but free in another room", async (s) => {
    const a = await room(s);
    const ins = (session_id, name, extra = {}) => s.insertParticipant({ session_id, name, ...extra });
    await rejectsWith(ins(a.id, "alice"), "CONFLICT");
    await rejectsWith(ins(a.id, "ALICE"), "CONFLICT");
    await ins(a.id, "Ünal");
    await rejectsWith(ins(a.id, "ÜNAL"), "CONFLICT"); // beyond ASCII: SQLite's own lower() would miss this
    await ins(a.id, "Ａmy"); // fullwidth A
    await rejectsWith(ins(a.id, "Amy"), "CONFLICT");
    const b = await s.createSession({ title: "B", task: "x" });
    await ins(b.id, "Alice");
    assert.equal((await s.listParticipants(a.id)).length, 3);
  });

  t("rules on people: a name of 1 to 40 characters that is not agent or system, a known role, a room that exists", async (s) => {
    const { id } = await room(s);
    const ins = (extra) => s.insertParticipant({ session_id: id, name: "Zed", ...extra });
    await rejectsWith(ins({ name: "Agent" }), "CONSTRAINT");
    await rejectsWith(ins({ name: "system" }), "CONSTRAINT");
    await rejectsWith(ins({ name: "   " }), "CONSTRAINT");
    await rejectsWith(ins({ name: "x".repeat(41) }), "CONSTRAINT");
    await rejectsWith(ins({ role: "admin" }), "CONSTRAINT");
    await rejectsWith(ins({ session_id: "00000000-0000-0000-0000-000000000000" }), "CONSTRAINT");
    await ins({ name: "x".repeat(40) });
    assert.equal((await s.listParticipants(id)).length, 2, "Alice and the 40-character name; every refused one left nothing behind");
  });

  t("a token hash belongs to one person", async (s) => {
    const { id } = await room(s);
    await rejectsWith(s.insertParticipant({ session_id: id, name: "Bob", token_hash: HASH_A }), "CONFLICT");
    await s.insertParticipant({ session_id: id, name: "Bob", token_hash: HASH_B });
    await rejectsWith(s.updateParticipant(id, "Bob", { token_hash: HASH_A }), "CONFLICT");
    // people without a token (rooms from before tokens existed) are allowed, and may be many
    await s.insertParticipant({ session_id: id, name: "Legacy 1" });
    await s.insertParticipant({ session_id: id, name: "Legacy 2" });
  });

  t("updateParticipant changes the named person only, and a rename keeps names unique", async (s) => {
    const { id } = await room(s);
    await s.insertParticipant({ session_id: id, name: "Bob" });
    await s.updateParticipant(id, "Bob", { last_seen: "2026-01-01T00:00:00.000Z" });
    const rows = Object.fromEntries((await s.listParticipants(id)).map((p) => [p.name, p]));
    assert.equal(rows.Bob.last_seen, "2026-01-01T00:00:00.000Z");
    assert.notEqual(rows.Alice.last_seen, "2026-01-01T00:00:00.000Z");
    await rejectsWith(s.updateParticipant(id, "Bob", { name: "ALICE" }), "CONFLICT");
    await s.updateParticipant(id, "Bob", { name: "Robert" });
    await rejectsWith(s.insertParticipant({ session_id: id, name: "robert" }), "CONFLICT", "the renamed person holds the new name");
    await s.insertParticipant({ session_id: id, name: "Bob" }); // and the old name is free
    await s.updateParticipant(id, "Nobody", { role: "watcher" }); // no such person: nothing happens
    await assert.rejects(s.updateParticipant(id, "Robert", { color: "red" }), StoreError);
  });

  t("setController leaves exactly one controller, and an unknown name changes nobody", async (s) => {
    const { id } = await room(s);
    await s.insertParticipant({ session_id: id, name: "Bob" });
    await s.insertParticipant({ session_id: id, name: "Cy" });
    await s.setController(id, "Bob");
    const roles = async () => Object.fromEntries((await s.listParticipants(id)).map((p) => [p.name, p.role]));
    assert.deepEqual(await roles(), { Alice: "watcher", Bob: "controller", Cy: "watcher" });
    await rejectsWith(s.setController(id, "Nobody"), "NOT_FOUND");
    assert.deepEqual(await roles(), { Alice: "watcher", Bob: "controller", Cy: "watcher" }, "a failed handoff leaves the room as it was");
    const other = await s.createSession({ title: "B", task: "x" });
    await s.insertParticipant({ session_id: other.id, name: "Alice", role: "controller" });
    await s.setController(id, "Cy");
    assert.equal((await s.listParticipants(other.id))[0].role, "controller", "another room is untouched");
  });

  // ── tokens ─────────────────────────────────────────────────────────
  t("touchByToken updates last_seen only for a live token in that room", async (s) => {
    const { id } = await room(s);
    const other = await s.createSession({ title: "B", task: "x" });
    const call = (extra) =>
      s.touchByToken({ sessionId: id, tokenHash: HASH_A, lastSeen: "2026-02-02T00:00:00.000Z", now: new Date().toISOString(), ...extra });
    assert.equal(await call(), "Alice");
    assert.equal((await s.listParticipants(id))[0].last_seen, "2026-02-02T00:00:00.000Z");
    assert.equal(await call({ tokenHash: HASH_B }), null, "an unknown token");
    assert.equal(await call({ sessionId: other.id }), null, "a token from another room");
    assert.equal(await call({ now: new Date(Date.now() + 2 * 86_400_000).toISOString() }), null, "after it expired");
    await s.revokeToken(id, "Alice");
    assert.equal(await call(), null, "once revoked");
  });

  t("findByTokenHash returns who a token is, without the hash, and revokeToken marks it", async (s) => {
    const { id } = await room(s);
    const found = await s.findByTokenHash(HASH_A);
    assert.equal(found.name, "Alice");
    assert.equal(found.role, "controller");
    assert.equal(found.session_id, id);
    assert.equal(found.token_revoked_at, null);
    assert.ok(!("token_hash" in found));
    assert.equal(await s.findByTokenHash(HASH_B), null);
    await s.revokeToken(id, "Alice");
    assert.ok((await s.findByTokenHash(HASH_A)).token_revoked_at);
  });

  t("a legacy person with no token or an old expiry is never reachable by a token", async (s) => {
    const { id } = await room(s);
    await s.insertParticipant({ session_id: id, name: "Old", token_hash: HASH_B, token_expires_at: past() });
    assert.equal(await s.touchByToken({ sessionId: id, tokenHash: HASH_B, lastSeen: new Date().toISOString(), now: new Date().toISOString() }), null);
  });

  // ── daily step budget ──────────────────────────────────────────────
  t("claimStep gives out exactly `cap` steps a day, then refuses and takes nothing more", async (s) => {
    assert.deepEqual(await s.claimStep(2), { allowed: true, used: 1 });
    assert.deepEqual(await s.claimStep(2), { allowed: true, used: 2 });
    assert.deepEqual(await s.claimStep(2), { allowed: false, used: 2 });
    assert.deepEqual(await s.claimStep(2), { allowed: false, used: 2 });
    assert.deepEqual(await s.claimStep(3), { allowed: true, used: 3 }, "a raised cap lets more through today");
    assert.equal(await s.budgetStatus(), "ok");
  });

  t("the daily count starts again on the next UTC day", async () => {
    let clock = new Date("2026-10-08T23:59:59.000Z");
    const s = await make({ now: () => clock });
    assert.equal((await s.claimStep(1)).allowed, true);
    assert.equal((await s.claimStep(1)).allowed, false);
    clock = new Date("2026-10-09T00:00:01.000Z");
    assert.deepEqual(await s.claimStep(1), { allowed: true, used: 1 });
  });

  // ── change notifications ───────────────────────────────────────────
  t("a subscriber hears which room each write was in, and can stop listening", async (s) => {
    const heard = [];
    const off = s.subscribe(({ sessionId }) => heard.push(sessionId));
    const a = await s.createSession({ title: "A", task: "x" });
    await s.insertParticipant({ session_id: a.id, name: "Alice", role: "controller" });
    await s.insertEvent({ session_id: a.id, kind: "comment", author: "Alice", content: "x" });
    await s.updateSession(a.id, { agent_working: true });
    assert.equal(heard.length, 4);
    assert.ok(heard.every((id) => id === a.id));
    off();
    await s.insertEvent({ session_id: a.id, kind: "comment", author: "Alice", content: "y" });
    assert.equal(heard.length, 4);
  });

  t("rows handed back are copies: changing one does not change the store", async (s) => {
    const { id } = await room(s);
    const row = await s.getSession(id);
    row.title = "tampered";
    row.status = "done";
    assert.equal((await s.getSession(id)).title, "Trip");
    const [p] = await s.listParticipants(id);
    p.role = "watcher";
    assert.equal((await s.listParticipants(id))[0].role, "controller");
  });
}

// ── listing and deleting every room (export, delete all) ─────────────

for (const [name, make] of Object.entries(makers)) {
  const t = (title, fn) => test(`[${name}] ${title}`, async () => fn(await make()));

  t("listSessions returns every room, oldest first, in pages", async (s) => {
    const made = [];
    for (let i = 0; i < 5; i++) {
      made.push((await s.createSession({ title: `Room ${i}`, task: "x" })).id);
      await sleep(3);
    }
    assert.deepEqual((await s.listSessions()).map((r) => r.id), made);
    assert.deepEqual((await s.listSessions({ limit: 2 })).map((r) => r.id), made.slice(0, 2));
    assert.deepEqual((await s.listSessions({ limit: 2, offset: 4 })).map((r) => r.id), made.slice(4));
    assert.deepEqual(await s.listSessions({ offset: 99 }), []);
  });

  t("deleteAllSessions removes every room with its events and people, says how many, and the store keeps working", async (s) => {
    const a = await room(s);
    const b = await room(s);
    await s.insertEvent({ session_id: a.id, kind: "comment", author: "Alice", content: "in A" });
    await s.insertEvent({ session_id: b.id, kind: "comment", author: "Alice", content: "in B" });
    const heard = [];
    s.subscribe(({ sessionId }) => heard.push(sessionId));
    assert.equal(await s.deleteAllSessions(), 2);
    assert.deepEqual(await s.listSessions(), []);
    assert.deepEqual(await s.listEvents(a.id), []);
    assert.deepEqual(await s.listParticipants(b.id), []);
    assert.equal(await s.findByTokenHash(HASH_A), null, "no token works any more");
    assert.ok(heard.includes(null), "listeners are told that something changed everywhere");
    assert.equal(await s.deleteAllSessions(), 0);
    assert.ok(await s.createSession({ title: "Fresh", task: "x" }));
  });

  t("compact and removeBackups are safe to call on any store", async (s) => {
    await room(s);
    await s.compact();
    assert.equal(await s.removeBackups(), 0);
    assert.equal((await s.listSessions()).length, 1);
  });
}

// ── sharing: the invite version, the guest cap, the control policy, the host flag, removing a person ──

for (const [name, make] of Object.entries(makers)) {
  const t = (title, fn) => test(`[${name}] ${title}`, async () => fn(await make()));

  t("a new room starts at invite version 1, no guest cap of its own, and the 'ask' control policy", async (s) => {
    const r = await s.createSession({ title: "T", task: "x" });
    assert.equal(r.invite_version, 1);
    assert.equal(r.guest_step_cap, null);
    assert.equal(r.control_policy, "ask");
  });

  t("the invite version, guest cap and control policy can be changed, and only to allowed values", async (s) => {
    const { id } = await s.createSession({ title: "T", task: "x" });
    await s.updateSession(id, { invite_version: 2, guest_step_cap: 5, control_policy: "locked" });
    let row = await s.getSession(id);
    assert.deepEqual([row.invite_version, row.guest_step_cap, row.control_policy], [2, 5, "locked"]);
    await s.updateSession(id, { guest_step_cap: null, control_policy: "free" });
    row = await s.getSession(id);
    assert.deepEqual([row.guest_step_cap, row.control_policy], [null, "free"]);
    await rejectsWith(s.updateSession(id, { control_policy: "anyone" }), "CONSTRAINT");
    await rejectsWith(s.updateSession(id, { invite_version: 0 }), "CONSTRAINT");
    await rejectsWith(s.updateSession(id, { guest_step_cap: -1 }), "CONSTRAINT");
    assert.equal((await s.getSession(id)).control_policy, "free", "a refused change changed nothing");
  });

  t("a person can be marked as the host, and the mark is a boolean that is there only when asked for", async (s) => {
    const { id } = await s.createSession({ title: "T", task: "x" });
    await s.insertParticipant({ session_id: id, name: "Maya", role: "controller", is_host: true });
    await s.insertParticipant({ session_id: id, name: "Dana" });
    const rows = Object.fromEntries((await s.listParticipants(id, { columns: "name, role, is_host" })).map((p) => [p.name, p]));
    assert.strictEqual(rows.Maya.is_host, true);
    assert.strictEqual(rows.Dana.is_host, false);
    assert.ok(!("is_host" in (await s.listParticipants(id))[0]), "the default public columns are unchanged");
  });

  t("looking someone up by token says whether they are the host", async (s) => {
    const { id } = await s.createSession({ title: "T", task: "x" });
    await s.insertParticipant({ session_id: id, name: "Maya", role: "controller", is_host: true, token_hash: HASH_A, token_expires_at: future() });
    await s.insertParticipant({ session_id: id, name: "Dana", token_hash: HASH_B, token_expires_at: future() });
    assert.strictEqual((await s.findByTokenHash(HASH_A)).is_host, true);
    assert.strictEqual((await s.findByTokenHash(HASH_B)).is_host, false);
  });

  t("removing a person frees their name and their token, and touches no one else", async (s) => {
    const { id } = await s.createSession({ title: "T", task: "x" });
    await s.insertParticipant({ session_id: id, name: "Maya", role: "controller", token_hash: HASH_A, token_expires_at: future() });
    await s.insertParticipant({ session_id: id, name: "Sam", token_hash: HASH_B, token_expires_at: future() });
    await s.deleteParticipant(id, "Sam");
    assert.deepEqual((await s.listParticipants(id)).map((p) => p.name), ["Maya"]);
    assert.equal(await s.findByTokenHash(HASH_B), null, "the token no longer works");
    assert.equal(await s.touchByToken({ sessionId: id, tokenHash: HASH_B, lastSeen: new Date().toISOString(), now: new Date().toISOString() }), null);
    await s.insertParticipant({ session_id: id, name: "sam" }); // the name, in any case, is free again
    await s.deleteParticipant(id, "Nobody"); // no such person: nothing happens
    assert.equal((await s.listParticipants(id)).length, 2);
  });

  t("removing a person tells subscribers which room changed", async (s) => {
    const { id } = await s.createSession({ title: "T", task: "x" });
    await s.insertParticipant({ session_id: id, name: "Sam" });
    const heard = [];
    s.subscribe(({ sessionId }) => heard.push(sessionId));
    await s.deleteParticipant(id, "Sam");
    assert.deepEqual(heard, [id]);
  });
}
