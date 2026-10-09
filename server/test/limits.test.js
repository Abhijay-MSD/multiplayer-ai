// Run: node --test test/   (no network, no real Supabase, no real model)
// Cost and abuse protection: per-IP room limits, per-person message limits, the
// daily step budget and its "at capacity" state, size limits, the HTTP layer
// and the startup environment check.
import test from "node:test";
import assert from "node:assert/strict";
import { makeFakeSupabase } from "./fakeSupabase.js";

process.env.SUPABASE_URL ||= "http://localhost:0";
process.env.SUPABASE_SERVICE_KEY ||= "test";
const { createSession } = await import("../tools/create_session.js");
const { joinSession } = await import("../tools/join_session.js");
const { sendDirective } = await import("../tools/send_directive.js");
const { sendComment } = await import("../tools/send_comment.js");
const { createLimiter, createLimits, ipKey, truncateChars } = await import("../limits.js");
const { claimStep, checkBudgetTable } = await import("../budget.js");
const { validateEnv } = await import("../env-check.js");
const { createApi } = await import("../api.js");

const rejects = (promise, code, status) =>
  assert.rejects(promise, (e) => {
    assert.equal(e.code, code, e.message);
    if (status) assert.equal(e.status, status);
    return true;
  });

// A clock the test moves by hand.
const clock = () => {
  let t = 1_000_000;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
};

const newDb = () => makeFakeSupabase({ sessions: [], session_events: [], session_participants: [] });
const budgetOf = (cap) => ({ claim: (db) => claimStep(db, { env: { DAILY_STEP_BUDGET: String(cap) } }) });
const events = (db) => db.tables.session_events.length;

// A room with Alice (controller) and Bob (watcher), all limits injected.
async function world({ env = {}, cap = 200 } = {}) {
  const now = clock();
  const limits = createLimits({ env, now });
  const db = newDb();
  const budget = budgetOf(cap);
  const d = { db, trigger: () => {}, limits, budget };
  const room = await createSession({ task: "Plan a trip", creator_name: "Alice" }, d);
  const bob = await joinSession({ session_id: room.session_id, name: "Bob" }, d);
  return { now, limits, db, budget, d, id: room.session_id, alice: room.token, bob: bob.token };
}

// ── The limiter ─────────────────────────────────────────────────────

test("a limiter allows `limit` hits per window, then says how long to wait", () => {
  const now = clock();
  const l = createLimiter({ limit: 3, windowMs: 60_000, now });
  for (let i = 0; i < 3; i++) assert.deepEqual(l.hit("k"), { ok: true });
  now.advance(20_000);
  const refused = l.hit("k");
  assert.equal(refused.ok, false);
  assert.equal(refused.retryAfter, 40, "the first hit leaves the window 40s from now");
  now.advance(39_999);
  assert.equal(l.hit("k").ok, false, "still inside the window");
  now.advance(1);
  assert.equal(l.hit("k").ok, true, "the oldest hit has aged out");
});

test("a refused attempt is not recorded, so waiting out the window is enough", () => {
  const now = clock();
  const l = createLimiter({ limit: 1, windowMs: 1000, now });
  l.hit("k");
  for (let i = 0; i < 50; i++) l.hit("k"); // hammering must not extend the wait
  now.advance(1000);
  assert.equal(l.hit("k").ok, true);
});

test("keys are independent, and memory is bounded", () => {
  const now = clock();
  const l = createLimiter({ limit: 1, windowMs: 1000, now, maxKeys: 100 });
  assert.equal(l.hit("a").ok, true);
  assert.equal(l.hit("b").ok, true);
  assert.equal(l.hit("a").ok, false);
  for (let i = 0; i < 1000; i++) l.hit(`flood-${i}`);
  assert.ok(l.size <= 100, `tracked ${l.size} keys`);
  now.advance(5000);
  l.prune();
  assert.equal(l.size, 0, "idle keys are forgotten");
});

