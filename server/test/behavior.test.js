// Run: node --test test/   (no network, no real model)
// The tools, end to end, on the stores that need no outside service: memory and a
// SQLite file. The same scenarios the Supabase-stand-in suites cover (identity,
// rooms, steering, budget), asked of the storage the app ships with.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { makers, cleanup, ageRoom } from "./helpers/stores.js";
import { createLimits } from "../limits.js";
import { claimStep, dailyCap } from "../budget.js";
import { hashToken } from "../auth.js";
import { createHub } from "../hub.js";
import { maybeUpdateSummary, SUMMARY_MIN_EVENTS } from "../summary.js";
import { createSettings, setSettings } from "../settings.js";
import { makeFakeSupabase } from "./fakeSupabase.js";

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

after(cleanup);

const DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
};
const rejects = (promise, code) => assert.rejects(promise, (e) => e.code === code, `expected ${code}`);

/** The whole stored content of a store as text, to search for things that must not be in it. */
function dump(store) {
  if (store.kind === "memory") return JSON.stringify([...store._tables.sessions.values(), store._tables.events, store._tables.participants]);
  const all = (t) => store._db.prepare(`SELECT * FROM ${t}`).all();
  return JSON.stringify([all("sessions"), all("session_events"), all("session_participants"), all("usage_daily")]);
}

