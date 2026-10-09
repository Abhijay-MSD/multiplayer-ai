// Run: node --test test/   (no network, no real Supabase)
// Live updates are delivered by the server, to authenticated participants only.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { makeFakeSupabase } from "./fakeSupabase.js";

// These tests are about steering and streaming, not pacing: lift the per-person message limits
// (limits.test.js covers them) before the tools are imported.
process.env.DIRECTIVE_LIMIT_PER_MIN ||= "10000";
process.env.COMMENT_LIMIT_PER_MIN ||= "10000";
process.env.SUPABASE_URL ||= "http://localhost:0";
process.env.SUPABASE_SERVICE_KEY ||= "test";
const { createSession } = await import("../tools/create_session.js");
const { joinSession } = await import("../tools/join_session.js");
const { sendComment } = await import("../tools/send_comment.js");
const { createHub, setHub, nudge } = await import("../hub.js");
const { streamRoute, pingInterval } = await import("../stream.js");
const { hashToken, revokeToken } = await import("../auth.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
};

async function world(hubOpts = {}) {
  const db = makeFakeSupabase({ sessions: [], session_events: [], session_participants: [] });
  const d = { db };
  const a = await createSession({ task: "Plan a trip", creator_name: "Alice" }, d);
  const b = await createSession({ task: "Other room", creator_name: "Zoe" }, d);
  const bob = await joinSession({ session_id: a.session_id, name: "Bob" }, d);
  const hub = createHub({ db, ...hubOpts });
  setHub(hub);
  return { db, d, hub, A: a.session_id, B: b.session_id, alice: a.token, zoe: b.token, bob: bob.token };
}

const latestEventId = (w) => Math.max(...w.db.tables.session_events.filter((e) => e.session_id === w.A).map((e) => e.id));

// A subscriber that records what the hub sends it.
function subscriber(token) {
  const got = [];
  const sub = { tokenHash: hashToken(token), send: (type, data) => got.push({ type, data }), end: () => (sub.ended = true) };
  return Object.assign(sub, {
    got,
    of: (type) => got.filter((m) => m.type === type).map((m) => m.data),
    types: () => got.map((m) => m.type)
  });
}

test("a new subscriber gets the room's state first, then only the events after the id it already has", async () => {
  const w = await world({ pollMs: 60_000 });
  const events = w.db.tables.session_events.filter((e) => e.session_id === w.A);
  const seen = events[0].id; // the client already has the first event
  const sub = subscriber(w.alice);
  await w.hub.open(w.A, sub, seen);

  assert.equal(sub.types()[0], "state");
  assert.equal(sub.of("state")[0].session.id, w.A);
  assert.deepEqual(sub.of("state")[0].participants.map((p) => p.name).sort(), ["Alice", "Bob"]);
  assert.deepEqual(sub.of("event").map((e) => e.id), events.slice(1).map((e) => e.id), "replayed in order, none repeated");
  w.hub.close(w.A, sub);
});

test("new events reach subscribers immediately after a nudge, without waiting for the timer", async () => {
  const w = await world({ pollMs: 60_000 });
  const sub = subscriber(w.alice);
  await w.hub.open(w.A, sub, latestEventId(w)); // already has everything so far
  const before = sub.of("event").length;

  await sendComment({ session_id: w.A, token: w.bob, content: "hello room" }, w.d); // tools nudge the hub
  await waitFor(() => sub.of("event").some((e) => e.content === "hello room"));
  assert.equal(sub.of("event").length, before + 1);
  w.hub.close(w.A, sub);
});

test("changes made by another process are caught by the timer", async () => {
  const w = await world({ pollMs: 30 });
  const sub = subscriber(w.alice);
  await w.hub.open(w.A, sub, latestEventId(w));
  // Written straight to the database, the way a separate MCP process would.
  w.db.tables.session_events.push({ id: 500, session_id: w.A, kind: "comment", author: "Bob", content: "from elsewhere", created_at: new Date().toISOString() });
  w.db.tables.sessions.find((s) => s.id === w.A).agent_working = true;
  await waitFor(() => sub.of("event").some((e) => e.id === 500) && sub.of("session").some((s) => s.agent_working === true));
  w.hub.close(w.A, sub);
});

test("a subscriber never sees an event twice, even when it connects while the room is changing", async () => {
  const w = await world({ pollMs: 5 });
  const first = subscriber(w.alice);
  await w.hub.open(w.A, first, latestEventId(w));
  const writer = (async () => {
    for (let i = 0; i < 30; i++) {
      await sendComment({ session_id: w.A, token: w.bob, content: `c${i}` }, w.d);
      await sleep(1);
    }
  })();
  const late = subscriber(w.bob);
  await sleep(10);
  await w.hub.open(w.A, late, 0); // asks for everything, mid-stream
  await writer;
  await waitFor(() => late.of("event").some((e) => e.content === "c29"));
  for (const sub of [first, late]) {
    const ids = sub.of("event").map((e) => e.id);
    assert.deepEqual(ids, [...new Set(ids)], "no duplicates");
    assert.deepEqual(ids, [...ids].sort((x, y) => x - y), "in order");
  }
  w.hub.close(w.A, first);
  w.hub.close(w.A, late);
});