test("an IPv6 caller is keyed by its /64, and IPv4-mapped addresses by their IPv4", () => {
  assert.equal(ipKey("203.0.113.9"), "203.0.113.9");
  assert.equal(ipKey("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), ipKey("2001:db8:1:2:1:2:3:4"));
  assert.notEqual(ipKey("2001:db8:1:3::1"), ipKey("2001:db8:1:2::1"));
  assert.equal(ipKey(undefined), null);
});

// ── Room creation per IP ────────────────────────────────────────────

test("the 6th room from one IP in an hour is refused with RATE_LIMITED and a wait; other IPs and MCP are not affected", async () => {
  const now = clock();
  const limits = createLimits({ now });
  const db = newDb();
  const d = (ip) => ({ db, trigger: () => {}, limits, budget: budgetOf(200), ip });
  for (let i = 0; i < 5; i++) await createSession({ task: `t${i}`, creator_name: "Ann" }, d("203.0.113.1"));
  const rooms = db.tables.sessions.length;

  await assert.rejects(createSession({ task: "one more", creator_name: "Ann" }, d("203.0.113.1")), (e) => {
    assert.equal(e.status, 429);
    assert.equal(e.code, "RATE_LIMITED");
    assert.equal(e.extra.retry_after, 3600);
    return true;
  });
  assert.equal(db.tables.sessions.length, rooms, "a refused room is not created");

  await createSession({ task: "other ip", creator_name: "Ann" }, d("203.0.113.2"));
  for (let i = 0; i < 10; i++) await createSession({ task: "mcp", creator_name: "Ann" }, d(undefined));

  now.advance(3600_000);
  await createSession({ task: "an hour later", creator_name: "Ann" }, d("203.0.113.1"));
});

test("CREATE_LIMIT_PER_HOUR comes from the environment", async () => {
  const limits = createLimits({ env: { CREATE_LIMIT_PER_HOUR: "2" }, now: clock() });
  const d = { db: newDb(), trigger: () => {}, limits, budget: budgetOf(200), ip: "198.51.100.1" };
  await createSession({ task: "a", creator_name: "Ann" }, d);
  await createSession({ task: "b", creator_name: "Ann" }, d);
  await rejects(createSession({ task: "c", creator_name: "Ann" }, d), "RATE_LIMITED", 429);
});

test("a request that is not well formed does not use up the IP's allowance", async () => {
  const limits = createLimits({ env: { CREATE_LIMIT_PER_HOUR: "1" }, now: clock() });
  const d = { db: newDb(), trigger: () => {}, limits, budget: budgetOf(200), ip: "198.51.100.1" };
  await rejects(createSession({ task: "  ", creator_name: "Ann" }, d), "BAD_REQUEST");
  await createSession({ task: "real", creator_name: "Ann" }, d);
});

// ── Joining per IP, and the room's size ─────────────────────────────

test("30 new joins per IP per hour; coming back with a valid token does not count", async () => {
  const w = await world();
  const ip = "192.0.2.50";
  const d = { ...w.d, ip };
  const first = await joinSession({ session_id: w.id, name: "P0" }, d);
  // 29 more new people, from other rooms so the room cap isn't what stops us
  for (let i = 1; i < 30; i++) {
    const other = await createSession({ task: "t", creator_name: `Host${i}` }, w.d);
    await joinSession({ session_id: other.session_id, name: `P${i}` }, d);
  }
  const otherRoom = await createSession({ task: "t", creator_name: "Zed" }, w.d);
  await rejects(joinSession({ session_id: otherRoom.session_id, name: "P30" }, d), "RATE_LIMITED", 429);

  // Returning with a token is free even while the IP is over its limit.
  const back = await joinSession({ session_id: w.id, name: "ignored", token: first.token }, d);
  assert.equal(back.you.name, "P0");
  assert.equal(back.token, undefined, "no new token on a return");
});

test("a room holds 25 people; the 26th is told it is full and nothing is written", async () => {
  const w = await world(); // Alice and Bob
  for (let i = 3; i <= 25; i++) await joinSession({ session_id: w.id, name: `P${i}` }, w.d);
  assert.equal(w.db.tables.session_participants.filter((p) => p.session_id === w.id).length, 25);
  const before = events(w.db);
  await assert.rejects(joinSession({ session_id: w.id, name: "Late" }, w.d), (e) => {
    assert.equal(e.code, "BAD_REQUEST");
    assert.match(e.message, /full.*25/);
    return true;
  });
  assert.equal(events(w.db), before);
  // Someone already in the room can still come back.
  const again = await joinSession({ session_id: w.id, name: "x", token: w.bob }, w.d);
  assert.equal(again.you.name, "Bob");
});

// ── Messages per person ─────────────────────────────────────────────

test("a 7th directive in a minute is refused with the wait, writes nothing, and spends no step", async () => {
  const w = await world();
  for (let i = 0; i < 6; i++) await sendDirective({ session_id: w.id, token: w.alice, content: `go ${i}` }, w.d);
  const before = events(w.db);
  const spent = w.db.tables.usage_daily[0].steps;
  await assert.rejects(sendDirective({ session_id: w.id, token: w.alice, content: "too fast" }, w.d), (e) => {
    assert.equal(e.status, 429);
    assert.equal(e.code, "RATE_LIMITED");
    assert.equal(e.extra.retry_after, 60);
    assert.match(e.message, /Wait 1 minute and send it again/);
    return true;
  });
  assert.equal(events(w.db), before, "nothing written");
  assert.equal(w.db.tables.usage_daily[0].steps, spent, "a message refused for speed costs no step");
  w.now.advance(60_000);
  await sendDirective({ session_id: w.id, token: w.alice, content: "ok now" }, w.d);
});

test("comments have their own bucket of 20, and one person's speed does not slow another", async () => {
  const w = await world();
  for (let i = 0; i < 20; i++) await sendComment({ session_id: w.id, token: w.bob, content: `c${i}` }, w.d);
  await rejects(sendComment({ session_id: w.id, token: w.bob, content: "c20" }, w.d), "RATE_LIMITED", 429);
  await sendComment({ session_id: w.id, token: w.alice, content: "Alice is unaffected" }, w.d);
  for (let i = 0; i < 6; i++) await sendDirective({ session_id: w.id, token: w.alice, content: `d${i}` }, w.d);
  // Bob's comment bucket is full but directives and comments are counted apart
  await rejects(sendDirective({ session_id: w.id, token: w.alice, content: "d6" }, w.d), "RATE_LIMITED");
  await sendComment({ session_id: w.id, token: w.alice, content: "comments still fine for Alice" }, w.d);
});

test("DIRECTIVE_LIMIT_PER_MIN and COMMENT_LIMIT_PER_MIN come from the environment", async () => {
  const w = await world({ env: { DIRECTIVE_LIMIT_PER_MIN: "1", COMMENT_LIMIT_PER_MIN: "2" } });
  await sendDirective({ session_id: w.id, token: w.alice, content: "one" }, w.d);
  await rejects(sendDirective({ session_id: w.id, token: w.alice, content: "two" }, w.d), "RATE_LIMITED");
  await sendComment({ session_id: w.id, token: w.bob, content: "1" }, w.d);
  await sendComment({ session_id: w.id, token: w.bob, content: "2" }, w.d);
  await rejects(sendComment({ session_id: w.id, token: w.bob, content: "3" }, w.d), "RATE_LIMITED");
});

test("limits are per room: the same name in another room has its own allowance", async () => {
  const w = await world({ env: { COMMENT_LIMIT_PER_MIN: "1" } });
  await sendComment({ session_id: w.id, token: w.alice, content: "a" }, w.d);
  await rejects(sendComment({ session_id: w.id, token: w.alice, content: "b" }, w.d), "RATE_LIMITED");
  const other = await createSession({ task: "x", creator_name: "Alice" }, w.d);
  await sendComment({ session_id: other.session_id, token: other.token, content: "fresh room" }, w.d);
});

// ── The daily step budget ───────────────────────────────────────────

test("when the daily budget is spent: AT_CAPACITY 503, no directive written, no room created", async () => {
  const w = await world({ cap: 4 }); // Alice's room took 0: createSession here has no auto_start
  for (let i = 0; i < 4; i++) await sendDirective({ session_id: w.id, token: w.alice, content: `d${i}` }, w.d);
  const before = events(w.db);
  const rooms = w.db.tables.sessions.length;

  await assert.rejects(sendDirective({ session_id: w.id, token: w.alice, content: "one too many" }, w.d), (e) => {
    assert.equal(e.status, 503);
    assert.equal(e.code, "AT_CAPACITY");
    assert.match(e.message, /Try again tomorrow/);
    return true;
  });
  assert.equal(events(w.db), before, "the directive was not written");

  await rejects(createSession({ task: "new", creator_name: "Zed", auto_start: true }, w.d), "AT_CAPACITY", 503);
  assert.equal(w.db.tables.sessions.length, rooms, "no empty room is left behind");
  assert.equal(w.db.tables.usage_daily[0].steps, 4, "a refused claim takes nothing");
});

test("at capacity, what costs nothing keeps working: reading, joining, comments, and a room started without auto_start", async () => {
  const w = await world({ cap: 1 });
  await sendDirective({ session_id: w.id, token: w.alice, content: "the only one" }, w.d);
  await rejects(sendDirective({ session_id: w.id, token: w.alice, content: "no" }, w.d), "AT_CAPACITY");
  await sendComment({ session_id: w.id, token: w.bob, content: "still chatting" }, w.d);
  const carol = await joinSession({ session_id: w.id, name: "Carol" }, w.d);
  assert.equal(carol.you.name, "Carol");
  const quiet = await createSession({ task: "mcp room", creator_name: "Zed" }, w.d);
  assert.equal(quiet.auto_start, false);
});

test("a room started with auto_start spends one step; without it, none", async () => {
  const w = await world({ cap: 10 });
  assert.equal(w.db.tables.usage_daily?.[0]?.steps ?? 0, 0);
  await createSession({ task: "x", creator_name: "Zed" }, w.d);
  assert.equal(w.db.tables.usage_daily?.[0]?.steps ?? 0, 0);
  await createSession({ task: "y", creator_name: "Zed", auto_start: true }, w.d);
  assert.equal(w.db.tables.usage_daily[0].steps, 1);
});

test("if the budget can't be read, nothing is let through (fails closed)", async () => {
  const w = await world();
  w.db.rpcError = "function claim_step does not exist";
  const before = events(w.db);
  const log = console.error;
  console.error = () => {};
  try {
    await assert.rejects(sendDirective({ session_id: w.id, token: w.alice, content: "hi" }, w.d), (e) => {
      assert.notEqual(e.code, "AT_CAPACITY");
      assert.match(e.message, /budget could not be checked/);
      return true;
    });
  } finally {
    console.error = log;
  }
  assert.equal(events(w.db), before);
});

test("the startup check only reads: it never calls claim_step", async () => {
  const db = newDb();
  db.tables.usage_daily = [];
  assert.equal(await checkBudgetTable(db), "ok");
  assert.deepEqual(db.rpcLog, [], "no stored function was called");

  const failing = (error) => ({
    rpcLog: [],
    rpc: async () => assert.fail("claim_step must not be called by a startup check"),
    from: () => ({ select: () => ({ limit: async () => ({ error }) }) })
  });
  assert.equal(await checkBudgetTable(failing({ code: "PGRST205", message: "Could not find the table 'public.usage_daily'" })), "missing");
  assert.equal(await checkBudgetTable(failing({ code: "42P01", message: 'relation "usage_daily" does not exist' })), "missing");
  assert.equal(await checkBudgetTable(failing({ code: "08006", message: "connection failure" })), "unknown");
});

// ── Size limits ─────────────────────────────────────────────────────

test("a 4000-character task is accepted, and the title is cut to 120 before insert", async () => {
  const db = newDb();
  const d = { db, trigger: () => {}, limits: createLimits({ now: clock() }), budget: budgetOf(200) };
  const task = "x".repeat(4000);
  const room = await createSession({ task, creator_name: "Ann" }, d);
  const row = db.tables.sessions.find((s) => s.id === room.session_id);
  assert.equal(row.task.length, 4000);
  assert.ok(row.title.length <= 120, `title is ${row.title.length}`);
  assert.equal(room.title, row.title);
  assert.equal(db.tables.session_events.find((e) => e.kind === "directive").content.length, 4000);
});

test("a long title the caller supplied is truncated, not refused, and never splits a character", async () => {
  const db = newDb();
  const d = { db, trigger: () => {}, limits: createLimits({ now: clock() }), budget: budgetOf(200) };
  const plain = await createSession({ task: "t", title: "T".repeat(4000), creator_name: "Ann" }, d);
  assert.equal(plain.title.length, 120);
  const emoji = await createSession({ task: "t", title: "🎼".repeat(500), creator_name: "Ann" }, d);
  assert.equal(Array.from(emoji.title).length, 120, "120 whole characters");
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji.title), "no half of a surrogate pair");
  assert.equal(truncateChars("héllo", 3), "hél");
});

