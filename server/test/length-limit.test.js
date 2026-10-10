// Run: node --test test/   (no network, no real model, made-up keys)
// A reply that stops because the provider's limit on its length was reached: every adapter reports it, the room is told in one
// line ("The reply reached its length limit"), and the controller (nobody else) can ask the agent to continue, which is a
// message like any other. The provider's answers are stood in for, so nothing here shows what a real provider does.
import test, { after } from "node:test";
import { keepLoopAlive } from "./helpers/keep-alive.js";
keepLoopAlive();
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callModel } from "../providers/index.js";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../providers/defaults.js";
import { LENGTH_LIMIT_LINE, CONTINUE_TEXT } from "../agent/length.js";
import { buildContext } from "../context.js";
import { runAgentLoop } from "../agent/loop.js";
import { fileLimits, loopLimits } from "../files/limits.js";
import { makers, cleanup } from "./helpers/stores.js";
import { createLimits } from "../limits.js";

const { createSession } = await import("../tools/create_session.js");
const { joinSession } = await import("../tools/join_session.js");
const { sendDirective } = await import("../tools/send_directive.js");
const { takeControl } = await import("../tools/take_control.js");
const { stepAgent, setStepDeps } = await import("../tools/step_agent.js");
const { TOOL_FORMAT_CONFIRMED, forgetRoom } = await import("../agent/support.js");

after(cleanup);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const KEY = "length_made_up_key_5c4d3e2f1a0b";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ── the default cap ──────────────────────────────────────────────────

