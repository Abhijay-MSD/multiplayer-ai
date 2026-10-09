// Run: node --test test/   (no network, no real Supabase)
import test from "node:test";
import assert from "node:assert/strict";
import { makeFakeSupabase } from "./fakeSupabase.js";
import { assembleContext, estimateTokens, TRUNCATED_MARK } from "../context.js";
import { maybeUpdateSummary, SUMMARY_MIN_EVENTS } from "../summary.js";

const SID = "11111111-2222-3333-4444-555555555555";
const TASK = "Build a tiny CLI that renames photos by date";

// 200 events: noise (join/leave/takeover/status incl. "Agent could not reply")
// mixed with 70 directives (Alice = controller, Bob) and 70 agent replies.
function seed() {
  const events = [];
  const add = (kind, author, content, extra = {}) => events.push({ id: events.length + 1, session_id: SID, kind, author, content, reply_to: null, ...extra });
  add("join", "Alice", "Alice created the session.");
  add("directive", "Alice", TASK);
  for (let i = 0; i < 70; i++) {
    const who = i % 3 === 0 ? "Bob" : "Alice";
    add("directive", who, `directive ${i} from ${who}: ${"detail ".repeat(i === 10 ? 800 : 25)}`);
    add("agent_message", "agent", `reply ${i}: ${"answer ".repeat(i === 20 ? 900 : 30)}`, { reply_to: events.length });
    if (i % 3 === 0) add("comment", i % 2 ? "Bob" : "Cy", `COMMENTNOISE ${i} chatter`);
    if (i % 4 === 0) add("status", "system", `Agent could not reply: 429 (${i})`);
    if (i % 17 === 0) add("takeover", "Bob", "Bob took control.");
    if (i % 23 === 0) add("leave", "Bob", "Bob left.");
  }
  while (events.length < 199) add("status", "system", "Primary model was busy; this reply came from lite.");
  add("directive", "Bob", "hi");
  return events;
}

function world(extraSession = {}) {
  const events = seed();
  const session = { id: SID, task: TASK, status: "active", step_count: 70, summary: null, summarized_through_event_id: null, ...extraSession };
  const db = makeFakeSupabase({
    sessions: [session],
    session_events: events,
    session_participants: [
      { session_id: SID, name: "Alice", role: "controller" },
      { session_id: SID, name: "Bob", role: "watcher" }
    ]
  });
  return { db, session, events, last: events[events.length - 1] };
}

const text = (messages) => messages.map((m) => m.content).join("\n");
const tokens = (messages) => messages.reduce((n, m) => n + estimateTokens(m.content), 0);

test("seed is a 200-event session", () => assert.equal(world().events.length, 200));

for (const budget of [6000, 1500]) {
  test(`context stays under MAX_CONTEXT_TOKENS=${budget}; pinned + newest directive present; noise excluded`, async () => {
    process.env.MAX_CONTEXT_TOKENS = String(budget);
    const { db, session, last } = world();
    const { messages, stats, fellOut } = await assembleContext(db, session, last.id);
    const all = text(messages);

    assert.ok(tokens(messages) <= budget, `${tokens(messages)} > ${budget}`);
    assert.equal(stats.approxTokens, tokens(messages));
    assert.ok(stats.included < stats.considered, "window must be a subset of the transcript");
    assert.ok(fellOut.length > 0);

    // stable order: system prompt, pinned, (summary), history, current directive last
    assert.equal(messages[0].role, "system");
    assert.match(messages[1].content, new RegExp(`Original task: ${TASK}`));
    assert.match(messages[1].content, /Controller: Alice/);
    assert.deepEqual(messages.at(-1), { role: "user", content: "[Bob]: hi" });

    // noise is out; sender attribution is in
    assert.doesNotMatch(all, /could not reply|COMMENTNOISE|Primary model was busy|took control|created the session|Bob left/);
    assert.match(all, /\[Alice\]: directive/);
    assert.match(all, /\[Bob\]: directive/);
  });
}

test("a single huge event is truncated and marked; the current directive never is", async () => {
  process.env.MAX_CONTEXT_TOKENS = "6000";
  const { db, session, events } = world();
  const huge = "x".repeat(9000);
  events.push({ id: 201, session_id: SID, kind: "directive", author: "Alice", content: huge });
  const hugeNow = events.find((e) => e.id === 130);
  hugeNow.content = "y".repeat(9000); // old agent/directive inside the window range
  const withHistory = await assembleContext(db, session, 201);
  assert.equal(withHistory.messages.at(-1).content, `[Alice]: ${huge}`.replace("[Alice]", "[Alice]"), "current directive is full");
  assert.ok(!withHistory.messages.at(-1).content.includes(TRUNCATED_MARK));

  events.push({ id: 202, session_id: SID, kind: "directive", author: "Bob", content: "next" });
  const next = await assembleContext(db, session, 202);
  const hugeLine = next.messages.find((m) => m.content.startsWith("[Alice]: xxxx"));
  assert.ok(hugeLine, "huge directive appears as history");
  assert.ok(hugeLine.content.endsWith(TRUNCATED_MARK) && hugeLine.content.length < 2100);
  assert.ok(next.stats.truncated >= 1);
});