test("a 4001-character task, directive or comment is refused with a plain message and writes nothing", async () => {
  const w = await world();
  const before = events(w.db);
  const rooms = w.db.tables.sessions.length;
  await assert.rejects(createSession({ task: "x".repeat(4001), creator_name: "Zed" }, w.d), (e) => {
    assert.equal(e.code, "BAD_REQUEST");
    assert.match(e.message, /4,001 characters.*4,000/);
    return true;
  });
  assert.equal(w.db.tables.sessions.length, rooms);
  await rejects(sendDirective({ session_id: w.id, token: w.alice, content: "x".repeat(4001) }, w.d), "BAD_REQUEST");
  await rejects(sendComment({ session_id: w.id, token: w.bob, content: "x".repeat(4001) }, w.d), "BAD_REQUEST");
  assert.equal(events(w.db), before);
  assert.equal(w.db.tables.usage_daily?.[0]?.steps ?? 0, 0, "a refused message costs no step");
  await sendDirective({ session_id: w.id, token: w.alice, content: "x".repeat(4000) }, w.d);
  await sendComment({ session_id: w.id, token: w.bob, content: "y".repeat(4000) }, w.d);
});

// ── The HTTP layer ──────────────────────────────────────────────────

async function serve({ env = {}, db = newDb(), limits = createLimits({ env }) } = {}) {
  const handlers = {
    create_session: (args, deps) => createSession(args, { ...deps, db, trigger: () => {}, limits, budget: budgetOf(200) }),
    send_comment: (args, deps) => sendComment(args, { ...deps, db, limits })
  };
  const app = createApi({ handlers, env });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}/api/tools`;
  const post = (name, body, headers = {}) =>
    fetch(`${url}/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body)
    });
  return { post, close: () => server.close() };
}