const ENV_KEYS = ["GROQ_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_COMPAT_API_KEY", "GROQ_FALLBACK_MODEL", "GEMINI_FALLBACK_MODEL"];
function setup(provider) {
  for (const v of ENV_KEYS) delete process.env[v];
  process.env[{ groq: "GROQ_API_KEY", claude: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY", compat: "OPENAI_COMPAT_API_KEY" }[provider]] = KEY;
  if (provider === "compat") Object.assign(process.env, { OPENAI_COMPAT_BASE_URL: "https://api.example.test/v1", OPENAI_COMPAT_MODEL: "m1" });
}
/** What the provider is told and what it answers: runs one call with `answer` as the provider's reply, and returns { body, result }. */
async function call(provider, answer, extra = {}) {
  setup(provider);
  let body;
  const stand = async (url, init) => ((body = JSON.parse(init.body)), json(answer));
  const saved = globalThis.fetch;
  if (provider === "gemini") globalThis.fetch = stand;
  const err = console.error;
  console.error = () => {};
  try {
    const result = await callModel({ provider, messages: [{ role: "user", content: "hi" }], fetchImpl: stand, maxRetries: 0, maxParseRetries: 0, ...extra });
    return { body, result };
  } finally {
    console.error = err;
    globalThis.fetch = saved;
  }
}
const SHAPES = {
  groq: (finish) => ({ choices: [{ message: { content: "part of an essay" }, finish_reason: finish }], usage: { prompt_tokens: 5, completion_tokens: 9 } }),
  compat: (finish) => ({ choices: [{ message: { content: "part of an essay" }, finish_reason: finish }], usage: { prompt_tokens: 5, completion_tokens: 9 } }),
  claude: (finish) => ({ content: [{ type: "text", text: "part of an essay" }], stop_reason: finish === "length" ? "max_tokens" : "end_turn", usage: { input_tokens: 5, output_tokens: 9 } }),
  gemini: (finish) => ({ candidates: [{ content: { parts: [{ text: "part of an essay" }] }, finishReason: finish === "length" ? "MAX_TOKENS" : "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9 } })
};

test("the default cap is generous, written down in one place, and Claude (which needs a number) is sent it", async () => {
  delete process.env.MAX_OUTPUT_TOKENS;
  assert.ok(Number.isInteger(DEFAULT_MAX_OUTPUT_TOKENS) && DEFAULT_MAX_OUTPUT_TOKENS >= 16000, `${DEFAULT_MAX_OUTPUT_TOKENS} tokens is room for a 5000 word essay and more`);
  const { body } = await call("claude", SHAPES.claude("stop"));
  assert.equal(body.max_tokens, DEFAULT_MAX_OUTPUT_TOKENS);
});

test("MAX_OUTPUT_TOKENS still wins over the default, and the thinking room is still added on top for Groq and Gemini", async () => {
  process.env.MAX_OUTPUT_TOKENS = "300";
  try {
    assert.equal((await call("claude", SHAPES.claude("stop"))).body.max_tokens, 300);
    const groq = (await call("groq", SHAPES.groq("stop"))).body;
    assert.ok(groq.max_completion_tokens > 300, "reasoning tokens count toward Groq's limit, so room is added");
    const gem = (await call("gemini", SHAPES.gemini("stop"))).body;
    assert.ok(gem.generationConfig.maxOutputTokens > 300, "thinking tokens count toward Gemini's limit, so room is added");
    assert.equal((await call("compat", SHAPES.compat("stop"))).body.max_tokens, 300);
  } finally {
    delete process.env.MAX_OUTPUT_TOKENS;
  }
});

test("with no MAX_OUTPUT_TOKENS, Groq, Gemini and an OpenAI-compatible service are sent no cap of ours: their own default applies", async () => {
  delete process.env.MAX_OUTPUT_TOKENS;
  for (const p of ["groq", "gemini", "compat"]) {
    const { body } = await call(p, SHAPES[p]("stop"));
    const fields = [body.max_tokens, body.max_completion_tokens, body.generationConfig?.maxOutputTokens];
    assert.deepEqual(fields.filter((f) => f !== undefined), [], p);
  }
});

// ── every adapter says when the provider stopped for length ──────────

for (const p of ["groq", "compat", "claude", "gemini"]) {
  test(`${p}: a reply the provider cut at its length limit is reported as stoppedForLength, and a finished one is not`, async () => {
    assert.equal((await call(p, SHAPES[p]("length"))).result.stoppedForLength, true);
    assert.equal((await call(p, SHAPES[p]("stop"))).result.stoppedForLength, false);
    assert.equal((await call(p, SHAPES[p]("length"))).result.text, "part of an essay", "the part that was written is still the reply");
  });
}

// ── the loop and the step ────────────────────────────────────────────

test("the tool loop passes it on from the call that ended it, and not from an earlier one that did not", async () => {
  const store = await makers.memory();
  const room = await store.createSession({ title: "t", task: "t", files_enabled: true });
  const base = { store, sessionId: room.id, author: "Maya", messages: [{ role: "user", content: "hi" }], tools: [], limits: loopLimits({}), fileLimits: fileLimits({}), hooks: {} };
  const cut = await runAgentLoop({ ...base, call: async () => ({ text: "half", toolCalls: [], model: "m", usage: null, stoppedForLength: true }) });
  assert.equal(cut.stoppedForLength, true);
  const fine = await runAgentLoop({ ...base, call: async () => ({ text: "whole", toolCalls: [], model: "m", usage: null, stoppedForLength: false }) });
  assert.equal(fine.stoppedForLength, false);
  const none = await runAgentLoop({ ...base, call: async () => ({ text: "whole", toolCalls: [], model: "m", usage: null }) });
  assert.equal(none.stoppedForLength, false, "an adapter that says nothing is not guessed at");
});

for (const kind of ["memory", "sqlite"]) {
  async function world() {
    const store = await makers[kind]();
    const budget = { claims: 0, claim() { this.claims++; return {}; } };
    const d = { db: store, trigger: () => {}, limits: createLimits({ env: {}, local: true }), budget };
    const room = await createSession({ task: "Write 5000 words on tea", creator_name: "Maya" }, d);
    const guest = await joinSession({ session_id: room.session_id, name: "Guest" }, d);
    const id = room.session_id;
    forgetRoom(id);
    const statuses = async () => (await store.listEvents(id)).filter((e) => e.kind === "status").map((e) => e.content);
    const run = (answers, { tools = true } = {}) => {
      let i = 0;
      setStepDeps({ db: store, summarize: async () => {}, provider: () => "groq", toolFormats: tools ? TOOL_FORMAT_CONFIRMED : {}, budget, call: async () => answers[Math.min(i++, answers.length - 1)] });
    };
    return { store, d, id, host: room.token, guest: guest.token, budget, statuses, run };
  }
  const t = (title, fn) => test(`[${kind}] ${title}`, async () => fn(await world()));
  const answer = (over = {}) => ({ text: "The first part of the essay.", toolCalls: [], model: "fake", usage: { inputTokens: 10, outputTokens: 20 }, stoppedForLength: false, ...over });

  for (const tools of [true, false]) {
    t(`${tools ? "with" : "without"} file tools: a reply cut at the limit is saved, then the room is told, in one line, before the usage line`, async (w) => {
      w.run([answer({ stoppedForLength: true })], { tools });
      const out = await stepAgent({ session_id: w.id, token: w.host });
      assert.equal(out.event.content, "The first part of the essay.", "what was written is kept as the reply");
      const lines = await w.statuses();
      assert.equal(lines.filter((l) => l === LENGTH_LIMIT_LINE).length, 1);
      assert.ok(lines.indexOf(LENGTH_LIMIT_LINE) < lines.findIndex((l) => l.startsWith("Used ")), "it comes before the usage line");
      assert.equal(LENGTH_LIMIT_LINE, "The reply reached its length limit");
    });

    t(`${tools ? "with" : "without"} file tools: a reply that finished says nothing about length`, async (w) => {
      w.run([answer()], { tools });
      await stepAgent({ session_id: w.id, token: w.host });
      assert.ok(!(await w.statuses()).some((l) => /length limit/i.test(l)));
    });
  }

  t("Continue is a message like any other: the controller's, written under their name, answered as a step, and it spends a step from the budget", async (w) => {
    w.run([answer({ stoppedForLength: true }), answer({ text: "The rest of it." })]);
    await stepAgent({ session_id: w.id, token: w.host });
    const before = w.budget.claims;
    const sent = await sendDirective({ session_id: w.id, token: w.host, content: CONTINUE_TEXT }, { ...w.d, trigger: () => {} });
    assert.equal(sent.event.kind, "directive");
    assert.equal(sent.event.author, "Maya");
    assert.equal(sent.event.content, "Continue from where you stopped");
    assert.equal(w.budget.claims, before + 1, "one step is spent, as for any message");
    const out = await stepAgent({ session_id: w.id, token: w.host });
    assert.equal(out.event.content, "The rest of it.");
    assert.equal(out.step_count, 2, "it counts as a step of the room");
  });

  t("a guest cannot use it: the same message from a guest is refused, writes nothing and spends nothing", async (w) => {
    w.run([answer({ stoppedForLength: true })]);
    await stepAgent({ session_id: w.id, token: w.host });
    const before = { events: (await w.store.listEvents(w.id)).length, claims: w.budget.claims };
    await assert.rejects(sendDirective({ session_id: w.id, token: w.guest, content: CONTINUE_TEXT }, { ...w.d, trigger: () => {} }), (e) => e.status === 403 && e.code === "NOT_CONTROLLER");
    assert.equal((await w.store.listEvents(w.id)).length, before.events);
    assert.equal(w.budget.claims, before.claims);
  });

  t("someone who is not in the room, and a made-up token, are refused too", async (w) => {
    for (const token of [undefined, "nope", "mpai_" + "a".repeat(43)]) {
      await assert.rejects(sendDirective({ session_id: w.id, token, content: CONTINUE_TEXT }, { ...w.d, trigger: () => {} }), (e) => e.status === 401 || e.status === 403);
    }
  });

  t("once control changes hands the new controller can continue and the old one cannot", async (w) => {
    await takeControl({ session_id: w.id, token: w.guest }, { ...w.d, caller: { host: false, sharing: false } }).catch(() => {});
    const mine = await w.store.listParticipants(w.id);
    const controller = mine.find((p) => p.role === "controller").name;
    const [ok, no] = controller === "Guest" ? [w.guest, w.host] : [w.host, w.guest];
    await sendDirective({ session_id: w.id, token: ok, content: CONTINUE_TEXT }, { ...w.d, trigger: () => {} });
    await assert.rejects(sendDirective({ session_id: w.id, token: no, content: CONTINUE_TEXT }, { ...w.d, trigger: () => {} }), (e) => e.code === "NOT_CONTROLLER");
  });
}

// ── what the next step sees of a reply that was cut ──────────────────

test("the newest reply keeps its end in the next step's context, so 'continue from where you stopped' can find where it stopped", () => {
  const long = "BEGINNING " + "a long essay about tea. ".repeat(1200) + "THE LAST SENTENCE WAS CUT MID-WO";
  const events = [
    { id: 1, kind: "directive", author: "Maya", content: "Write 5000 words" },
    { id: 2, kind: "agent_message", author: "agent", content: long, reply_to: 1 },
    { id: 3, kind: "directive", author: "Maya", content: CONTINUE_TEXT }
  ];
  const { messages } = buildContext({ session: { task: "t" }, events, participants: [{ name: "Maya", role: "controller" }], directiveId: 3, maxTokens: 6000 });
  const seen = messages.find((m) => m.role === "assistant");
  assert.ok(seen, "the earlier reply is in the context");
  assert.ok(seen.content.includes("THE LAST SENTENCE WAS CUT MID-WO"), "its end is there");
  assert.ok(seen.content.startsWith("BEGINNING"), "and its start");
  assert.ok(seen.content.length < long.length, "the middle is left out, and the text says so");
  assert.match(seen.content, /middle of this message is not shown/);
  assert.equal(messages.at(-1).content, `[Maya]: ${CONTINUE_TEXT}`);
});

test("an older long reply is cut at its start as before, and only the newest keeps its end", () => {
  const long = (tag) => `START-${tag} ` + "word ".repeat(1200) + `END-${tag}`;
  const events = [
    { id: 1, kind: "directive", author: "Maya", content: "one" },
    { id: 2, kind: "agent_message", author: "agent", content: long("OLD"), reply_to: 1 },
    { id: 3, kind: "directive", author: "Maya", content: "two" },
    { id: 4, kind: "agent_message", author: "agent", content: long("NEW"), reply_to: 3 },
    { id: 5, kind: "directive", author: "Maya", content: "three" }
  ];
  const { messages } = buildContext({ session: { task: "t" }, events, participants: [{ name: "Maya", role: "controller" }], directiveId: 5, maxTokens: 20000 });
  const [oldReply, newReply] = messages.filter((m) => m.role === "assistant").map((m) => m.content);
  assert.ok(oldReply.includes("START-OLD") && !oldReply.includes("END-OLD"));
  assert.ok(newReply.includes("START-NEW") && newReply.includes("END-NEW"));
});

// ── the web app says the same words ──────────────────────────────────

test("the web app uses the same two texts as the server, so the button appears on the line the server writes and sends what it expects", () => {
  const web = fs.readFileSync(path.join(ROOT, "web/src/lib/continue.js"), "utf8");
  assert.ok(web.includes(`LENGTH_LIMIT_LINE = ${JSON.stringify(LENGTH_LIMIT_LINE)}`), "the status line");
  assert.ok(web.includes(`CONTINUE_TEXT = ${JSON.stringify(CONTINUE_TEXT)}`), "the message");
});
