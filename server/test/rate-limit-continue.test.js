// Run: node --test test/   (no network, made-up keys)
// The Continue button on a rate-limit line: how the web app recognises the line the server writes, how long it counts down, and
// what pressing it does on the server (an ordinary message, from the controller only). The button itself is in
// web/qa/rate-limit-continue.spec.js.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as web from "../../web/src/lib/continue.js";
import { CATEGORY_MESSAGES, rateLimitLine } from "../providers/failure.js";
import { CONTINUE_TEXT, LENGTH_LIMIT_LINE } from "../agent/length.js";
import { makers, cleanup } from "./helpers/stores.js";
import { createLimits } from "../limits.js";
import { claimStep } from "../budget.js";

const { createSession } = await import("../tools/create_session.js");
const { joinSession } = await import("../tools/join_session.js");
const { sendDirective } = await import("../tools/send_directive.js");
const { stepAgent, setStepDeps } = await import("../tools/step_agent.js");
const { forgetRoom, TOOL_FORMAT_CONFIRMED } = await import("../agent/support.js");

after(cleanup);
const line = (text) => `Agent could not reply: ${text}`;

// ── the web app reads the server's lines ─────────────────────────────

test("the web app finds the wait in the line the server writes, for every wait the server says in seconds", () => {
  for (const n of [1, 2, 30, 59, 60, 61, 119, 120]) assert.deepEqual(web.limitWait(line(rateLimitLine(n))), { seconds: n }, `${n}`);
  assert.deepEqual(web.limitWait(line(rateLimitLine(0))), { seconds: 1 }, "a wait of nothing is said as one second");
});

test("the longer sentence is a rate-limit line with no wait", () => {
  assert.deepEqual(web.limitWait(line(CATEGORY_MESSAGES.NO_QUOTA)), { seconds: null });
});

test("no other line is a rate-limit line: other failures, other texts, a person's words, the length line, nothing", () => {
  for (const text of [
    line(CATEGORY_MESSAGES.BAD_KEY), line(CATEGORY_MESSAGES.BUSY), line(CATEGORY_MESSAGES.NETWORK), line(CATEGORY_MESSAGES.UNKNOWN), line(CATEGORY_MESSAGES.TIMEOUT),
    rateLimitLine(30), // without the "Agent could not reply" lead: not the server's line
    line(rateLimitLine(30)).replace("about 30", "about 3000"), line(rateLimitLine(30)).replace("30 seconds", "30 minutes"), line(rateLimitLine(30)) + " Extra.",
    line("The model provider is limiting how fast this key can be used. Try again in about -5 seconds."),
    line("The model provider is limiting how fast this key can be used. Try again in about seconds."),
    line("The model provider is limiting how fast this key can be used. Try again in about 5 seconds.\nand more"),
    LENGTH_LIMIT_LINE, "", undefined, null, 5
  ]) assert.equal(web.limitWait(text), null, String(text));
});

test("a person cannot make a rate-limit line: only a status line counts, whoever's name is on it", () => {
  const said = line(rateLimitLine(30));
  const events = [
    { id: 1, kind: "directive", author: "Maya", content: "go" },
    { id: 2, kind: "comment", author: "Guest", content: said },
    { id: 3, kind: "agent_message", author: "agent", content: said },
    { id: 4, kind: "directive", author: "Maya", content: said }
  ];
  assert.equal(web.continuableLine(events), null);
});

test("the button goes on the latest such line, and not once a message has been sent since", () => {
  const rate = (id) => ({ id, kind: "status", author: "system", content: line(rateLimitLine(30)) });
  const length = (id) => ({ id, kind: "status", author: "system", content: LENGTH_LIMIT_LINE });
  assert.equal(web.continuableLine([{ id: 1, kind: "directive" }, rate(2)]), 2);
  assert.equal(web.continuableLine([{ id: 1, kind: "directive" }, rate(2), { id: 3, kind: "status", content: "Created a.md, 3 bytes" }]), 2, "a status line after it does not take the button away");
  assert.equal(web.continuableLine([{ id: 1, kind: "directive" }, rate(2), { id: 3, kind: "comment", content: "wait for it" }]), 2, "nor does a comment");
  assert.equal(web.continuableLine([{ id: 1, kind: "directive" }, rate(2), { id: 3, kind: "directive" }]), null, "a message does, Continue included");
  assert.equal(web.continuableLine([rate(2), { id: 3, kind: "directive" }, length(4)]), 4);
  assert.equal(web.continuableLine([length(2), rate(3)]), 3, "the later of the two");
  assert.equal(web.continuableLine([{ id: 1, kind: "directive" }]), null);
});

test("seconds left: counted from when the line was written, never above the wait, never below nothing", () => {
  const at = Date.parse("2026-10-21T07:00:00.000Z");
  const left = (wait, ago, nowOffsetMs = 0) => web.secondsLeft(wait, new Date(at).toISOString(), at + ago + nowOffsetMs);
  assert.equal(left(30, 0), 30);
  assert.equal(left(30, 1), 30, "a millisecond in is still 30");
  assert.equal(left(30, 5_000), 25);
  assert.equal(left(30, 5_001), 25, "rounded up: the wait is over only when it is over");
  assert.equal(left(30, 29_999), 1);
  assert.equal(left(30, 30_000), 0);
  assert.equal(left(30, 90_000), 0);
  assert.equal(left(30, -8_000), 30, "a clock that is behind the server's does not make the wait longer than the provider said");
  assert.equal(web.secondsLeft(null, new Date(at).toISOString(), at), 0, "no wait, nothing to count");
  assert.equal(web.secondsLeft(30, "not a date", at), 30, "a time that cannot be read is counted from now");
  assert.equal(web.secondsLeft(30, undefined, at), 30);
});