test("HTTP: the per-IP limit answers 429 with a Retry-After header and the retry_after field", async () => {
  const s = await serve({ env: { CREATE_LIMIT_PER_HOUR: "1" } });
  try {
    assert.equal((await s.post("create_session", { task: "a", creator_name: "Ann" })).status, 200);
    const res = await s.post("create_session", { task: "b", creator_name: "Ann" });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "3600");
    const body = await res.json();
    assert.equal(body.code, "RATE_LIMITED");
    assert.equal(body.retry_after, 3600);
  } finally {
    s.close();
  }
});

test("HTTP: TRUST_PROXY_HOPS=0 ignores X-Forwarded-For, so callers can't pick their own IP", async () => {
  const s = await serve({ env: { CREATE_LIMIT_PER_HOUR: "1", TRUST_PROXY_HOPS: "0" } });
  try {
    assert.equal((await s.post("create_session", { task: "a", creator_name: "A" }, { "X-Forwarded-For": "1.1.1.1" })).status, 200);
    // A different claimed IP does not get a fresh allowance. (Behind a real proxy this is the "one shared bucket" case.)
    assert.equal((await s.post("create_session", { task: "b", creator_name: "B" }, { "X-Forwarded-For": "2.2.2.2" })).status, 429);
  } finally {
    s.close();
  }
});

