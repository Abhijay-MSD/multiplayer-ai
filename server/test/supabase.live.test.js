// Run: MULTIPLAYER_AI_LIVE_SUPABASE=1 node --test test/supabase.live.test.js
//
// Checks the Supabase store against a REAL project. It is skipped unless
// MULTIPLAYER_AI_LIVE_SUPABASE=1, and it needs SUPABASE_URL and SUPABASE_SERVICE_KEY
// (from the environment, or from server/.env), migrations 0001 to 0004 applied, and
// the library installed: cd server/supabase-lib && npm ci
//
// What it writes: a few rooms with a "live-check" title, deleted again at the end
// (their events and people go with them). What it never does: call claim_step,
// which would spend a step from the real daily budget. The budget table is only read.
// It prints no key and no token.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { StoreError } from "../store/errors.js";

const live = process.env.MULTIPLAYER_AI_LIVE_SUPABASE === "1";
const skip = live ? false : "set MULTIPLAYER_AI_LIVE_SUPABASE=1 to run this against a real Supabase project";

const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "../.env");
if (live && fs.existsSync(envFile)) dotenv.config({ path: envFile, override: false });

const created = [];
let store = null;
const room = async (title = "live-check") => {
  const s = await store.createSession({ title: `live-check ${title}`, task: "A check run by test/supabase.live.test.js" });
  created.push(s.id);
  return s;
};
const stamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const hash = () => (stamp() + "0".repeat(64)).slice(0, 64);
const future = () => new Date(Date.now() + 86_400_000).toISOString();
const rejectsWith = (p, code) => assert.rejects(p, (e) => e instanceof StoreError && e.code === code, `expected a ${code} StoreError`);

if (live) {
  const { createSupabaseStoreFromEnv } = await import("../store/supabase.js");
  store = await createSupabaseStoreFromEnv(process.env);
}

after(async () => {
  if (!store) return;
  for (const id of created) await store.deleteSession(id).catch((e) => console.error(`could not delete the check room ${id}: ${e.message}`));
});

test("the daily budget table exists (migration 0004), checked by reading only", { skip }, async () => {
  assert.equal(await store.budgetStatus(), "ok");
});

test("a session is created active, can be read, and changes as asked; a status that is not allowed is refused", { skip }, async () => {
  const s = await room("session");
  assert.equal(s.status, "active");
  assert.equal(s.step_count, 0);
  assert.strictEqual(s.agent_working, false);
  assert.deepEqual((await store.getSession(s.id)).id, s.id);
  assert.equal(await store.getSession("00000000-0000-0000-0000-000000000000"), null);
  await store.updateSession(s.id, { step_count: 2, agent_working: true, summary: "x", summarized_through_event_id: null });
  const row = await store.getSession(s.id);
  assert.equal(row.step_count, 2);
  assert.strictEqual(row.agent_working, true);
  await assert.rejects(store.updateSession(s.id, { status: "finished" }));
});

test("events keep their order, filter, window and limit; replies point at their directive", { skip }, async () => {
  const s = await room("events");
  const add = (kind, content, extra = {}) => store.insertEvent({ session_id: s.id, kind, author: "Alice", content, ...extra });
  const e1 = await add("join", "joined");
  const e2 = await add("directive", "hello");
  const e3 = await add("comment", "chat");
  const e4 = await add("agent_message", "hi", { reply_to: e2.id });
  assert.equal(e4.reply_to, e2.id);
  assert.deepEqual((await store.listEvents(s.id)).map((e) => e.id), [e1.id, e2.id, e3.id, e4.id]);
  assert.deepEqual((await store.listEvents(s.id, { kinds: ["directive", "agent_message"] })).map((e) => e.id), [e2.id, e4.id]);
  assert.deepEqual((await store.listEvents(s.id, { afterId: e1.id, uptoId: e3.id })).map((e) => e.id), [e2.id, e3.id]);
  assert.deepEqual((await store.listEvents(s.id, { order: "desc", limit: 2 })).map((e) => e.id), [e4.id, e3.id]);
  assert.deepEqual(Object.keys((await store.listEvents(s.id, { columns: "id, kind" }))[0]).sort(), ["id", "kind"]);
  assert.equal((await store.getEvent(e3.id)).content, "chat");
  const before = (await store.getSession(s.id)).updated_at;
  await new Promise((r) => setTimeout(r, 30));
  await add("comment", "later");
  assert.ok(new Date((await store.getSession(s.id)).updated_at) > new Date(before), "the trigger moved updated_at");
});