for (const kind of ["memory", "sqlite"]) {
  const world = async () => {
    const store = await makers[kind]();
    const calls = [];
    const d = { db: store, trigger: (...args) => calls.push(args), limits: createLimits({ env: {}, local: true }), budget: { claim: () => ({}) } };
    const room = await createSession({ task: "Plan a trip", creator_name: "Alice" }, d);
    const bob = await joinSession({ session_id: room.session_id, name: "Bob" }, d);
    return { store, d, calls, id: room.session_id, alice: room.token, bob: bob.token };
  };
  const t = (title, fn) => test(`[${kind}] ${title}`, async () => fn(await world()));

  // ── identity ────────────────────────────────────────────────────────
  t("creating and joining give each person a token, and only its hash is stored", async (w) => {
    assert.ok(w.alice.startsWith("mpai_") && w.bob.startsWith("mpai_") && w.alice !== w.bob);
    const text = dump(w.store);
    assert.ok(!text.includes(w.alice) && !text.includes(w.bob), "no plaintext token in storage");
    assert.ok(text.includes(hashToken(w.alice)));
    const got = await getSession({ session_id: w.id, token: w.alice }, w.d);
    assert.deepEqual(got.participants.map((p) => [p.name, p.role]).sort(), [["Alice", "controller"], ["Bob", "watcher"]]);
    assert.ok(!JSON.stringify(got).includes(hashToken(w.alice)), "a client never sees a token hash");
    assert.ok(got.events.some((e) => e.kind === "directive" && e.content === "Plan a trip"));
  });

  t("a name already in the room is refused with a suggestion, case and all", async (w) => {
    const err = await joinSession({ session_id: w.id, name: "bOb" }, w.d).catch((e) => e);
    assert.equal(err.status, 409);
    assert.equal(err.code, "NAME_TAKEN");
    assert.equal(err.extra.suggestion, "bOb 2");
  });

  t("coming back with a token is the same person, and a token from another room is refused", async (w) => {
    const again = await joinSession({ session_id: w.id, name: "ignored", token: w.bob }, w.d);
    assert.equal(again.you.name, "Bob");
    assert.equal(again.token, undefined, "no second token is issued");
    const other = await createSession({ task: "Elsewhere", creator_name: "Zoe" }, w.d);
    await rejects(getSession({ session_id: other.session_id, token: w.alice }, w.d), "FORBIDDEN");
    await rejects(getSession({ session_id: w.id, token: "mpai_nonsense" }, w.d), "INVALID_TOKEN");
  });

  t("an away person whose token has expired can have their name claimed; a person who is here cannot", async (w) => {
    await w.store.updateParticipant(w.id, "Bob", { last_seen: new Date(Date.now() - 5 * 60_000).toISOString(), token_expires_at: new Date(Date.now() - 1000).toISOString() });
    const claimant = await joinSession({ session_id: w.id, name: "bob" }, w.d);
    assert.equal(claimant.you.name, "bob");
    assert.equal(claimant.you.role, "watcher");
    await rejects(joinSession({ session_id: w.id, name: "ALICE" }, w.d), "NAME_TAKEN");
  });

  t("a revoked token stops working at once", async (w) => {
    const { revokeToken } = await import("../auth.js");
    await sendComment({ session_id: w.id, token: w.bob, content: "hi" }, w.d);
    await revokeToken(w.store, { session_id: w.id, name: "Bob" });
    await rejects(sendComment({ session_id: w.id, token: w.bob, content: "hi again" }, w.d), "INVALID_TOKEN");
  });

  t("heartbeat refreshes last_seen, leaving marks a person away, and a wrong token changes nothing", async (w) => {
    const seen = async () => (await w.store.listParticipants(w.id)).find((p) => p.name === "Bob").last_seen;
    await leaveSession({ session_id: w.id, token: w.bob }, w.d);
    assert.ok(Date.now() - new Date(await seen()).getTime() > 60_000, "now counted as away");
    await heartbeat({ session_id: w.id, token: w.bob }, w.d);
    assert.ok(Date.now() - new Date(await seen()).getTime() < 5000, "back");
    await rejects(heartbeat({ session_id: w.id, token: w.alice + "x" }, w.d), "INVALID_TOKEN");
  });

  // ── steering ────────────────────────────────────────────────────────
  t("only the controller steers: a watcher is refused, the controller's directive is stored and queued", async (w) => {
    await rejects(sendDirective({ session_id: w.id, token: w.bob, content: "obey me" }, w.d), "NOT_CONTROLLER");
    assert.equal((await w.store.listEvents(w.id)).filter((e) => e.content === "obey me").length, 0);
    const { event } = await sendDirective({ session_id: w.id, token: w.alice, content: "go" }, w.d);
    assert.equal(event.kind, "directive");
    assert.equal(event.author, "Alice");
    assert.deepEqual(w.calls.at(-1), [w.id, event.id]);
    await sendComment({ session_id: w.id, token: w.bob, content: "just chat" }, w.d);
    assert.equal(w.calls.length, 1, "a comment queues nothing");
  });

  t("control moves only by the rules: held and here, handoff, away, and exactly one controller after each", async (w) => {
    const roles = async () => Object.fromEntries((await w.store.listParticipants(w.id)).map((p) => [p.name, p.role]));
    await rejects(takeControl({ session_id: w.id, token: w.bob }, w.d), "CONTROL_HELD");
    await rejects(takeControl({ session_id: w.id, token: w.bob, target: "Alice" }, w.d), "NOT_CONTROLLER");
    await takeControl({ session_id: w.id, token: w.alice, target: "Bob" }, w.d);
    assert.deepEqual(await roles(), { Alice: "watcher", Bob: "controller" });
    await rejects(sendDirective({ session_id: w.id, token: w.alice, content: "still me?" }, w.d), "NOT_CONTROLLER");
    await w.store.updateParticipant(w.id, "Bob", { last_seen: new Date(Date.now() - 5 * 60_000).toISOString() });
    await takeControl({ session_id: w.id, token: w.alice }, w.d); // the controller is away
    assert.deepEqual(await roles(), { Alice: "controller", Bob: "watcher" });
    assert.equal((await w.store.listEvents(w.id)).filter((e) => e.kind === "takeover").length, 2);
  });

  // ── room states ─────────────────────────────────────────────────────
  t("an ended room can be read but not written to, and the controller can reopen it", async (w) => {
    await setStatus({ session_id: w.id, token: w.alice, status: "done" }, w.d);
    await rejects(sendComment({ session_id: w.id, token: w.bob, content: "late" }, w.d), "ROOM_ENDED");
    assert.ok(await getSession({ session_id: w.id, token: w.bob }, w.d), "still readable");
    await setStatus({ session_id: w.id, token: w.alice, status: "active" }, w.d);
    await sendComment({ session_id: w.id, token: w.bob, content: "back" }, w.d);
  });

  t("a room quiet for 7 days is archived for good: nobody new joins, nothing is written, people inside still read", async (w) => {
    ageRoom(w.store, w.id, 8 * DAY);
    await rejects(joinSession({ session_id: w.id, name: "Newcomer" }, w.d), "ROOM_ARCHIVED");
    await rejects(sendComment({ session_id: w.id, token: w.bob, content: "x" }, w.d), "ROOM_ARCHIVED");
    await rejects(setStatus({ session_id: w.id, token: w.alice, status: "active" }, w.d), "ROOM_ARCHIVED");
    const back = await joinSession({ session_id: w.id, name: "x", token: w.bob }, w.d);
    assert.equal(back.room.state, "archived");
    assert.equal(back.you.name, "Bob");
  });

  // ── budget ──────────────────────────────────────────────────────────
  t("the daily budget is off on a local store unless DAILY_STEP_BUDGET is set", async (w) => {
    assert.equal(dailyCap(w.store, {}), null);
    assert.deepEqual(await claimStep(w.store, { env: {} }), { used: null, cap: null });
    for (let i = 0; i < 300; i++) await claimStep(w.store, { env: {} });
    assert.equal((await w.store.claimStep(1000)).used, 1, "off means nothing was counted");
  });

  t("with DAILY_STEP_BUDGET set, a message that would pass the cap is refused and costs no step", async (w) => {
    w.d.budget = { claim: (db) => claimStep(db, { env: { DAILY_STEP_BUDGET: "2" } }) };
    await sendDirective({ session_id: w.id, token: w.alice, content: "one" }, w.d);
    await sendDirective({ session_id: w.id, token: w.alice, content: "two" }, w.d);
    const before = (await w.store.listEvents(w.id)).length;
    await rejects(sendDirective({ session_id: w.id, token: w.alice, content: "three" }, w.d), "AT_CAPACITY");
    assert.equal((await w.store.listEvents(w.id)).length, before);
    await sendComment({ session_id: w.id, token: w.bob, content: "chat still works" }, w.d);
  });

  t("if the budget can't be read, nothing is let through (fails closed)", async (w) => {
    const log = console.error;
    console.error = () => {};
    try {
      w.store.claimStep = async () => { throw new Error("disk is full"); };
      await assert.rejects(claimStep(w.store, { env: { DAILY_STEP_BUDGET: "5" } }), /budget could not be checked/);
    } finally {
      console.error = log;
    }
  });

  // ── the agent's step, through the real queue ─────────────────────────
  t("a reply is stored against the directive it answers, the step count rises, and the working flag drops", async (w) => {
    const prompts = [];
    setStepDeps({ db: w.store, call: async ({ messages }) => (prompts.push(messages), { text: "Here is a plan.", model: "fake" }) });
    const real = { ...w.d, trigger: undefined, keyCheck: () => true };
    delete real.trigger;
    const room = await createSession({ task: "Plan a trip to Lisbon", creator_name: "Zoe", auto_start: true }, real);
    await waitFor(async () => (await w.store.listEvents(room.session_id)).some((e) => e.kind === "agent_message"));
    const events = await w.store.listEvents(room.session_id);
    const directive = events.find((e) => e.kind === "directive");
    const reply = events.find((e) => e.kind === "agent_message");
    assert.equal(reply.reply_to, directive.id);
    assert.equal(reply.content, "Here is a plan.");
    await waitFor(async () => (await w.store.getSession(room.session_id)).agent_working === false && (await w.store.getSession(room.session_id)).step_count === 1);
    assert.match(JSON.stringify(prompts[0]), /Plan a trip to Lisbon/);
  });

  t("replies are one per directive, in the order sent, and a manual step answers what is unanswered", async (w) => {
    let n = 0;
    setStepDeps({ db: w.store, call: async () => ({ text: `reply ${++n}`, model: "fake" }), summarize: async () => {} });
    await sendDirective({ session_id: w.id, token: w.alice, content: "first" }, { ...w.d, trigger: undefined });
    await sendDirective({ session_id: w.id, token: w.alice, content: "second" }, { ...w.d, trigger: undefined });
    await waitFor(async () => (await w.store.listEvents(w.id)).filter((e) => e.kind === "agent_message").length === 2);
    const events = await w.store.listEvents(w.id);
    const directives = events.filter((e) => e.kind === "directive" && ["first", "second"].includes(e.content));
    const replies = events.filter((e) => e.kind === "agent_message");
    assert.deepEqual(replies.map((r) => r.reply_to), directives.map((d) => d.id));
    assert.deepEqual(replies.map((r) => r.content), ["reply 1", "reply 2"]);
    const stepped = await stepAgent({ session_id: w.id, token: w.alice });
    assert.ok(stepped.event, "the seeded task, never answered, gets its reply");
  });

  t("the rolling summary is saved on the session and picked up on the next read", async (w) => {
    const session = await w.store.getSession(w.id);
    const fellOut = [];
    for (let i = 0; i < SUMMARY_MIN_EVENTS; i++) {
      fellOut.push(await w.store.insertEvent({ session_id: w.id, kind: "directive", author: "Alice", content: `note ${i}` }));
    }
    await maybeUpdateSummary(w.store, session, fellOut, { call: async () => ({ text: "A short summary.", model: "fake" }) });
    const saved = await w.store.getSession(w.id);
    assert.equal(saved.summary, "A short summary.");
    assert.equal(saved.summarized_through_event_id, fellOut.at(-1).id);
  });

  // ── the live stream hub ─────────────────────────────────────────────
  t("the hub pushes a write at once because the store reports it, with its timer set far away", async (w) => {
    const hub = createHub({ db: w.store }); // default pace for a store that reports writes
    assert.equal(hub.pollMs, 30_000);
    const got = [];
    const sub = { tokenHash: hashToken(w.bob), send: (type, data) => got.push([type, data]), end() {} };
    await hub.open(w.id, sub, 0);
    got.length = 0;
    await w.store.insertEvent({ session_id: w.id, kind: "comment", author: "Alice", content: "hello hub" });
    await waitFor(() => got.some(([type, data]) => type === "event" && data.content === "hello hub"), 1000);
    await w.store.setController(w.id, "Bob");
    await waitFor(() => got.some(([type, data]) => type === "participant" && data.name === "Bob" && data.role === "controller"), 1000);
    assert.ok(!JSON.stringify(got).includes(hashToken(w.bob)), "no token hash goes to a client");
    hub.dispose();
  });

  t("the hub ends the stream of a person whose token is revoked", async (w) => {
    const hub = createHub({ db: w.store });
    const got = [];
    const sub = { tokenHash: hashToken(w.bob), send: (type) => got.push(type), end: () => got.push("end") };
    await hub.open(w.id, sub, 0);
    await w.store.revokeToken(w.id, "Bob");
    await waitFor(() => got.includes("revoked") && got.includes("end"), 1000);
    hub.dispose();
  });
}