test("HTTP: with one trusted hop, the address the proxy added is used; one that is too high is spoofable", async () => {
  const one = await serve({ env: { CREATE_LIMIT_PER_HOUR: "1", TRUST_PROXY_HOPS: "1" } });
  try {
    assert.equal((await one.post("create_session", { task: "a", creator_name: "A" }, { "X-Forwarded-For": "9.9.9.9, 1.1.1.1" })).status, 200);
    // Same proxy-added address, different value the client made up in front: same caller.
    assert.equal((await one.post("create_session", { task: "b", creator_name: "B" }, { "X-Forwarded-For": "8.8.8.8, 1.1.1.1" })).status, 429);
    assert.equal((await one.post("create_session", { task: "c", creator_name: "C" }, { "X-Forwarded-For": "8.8.8.8, 2.2.2.2" })).status, 200);
  } finally {
    one.close();
  }
  const tooHigh = await serve({ env: { CREATE_LIMIT_PER_HOUR: "1", TRUST_PROXY_HOPS: "2" } });
  try {
    // Only one proxy really exists, so hop 2 is whatever the client wrote.
    assert.equal((await tooHigh.post("create_session", { task: "a", creator_name: "A" }, { "X-Forwarded-For": "5.5.5.5" })).status, 200);
    assert.equal((await tooHigh.post("create_session", { task: "b", creator_name: "B" }, { "X-Forwarded-For": "6.6.6.6" })).status, 200, "a new made-up address, a new allowance");
  } finally {
    tooHigh.close();
  }
});