test("summary updates only once 10+ events have fallen out, and never twice for the same events", async () => {
  process.env.MAX_CONTEXT_TOKENS = "1500";
  const w = world();
  let calls = 0;
  const call = async ({ messages }) => {
    calls++;
    assert.doesNotMatch(messages.map((m) => m.content).join("\n"), /COMMENTNOISE/, "comments never reach the summarizer");
    assert.match(messages[1].content, /\[Alice\]|\[Bob\]/, "who requested what is passed in");
    return { text: `summary v${calls}`, model: "fake-lite" };
  };

  // 1) many events fell out -> summarizes (a backlog larger than one chunk of 60
  //    takes one pass per step, never re-folding an event)
  const row = w.db.tables.sessions[0];
  let ctx = await assembleContext(w.db, row, w.last.id);
  assert.ok(ctx.fellOut.length >= SUMMARY_MIN_EVENTS);
  const seen = new Set();
  let through = 0;
  for (let pass = 0; pass < 5; pass++) {
    ctx = await assembleContext(w.db, row, w.last.id);
    const before = calls;
    await maybeUpdateSummary(w.db, row, ctx.fellOut, { call });
    if (calls === before) break;
    assert.ok(row.summarized_through_event_id > through, "mark only moves forward");
    ctx.fellOut.filter((e) => e.id <= row.summarized_through_event_id).forEach((e) => {
      assert.ok(!seen.has(e.id), "event folded twice");
      seen.add(e.id);
    });
    through = row.summarized_through_event_id;
  }
  assert.ok(calls >= 1 && calls <= 3, `calls=${calls}`);
  assert.equal(row.summary, `summary v${calls}`);
  assert.ok(through > 0 && through < w.last.id);

  // 2) next step: summary is in the context, folded events are not repeated
  ctx = await assembleContext(w.db, row, w.last.id);
  assert.ok(ctx.stats.hasSummary);
  assert.match(ctx.messages[2].content, new RegExp(`summary v${calls}`));
  assert.equal(ctx.messages[2].role, "system"); // order: system, pinned, summary, ...
  assert.ok(ctx.fellOut.every((e) => e.id > through));

  // 3) a few new events (below the threshold) do not trigger another summary
  for (let i = 0; i < 3; i++) {
    const id = w.events.length + 1;
    w.events.push({ id, session_id: SID, kind: i % 2 ? "agent_message" : "directive", author: i % 2 ? "agent" : "Bob", content: `more ${i}` });
  }
  ctx = await assembleContext(w.db, row, w.events.at(-1).id);
  const before = calls;
  await maybeUpdateSummary(w.db, row, ctx.fellOut, { call });
  assert.equal(calls, before, "below threshold: no model call");

  // 4) enough new events cross the threshold -> second summary, mark advances
  for (let i = 0; i < 40; i++) {
    const id = w.events.length + 1;
    w.events.push({ id, session_id: SID, kind: i % 2 ? "agent_message" : "directive", author: i % 2 ? "agent" : "Bob", content: `later ${i} ${"q".repeat(300)}` });
  }
  ctx = await assembleContext(w.db, row, w.events.at(-1).id);
  await maybeUpdateSummary(w.db, row, ctx.fellOut, { call });
  assert.equal(calls, before + 1);
  assert.ok(row.summarized_through_event_id > through);
});

test("summary is skipped (not fatal) when the columns do not exist yet", async () => {
  process.env.MAX_CONTEXT_TOKENS = "1500";
  const w = world();
  delete w.session.summary;
  delete w.session.summarized_through_event_id;
  const ctx = await assembleContext(w.db, w.session, w.last.id);
  let calls = 0;
  await maybeUpdateSummary(w.db, w.session, ctx.fellOut, { call: async () => (calls++, { text: "x" }) });
  assert.equal(calls, 0);
});

test("summary failure never throws", async () => {
  process.env.MAX_CONTEXT_TOKENS = "1500";
  const w = world();
  const ctx = await assembleContext(w.db, w.session, w.last.id);
  await maybeUpdateSummary(w.db, w.session, ctx.fellOut, { call: async () => { throw new Error("429"); } });
  assert.equal(w.db.tables.sessions[0].summary, null);
});

test("MAX_CONTEXT_TOKENS defaults to 6000 when unset", async () => {
  delete process.env.MAX_CONTEXT_TOKENS;
  const w = world();
  const { messages } = await assembleContext(w.db, w.session, w.last.id);
  assert.ok(tokens(messages) <= 6000);
});