// ── no key, no room that can't answer ───────────────────────────────

for (const kind of ["memory", "sqlite"]) {
  const t = (title, fn) => test(`[${kind}] ${title}`, async () => fn(await makers[kind]()));

  t("starting a room that would run the agent is refused with NO_KEY when no key is set up, and nothing is written or counted", async (store) => {
    let spent = 0;
    const d = { db: store, trigger: () => {}, keyCheck: () => false, limits: createLimits({ env: { CREATE_LIMIT_PER_HOUR: "1" }, local: true }), budget: { claim: () => spent++ } };
    for (let i = 0; i < 3; i++) {
      await assert.rejects(createSession({ task: "x", creator_name: "Zoe", auto_start: true }, { ...d, ip: "198.51.100.7" }), (e) => e.status === 409 && e.code === "NO_KEY" && /Open Setup/.test(e.message));
    }
    assert.deepEqual(await store.listSessions(), []);
    assert.equal(spent, 0, "no step was claimed");
    await createSession({ task: "x", creator_name: "Zoe", auto_start: true, }, { ...d, keyCheck: () => true, ip: "198.51.100.7" }); // the per-IP allowance was not used up by the refusals
  });

  t("a room started without auto_start (an MCP client driving it by hand) needs no key", async (store) => {
    const d = { db: store, trigger: () => {}, keyCheck: () => false, limits: createLimits({ env: {}, local: true }), budget: { claim: () => {} } };
    assert.ok((await createSession({ task: "x", creator_name: "Zoe" }, d)).session_id);
  });

  t("a key in the environment counts as set up", async (store) => {
    const d = { db: store, trigger: () => {}, limits: createLimits({ env: {}, local: true }), budget: { claim: () => {} } };
    setSettings(createSettings({ env: { PROVIDER: "groq", GROQ_API_KEY: "gsk_envkey_for_the_test_0000" } }));
    try {
      assert.ok((await createSession({ task: "x", creator_name: "Zoe", auto_start: true }, d)).session_id);
      setSettings(createSettings({ env: {} }));
      await assert.rejects(createSession({ task: "y", creator_name: "Zed", auto_start: true }, d), (e) => e.code === "NO_KEY");
    } finally {
      setSettings(createSettings({ dir: null }));
    }
  });
}