test("HTTP: a body over MAX_BODY_KB gets a JSON error the browser may read; bad JSON gets one too", async () => {
  const s = await serve({ env: { MAX_BODY_KB: "1", PUBLIC_URL: "https://multiplayer-ai.example" } });
  try {
    const big = await s.post("create_session", { task: "x".repeat(5000), creator_name: "A" });
    assert.equal(big.status, 413);
    assert.equal(big.headers.get("access-control-allow-origin"), "https://multiplayer-ai.example");
    const body = await big.json();
    assert.equal(body.code, "BAD_REQUEST");
    assert.match(body.error, /too large/);

    const bad = await s.post("create_session", "{not json");
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "BAD_REQUEST");
  } finally {
    s.close();
  }
});

// ── The startup environment check ───────────────────────────────────

const goodEnv = {
  SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_SERVICE_KEY: "secret",
  GEMINI_API_KEY: "key",
  PORT: "3001",
  PUBLIC_URL: "http://localhost:5173",
  MAX_OUTPUT_TOKENS: "800"
};
const problems = (env) => validateEnv({ ...goodEnv, ...env }).errors;

test("env: a good environment passes, and blank values mean defaults", () => {
  assert.deepEqual(validateEnv(goodEnv), { errors: [], warnings: [] });
  const blanks = { MAX_STEPS_PER_SESSION: "", DAILY_STEP_BUDGET: "", TRUST_PROXY_HOPS: "", PROVIDER: "", GEMINI_THINKING_LEVEL: "" };
  assert.deepEqual(problems(blanks), []);
});

test("env: every problem is reported at once, naming the variable", () => {
  const errs = validateEnv({
    SUPABASE_URL: "not a url",
    PROVIDER: "gpt",
    MAX_STEPS_PER_SESSION: "abc",
    DAILY_STEP_BUDGET: "0",
    CREATE_LIMIT_PER_HOUR: "2.5",
    TRUST_PROXY_HOPS: "-1",
    PORT: "99999"
  }).errors;
  for (const name of ["SUPABASE_SERVICE_KEY", "SUPABASE_URL", "PROVIDER", "MAX_STEPS_PER_SESSION", "DAILY_STEP_BUDGET", "CREATE_LIMIT_PER_HOUR", "TRUST_PROXY_HOPS", "PORT"]) {
    assert.ok(errs.some((e) => e.includes(name)), `${name} should be reported:\n${errs.join("\n")}`);
  }
});

test("env: the chosen provider's key is required", () => {
  assert.ok(problems({ GEMINI_API_KEY: "" }).some((e) => e.includes("GEMINI_API_KEY")));
  assert.ok(problems({ PROVIDER: "groq", GEMINI_API_KEY: "" }).some((e) => e.includes("GROQ_API_KEY")));
  assert.deepEqual(problems({ PROVIDER: "groq", GEMINI_API_KEY: "", GROQ_API_KEY: "g" }), []);
});

test("env: PUBLIC_URL is an origin, because it is the exact CORS value", () => {
  for (const bad of ["http://localhost:5173/", "https://x.example/app", "localhost:5173", "ftp://x.example"]) {
    assert.ok(problems({ PUBLIC_URL: bad }).some((e) => e.includes("PUBLIC_URL")), bad);
  }
  assert.deepEqual(problems({ PUBLIC_URL: "https://multiplayer-ai.example" }), []);
  assert.ok(problems({ PUBLIC_URL: "", NODE_ENV: "production" }).some((e) => e.includes("PUBLIC_URL")));
  assert.deepEqual(problems({ PUBLIC_URL: "" }), [], "optional outside production");
});

test("env: size settings may be lowered but not raised past what the database enforces", () => {
  assert.deepEqual(problems({ MAX_MESSAGE_CHARS: "2000", MAX_TITLE_CHARS: "80" }), []);
  assert.ok(problems({ MAX_MESSAGE_CHARS: "5000" }).some((e) => e.includes("MAX_MESSAGE_CHARS")));
  assert.ok(problems({ MAX_TITLE_CHARS: "121" }).some((e) => e.includes("MAX_TITLE_CHARS")));
});

test("env: no cap on reply length is a warning, not an error", () => {
  const r = validateEnv({ ...goodEnv, MAX_OUTPUT_TOKENS: "" });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes("MAX_OUTPUT_TOKENS")));
});