// ── what pressing it does on the server ──────────────────────────────

for (const kind of ["memory", "sqlite"]) {
  async function world() {
    const store = await makers[kind]();
    const budget = { claims: 0, async claim(db) { this.claims++; return claimStep(db, 1000); } };
    const d = { db: store, trigger: () => {}, limits: createLimits({ env: {}, local: true }), budget };
    const room = await createSession({ task: "Write a long report", creator_name: "Maya" }, d);
    const guest = await joinSession({ session_id: room.session_id, name: "Guest" }, d);
    const id = room.session_id;
    forgetRoom(id);
    // The agent fails with a rate limit on the first message, and answers the next.
    let n = 0;
    setStepDeps({
      db: store, summarize: async () => {}, provider: () => "groq", toolFormats: TOOL_FORMAT_CONFIRMED, budget,
      call: async () => {
        if (n++ === 0) throw Object.assign(new Error("Groq 429: Rate limit reached. Please try again in 29.91s."), { status: 429 });
        return { text: "Here is the rest.", toolCalls: [], model: "fake", usage: { inputTokens: 5, outputTokens: 5 } };
      }
    });
    const err = console.error;
    console.error = () => {};
    try {
      await assert.rejects(stepAgent({ session_id: id, token: room.token }));
    } finally {
      console.error = err;
    }
    const statuses = async () => (await store.listEvents(id)).filter((e) => e.kind === "status").map((e) => e.content);
    return { store, d, id, host: room.token, guest: guest.token, budget, statuses };
  }
  const t = (title, fn) => test(`[${kind}] ${title}`, async () => fn(await world()));

  t("the line the room has is the one the web app recognises, with the wait", async (w) => {
    const lines = await w.statuses();
    assert.deepEqual(lines, [line(rateLimitLine(30))]);
    assert.deepEqual(web.limitWait(lines[0]), { seconds: 30 });
    const events = await w.store.listEvents(w.id);
    assert.ok(web.continuableLine(events) !== null);
    assert.ok(!Number.isNaN(Date.parse(events.find((e) => e.kind === "status").created_at)), "and it has the time it was written");
  });

  t("Continue is a message like any other: the controller's, under their name, answered as a step that spends one from the budget", async (w) => {
    const before = w.budget.claims;
    const sent = await sendDirective({ session_id: w.id, token: w.host, content: web.CONTINUE_TEXT }, w.d);
    assert.deepEqual([sent.event.kind, sent.event.author, sent.event.content], ["directive", "Maya", CONTINUE_TEXT]);
    assert.equal(w.budget.claims, before + 1);
    const stepsBefore = (await w.store.getSession(w.id)).step_count;
    const out = await stepAgent({ session_id: w.id, token: w.host });
    assert.equal(out.event.content, "Here is the rest.");
    assert.equal(out.event.reply_to, sent.event.id, "the reply is to the Continue message");
    assert.ok(out.step_count > stepsBefore, "it counts as a step of the room");
    assert.equal(web.continuableLine(await w.store.listEvents(w.id)), null, "and the button is gone");
  });

  t("every limit on a message applies to it: the pace limit and the daily budget refuse it like any other", async (w) => {
    const limits = { checkDirective: () => { throw Object.assign(new Error("slow down"), { status: 429, code: "RATE_LIMITED" }); } };
    await assert.rejects(sendDirective({ session_id: w.id, token: w.host, content: CONTINUE_TEXT }, { ...w.d, limits }), (e) => e.status === 429);
    const full = { claim: () => { throw Object.assign(new Error("full"), { status: 503, code: "AT_CAPACITY" }); } };
    await assert.rejects(sendDirective({ session_id: w.id, token: w.host, content: CONTINUE_TEXT }, { ...w.d, budget: full }), (e) => e.code === "AT_CAPACITY");
    assert.equal((await w.store.listEvents(w.id)).filter((e) => e.kind === "directive" && e.content === CONTINUE_TEXT).length, 0);
  });

  t("a guest, a watcher, a stranger and a made-up token cannot: NOT_CONTROLLER or no sign-in, nothing written, nothing spent", async (w) => {
    const before = { events: (await w.store.listEvents(w.id)).length, claims: w.budget.claims };
    await assert.rejects(sendDirective({ session_id: w.id, token: w.guest, content: CONTINUE_TEXT }, w.d), (e) => e.status === 403 && e.code === "NOT_CONTROLLER");
    for (const token of [undefined, "", "nope", "mpai_" + "a".repeat(43)]) await assert.rejects(sendDirective({ session_id: w.id, token, content: CONTINUE_TEXT }, w.d), (e) => e.status === 401 || e.status === 403);
    assert.equal((await w.store.listEvents(w.id)).length, before.events);
    assert.equal(w.budget.claims, before.claims);
  });
}