test("with Supabase storage the NO_KEY refusal does not apply (unchanged from before)", async () => {
  const db = makeFakeSupabase({ sessions: [], session_events: [], session_participants: [] });
  const d = { db, trigger: () => {}, keyCheck: () => false, limits: createLimits({ env: {} }), budget: { claim: () => {} } };
  assert.ok((await createSession({ task: "x", creator_name: "Zoe", auto_start: true }, d)).session_id);
});

// ── deleting every room while people are watching ────────────────────

for (const kind of ["memory", "sqlite"]) {
  test(`[${kind}] open streams are told the rooms were deleted and then closed`, async () => {
    const store = await makers[kind]();
    const d = { db: store, trigger: () => {}, keyCheck: () => true, limits: createLimits({ env: {}, local: true }), budget: { claim: () => ({}) } };
    const room = await createSession({ task: "x", creator_name: "Alice" }, d);
    const hub = createHub({ db: store });
    const got = [];
    const sub = { tokenHash: hashToken(room.token), send: (type) => got.push(type), end: () => got.push("end") };
    await hub.open(room.session_id, sub, 0);
    await store.deleteAllSessions();
    await waitFor(() => got.includes("deleted") && got.includes("end"), 1500);
    assert.ok(!got.includes("revoked"), "they are told the room is gone, not that their access ended");
    assert.equal(hub.stats().subscribers, 0);
    hub.dispose();
  });
}