test("nothing sent to a subscriber carries token fields", async () => {
  const w = await world({ pollMs: 20 });
  const sub = subscriber(w.alice);
  await w.hub.open(w.A, sub, 0);
  await joinSession({ session_id: w.A, name: "Cy" }, w.d);
  nudge(w.A);
  await waitFor(() => sub.of("participant").some((p) => p.name === "Cy"));
  const everything = JSON.stringify(sub.got);
  assert.ok(!/token_(hash|expires_at|revoked_at)|mpai_/.test(everything));
  w.hub.close(w.A, sub);
});

test("a subscriber whose token is revoked is told and cut off at the next read", async () => {
  const w = await world({ pollMs: 60_000 });
  const sub = subscriber(w.bob);
  const other = subscriber(w.alice);
  await w.hub.open(w.A, sub, 0);
  await w.hub.open(w.A, other, 0);

  await revokeToken(w.db, { session_id: w.A, name: "Bob" });
  nudge(w.A);
  await waitFor(() => sub.ended);
  assert.ok(sub.types().includes("revoked"));
  assert.ok(!other.ended, "others stay connected");
  assert.equal(w.hub.stats().subscribers, 1);
  w.hub.close(w.A, other);
  assert.equal(w.hub.stats().rooms, 0, "an empty room stops polling");
});

// ── The HTTP endpoint ───────────────────────────────────────────────

async function serve(t, w, pingMs = 20) {
  const app = express();
  app.get("/api/stream/:session_id", streamRoute({ db: w.db, hub: w.hub, pingMs }));
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  return { base };
}

// Reads a stream until `until(text)` is true or the time is up.
async function readStream(res, until, ms = 2000) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  const end = Date.now() + ms;
  while (Date.now() < end && !until(text)) {
    const { value, done } = await Promise.race([reader.read(), sleep(100).then(() => ({ value: null, done: false }))]);
    if (done) break;
    if (value) text += dec.decode(value);
  }
  await reader.cancel().catch(() => {});
  return text;
}

test("the stream refuses anyone without a valid token for that room, and never reads a token from the URL", async (t) => {
  const w = await world({ pollMs: 60_000 });
  const srv = await serve(t, w);
  const status = async (path, headers = {}) => {
    const res = await fetch(srv.base + path, { headers });
    const body = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
    await res.body?.cancel().catch(() => {});
    return { status: res.status, code: body?.code, type: res.headers.get("content-type") };
  };

  assert.deepEqual(await status(`/api/stream/${w.A}`), { status: 401, code: "INVALID_TOKEN", type: "application/json; charset=utf-8" });
  assert.equal((await status(`/api/stream/${w.A}`, { Authorization: "Bearer mpai_nonsense" })).status, 401);
  assert.equal((await status(`/api/stream/${w.A}`, { Authorization: w.alice })).status, 401, "must be a Bearer header");
  // A token in the query string is ignored: it does not authenticate.
  assert.equal((await status(`/api/stream/${w.A}?token=${w.alice}`)).status, 401);
  // A token for another room.
  assert.deepEqual(
    (({ status, code }) => ({ status, code }))(await status(`/api/stream/${w.B}`, { Authorization: `Bearer ${w.alice}` })),
    { status: 403, code: "FORBIDDEN" }
  );
  assert.equal((await status(`/api/stream/not-a-uuid`, { Authorization: `Bearer ${w.alice}` })).status, 404);
  assert.equal(w.hub.stats().subscribers, 0, "none of that opened a stream");
});

test("a valid token opens an event stream: state, backfill from ?after=, and keep-alive pings", async (t) => {
  const w = await world({ pollMs: 60_000 });
  const srv = await serve(t, w, 20);
  const ids = w.db.tables.session_events.filter((e) => e.session_id === w.A).map((e) => e.id);

  const res = await fetch(`${srv.base}/api/stream/${w.A}?after=${ids[0]}`, { headers: { Authorization: `Bearer ${w.bob}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/event-stream/);
  const text = await readStream(res, (t) => (t.match(/: ping/g) ?? []).length >= 2 && t.includes("event: state"));

  assert.match(text, /^retry: 3000/);
  assert.ok(text.indexOf("event: state") > -1);
  assert.ok((text.match(/: ping/g) ?? []).length >= 2, "pings keep the connection alive");
  const sent = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  assert.deepEqual(sent, ids.slice(1), "events after the given id, each with its id for resuming");
  assert.ok(!text.includes(w.bob) && !/token_/.test(text));
});

test("a stream is cut off when its token is revoked while open", async (t) => {
  const w = await world({ pollMs: 40 });
  const srv = await serve(t, w, 60_000);
  const res = await fetch(`${srv.base}/api/stream/${w.A}`, { headers: { Authorization: `Bearer ${w.bob}` } });
  const pending = readStream(res, (t) => t.includes("event: revoked"), 3000);
  await sleep(60);
  await revokeToken(w.db, { session_id: w.A, name: "Bob" });
  const text = await pending;
  assert.match(text, /event: revoked/);
});

test("the keep-alive interval stays between 15 and 25 seconds", () => {
  assert.equal(pingInterval(undefined), 20_000);
  assert.equal(pingInterval("1000"), 15_000);
  assert.equal(pingInterval("60000"), 25_000);
  assert.equal(pingInterval("18000"), 18_000);
  assert.equal(pingInterval("junk"), 20_000);
});