test("the database refuses an unknown event kind, a reply to nothing, and text over the length limit", { skip }, async () => {
  const s = await room("rules");
  const ev = (extra) => store.insertEvent({ session_id: s.id, kind: "comment", author: "Alice", content: "x", ...extra });
  await rejectsWith(ev({ kind: "shout" }), "CONSTRAINT");
  await rejectsWith(ev({ reply_to: 987654321 }), "CONSTRAINT");
  await rejectsWith(ev({ content: "x".repeat(4001) }), "CONSTRAINT");
  await ev({ content: "x".repeat(4000) });
});

test("names are unique per room regardless of letter case, a token hash belongs to one person, and the public listing has no hash", { skip }, async () => {
  const s = await room("people");
  const aliceHash = hash();
  await store.insertParticipant({ session_id: s.id, name: "Alice", role: "controller", token_hash: aliceHash, token_expires_at: future() });
  await rejectsWith(store.insertParticipant({ session_id: s.id, name: "alice" }), "CONFLICT");
  await rejectsWith(store.insertParticipant({ session_id: s.id, name: "Bob", token_hash: aliceHash }), "CONFLICT");
  await rejectsWith(store.insertParticipant({ session_id: s.id, name: "Agent" }), "CONSTRAINT");
  const [pub] = await store.listParticipants(s.id);
  assert.deepEqual(Object.keys(pub).sort(), ["last_seen", "name", "role", "session_id"]);
  const other = await room("people 2");
  await store.insertParticipant({ session_id: other.id, name: "Alice" });
});

test("tokens: found, touched only while live and in their room, and dead once revoked", { skip }, async () => {
  const s = await room("tokens");
  const elsewhere = await room("tokens elsewhere");
  const h = hash();
  await store.insertParticipant({ session_id: s.id, name: "Alice", role: "controller", token_hash: h, token_expires_at: future() });
  const found = await store.findByTokenHash(h);
  assert.equal(found.name, "Alice");
  assert.ok(!("token_hash" in found));
  const touch = (extra) => store.touchByToken({ sessionId: s.id, tokenHash: h, lastSeen: new Date().toISOString(), now: new Date().toISOString(), ...extra });
  assert.equal(await touch(), "Alice");
  assert.equal(await touch({ sessionId: elsewhere.id }), null);
  assert.equal(await touch({ now: new Date(Date.now() + 2 * 86_400_000).toISOString() }), null);
  await store.revokeToken(s.id, "Alice");
  assert.equal(await touch(), null);
});

test("control is handed over, leaving one controller", { skip }, async () => {
  const s = await room("control");
  await store.insertParticipant({ session_id: s.id, name: "Alice", role: "controller" });
  await store.insertParticipant({ session_id: s.id, name: "Bob" });
  await store.setController(s.id, "Bob");
  const roles = Object.fromEntries((await store.listParticipants(s.id)).map((p) => [p.name, p.role]));
  assert.deepEqual(roles, { Alice: "watcher", Bob: "controller" });
});

test("deleting a room deletes its events and people", { skip }, async () => {
  const s = await room("delete");
  await store.insertParticipant({ session_id: s.id, name: "Alice" });
  await store.insertEvent({ session_id: s.id, kind: "comment", author: "Alice", content: "x" });
  await store.deleteSession(s.id);
  assert.equal(await store.getSession(s.id), null);
  assert.deepEqual(await store.listEvents(s.id), []);
  assert.deepEqual(await store.listParticipants(s.id), []);
});
