// Run: node --test test/   (no network, no real model, a made-up key)
// The native Claude adapter. Details of the real API (the address, header names, body and response fields, error
// statuses and the default model) are NOT confirmed against its documentation (see docs/providers.md), so these
// tests pin what the adapter does with them, not that they are right.
import test from "node:test";
import { keepLoopAlive } from "./helpers/keep-alive.js";
keepLoopAlive();
import assert from "node:assert/strict";
import { callModel, ENDPOINT, API_VERSION } from "../providers/anthropic.js";
import { callModel as callActive } from "../providers/index.js";
import { DEFAULT_MODELS, PROVIDER_IDS } from "../providers/defaults.js";
import { createSettings, PROVIDER_LABELS } from "../settings.js";
import { validateEnv } from "../env-check.js";
import { testKey } from "../key-test.js";
import { redact, registerSecret } from "../secrets.js";

const KEY = "ant_made_up_key_for_tests_9f8e7d6c5b4a";
const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const ok = (text = "hello", usage = { input_tokens: 11, output_tokens: 4 }) =>
  reply(200, { id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage });

test.beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = KEY;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.PROVIDER;
  delete process.env.MAX_OUTPUT_TOKENS;
});

async function captureStderr(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return lines;
}

test("sends one POST to the messages address with the key and version in headers, never in the address or body", async () => {
  let seen;
  const fetchImpl = async (url, init) => ((seen = { url, init }), ok());
  const out = await callModel({
    messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "again" }],
    maxOutputTokens: 300,
    fetchImpl
  });
  assert.equal(seen.url, ENDPOINT);
  assert.equal(ENDPOINT, "https://api.anthropic.com/v1/messages");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.redirect, "error", "a redirect is refused, so the key can't follow one to another host");
  assert.equal(seen.init.headers["x-api-key"], KEY);
  assert.equal(seen.init.headers["anthropic-version"], API_VERSION);
  assert.equal(seen.init.headers["content-type"], "application/json");
  assert.ok(!("Authorization" in seen.init.headers));
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, DEFAULT_MODELS.claude);
  assert.equal(body.system, "be brief");
  assert.equal(body.max_tokens, 300);
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "again" }]);
  assert.ok(!seen.url.includes(KEY) && !seen.init.body.includes(KEY));
  assert.deepEqual(out, { text: "hello", toolCalls: [], model: DEFAULT_MODELS.claude, usage: { inputTokens: 11, outputTokens: 4 }, stoppedForLength: false });
});

test("max_tokens is always sent, because the API needs it; with no cap a generous default is used", async () => {
  let body;
  await callModel({ messages: [{ role: "user", content: "x" }], fetchImpl: async (_u, init) => ((body = JSON.parse(init.body)), ok()) });
  assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens >= 1024);
});

test("messages are shaped for the API: system pulled out, neighbours merged, a first reply from the agent gets a user line before it", async () => {
  let body;
  const fetchImpl = async (_u, init) => ((body = JSON.parse(init.body)), ok());
  await callModel({ messages: [{ role: "assistant", content: "earlier answer" }, { role: "user", content: "a" }, { role: "user", content: "b" }, { role: "user", content: "  " }, { role: "system", content: "s1" }, { role: "system", content: "s2" }], fetchImpl });
  assert.equal(body.system, "s1\n\ns2");
  assert.equal(body.messages[0].role, "user", "the API wants the first message to come from the user");
  assert.deepEqual(body.messages.slice(1), [{ role: "assistant", content: "earlier answer" }, { role: "user", content: "a\n\nb" }]);
});

test("the text of every text block is joined; other blocks are ignored; an empty answer says so", async () => {
  const blocks = (content) => async () => reply(200, { content, usage: { input_tokens: 1, output_tokens: 1 } });
  assert.equal((await callModel({ messages: [], fetchImpl: blocks([{ type: "text", text: "one " }, { type: "tool_use", name: "x" }, { type: "text", text: "two" }]) })).text, "one two");
  assert.equal((await callModel({ messages: [], fetchImpl: blocks([]) })).text, "(no response)");
});

test("the timing line gives tokens and status and nothing secret", async () => {
  const lines = await captureStderr(() => callModel({ messages: [{ role: "user", content: "secret task text" }], label: "step", fetchImpl: async () => ok("the answer", { input_tokens: 21, output_tokens: 7 }) }));
  const line = lines.find((l) => l.includes("[multiplayer-ai:timing]"));
  assert.match(line, /claude model=\S+ status=200 duration=\d+ms input_tokens=21 output_tokens=7/);
  for (const l of lines) assert.ok(!l.includes(KEY) && !l.includes("secret task text") && !l.includes("the answer"), l);
});

test("busy answers (429, 503, 529) are retried with backoff and then succeed", async () => {
  for (const status of [429, 503, 529]) {
    let calls = 0;
    const fetchImpl = async () => (++calls < 3 ? reply(status, { type: "error", error: { type: "overloaded_error", message: "busy" } }) : ok("later"));
    const out = await captureStderr(async () => assert.equal((await callModel({ messages: [{ role: "user", content: "x" }], fetchImpl, baseDelayMs: 0 })).text, "later"));
    assert.equal(calls, 3, `status ${status}`);
    assert.ok(out.length >= 2);
  }
});

test("an error type of overloaded is retried even when the status is something else", async () => {
  let calls = 0;
  const fetchImpl = async () => (++calls < 2 ? reply(500, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) : ok("fine"));
  await captureStderr(async () => assert.equal((await callModel({ messages: [], fetchImpl, baseDelayMs: 0 })).text, "fine"));
  assert.equal(calls, 2);
});

test("it gives up after the retries, and with maxRetries 0 it tries once", async () => {
  let calls = 0;
  const busy = async () => (calls++, reply(529, { type: "error", error: { type: "overloaded_error", message: "busy" } }));
  await captureStderr(() => assert.rejects(callModel({ messages: [], fetchImpl: busy, baseDelayMs: 0, maxRetries: 2 }), (e) => e.status === 529));
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(callModel({ messages: [], fetchImpl: busy, maxRetries: 0 }), (e) => e.status === 529);
  assert.equal(calls, 1);
});

test("a key the API doesn't accept (401) is never retried and is reported as BAD_KEY", async () => {
  let calls = 0;
  const fetchImpl = async () => (calls++, reply(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
  await assert.rejects(callActive({ provider: "claude", messages: [], fetchImpl, baseDelayMs: 0 }), (e) => e.category === "BAD_KEY");
  assert.equal(calls, 1);
});

test("each failure maps to the room's category, with no provider words in the message", async () => {
  const cases = [[403, "BAD_KEY"], [404, "MODEL_NOT_FOUND"], [429, "NO_QUOTA"], [529, "BUSY"], [500, "BUSY"], [400, "UNKNOWN"]];
  for (const [status, category] of cases) {
    const fetchImpl = async () => reply(status, { type: "error", error: { type: "x", message: "ACCOUNT acme-corp detail" } });
    await captureStderr(() =>
      assert.rejects(callActive({ provider: "claude", messages: [], fetchImpl, maxRetries: 0 }), (e) => {
        assert.equal(e.category, category, `status ${status}`);
        assert.ok(!e.message.includes("acme-corp"), "the room's message is only the category's");
        return true;
      })
    );
  }
});

test("a model the API doesn't know gives a plain not-found message naming Settings", async () => {
  const fetchImpl = async () => reply(404, { type: "error", error: { type: "not_found_error", message: "model: nope" } });
  await assert.rejects(callActive({ provider: "claude", messages: [], fetchImpl, model: "nope" }), (e) => e.category === "MODEL_NOT_FOUND" && /doesn't know the model/.test(e.message) && /Settings/.test(e.message));
});

test("a request that takes longer than the timeout fails as TIMEOUT", async () => {
  const fetchImpl = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
  await assert.rejects(callActive({ provider: "claude", messages: [], fetchImpl, timeoutMs: 30, maxRetries: 0 }), (e) => e.category === "TIMEOUT");
});

test("no key says how to set one up", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(callModel({ messages: [], fetchImpl: async () => ok() }), (e) => e.category === "NO_KEY" && /No Claude API key is set up\. Add one in Settings\./.test(e.message));
  await assert.rejects(callActive({ provider: "claude", messages: [], fetchImpl: async () => ok() }), (e) => e.category === "NO_KEY" && /No API key is set up yet/.test(e.message), "the room sees the category's words");
});

test("when the API's error repeats the key back, neither the room's message, the failure detail nor the terminal has it", async () => {
  const forget = registerSecret(KEY);
  try {
    const fetchImpl = async (_u, init) =>
      reply(401, { type: "error", error: { type: "authentication_error", message: `invalid x-api-key; you sent x-api-key: ${init.headers["x-api-key"]} in ${init.body.slice(0, 40)}` } });
    let failure;
    const lines = await captureStderr(async () => {
      failure = await callActive({ provider: "claude", messages: [{ role: "user", content: "x" }], fetchImpl }).catch((e) => e);
    });
    assert.equal(failure.category, "BAD_KEY");
    for (const text of [failure.message, failure.detail, ...lines, redact(failure.stack ?? "")]) assert.ok(!String(text).includes(KEY), String(text).slice(0, 120));
  } finally {
    forget();
  }
});

test("settings: a model can be set, the default is a named setting, and ANTHROPIC_MODEL overrides it", () => {
  assert.ok(PROVIDER_IDS.includes("claude"));
  assert.equal(PROVIDER_LABELS.claude, "Claude");
  assert.match(DEFAULT_MODELS.claude, /^claude-/);
  const s = createSettings({ dir: null, env: { PROVIDER: "claude", ANTHROPIC_API_KEY: KEY } });
  assert.equal(s.provider(), "claude");
  assert.equal(s.model("claude"), DEFAULT_MODELS.claude);
  assert.equal(s.apiKey("claude"), KEY);
  assert.equal(s.configured(), true);
  const t = createSettings({ dir: null, env: { PROVIDER: "claude", ANTHROPIC_API_KEY: KEY, ANTHROPIC_MODEL: "claude-custom-1" } });
  assert.equal(t.model("claude"), "claude-custom-1");
  const view = t.publicView().providers.find((p) => p.id === "claude");
  assert.equal(view.default_model, DEFAULT_MODELS.claude);
  assert.ok(!JSON.stringify(t.publicView()).includes(KEY), "the key is never in what Settings shows");
});

test("a saved key is never returned and a PROVIDER of claude is accepted at start", () => {
  const s = createSettings({ dir: null, env: {} });
  s.save({ provider: "claude" });
  s.saveKey("claude", KEY);
  assert.equal(s.provider(), "claude");
  assert.ok(!JSON.stringify(s.publicView()).includes(KEY));
  assert.deepEqual(validateEnv({ PROVIDER: "claude" }, { store: "sqlite" }).errors, []);
  assert.match(validateEnv({ PROVIDER: "claud" }, { store: "sqlite" }).errors.join(" "), /PROVIDER.*claude/);
});

test("Test key goes through the same adapter, once, and a bad key is named without the API's words", async () => {
  const calls = [];
  const via = (respond) => ({ calls, call: (args) => callActive({ ...args, fetchImpl: async (u, i) => (calls.push({ u, i }), respond()) }) });
  const settings = createSettings({ dir: null, env: {} });
  const good = via(() => ok("ok"));
  const [okResult] = await Promise.all([testKey({ provider: "claude", key: KEY }, { settings, call: good.call })]);
  assert.deepEqual(okResult, { ok: true, model: DEFAULT_MODELS.claude });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].i.headers["x-api-key"], KEY);

  const bad = via(() => reply(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key for acme-corp" } }));
  const before = calls.length;
  let result;
  await captureStderr(async () => (result = await testKey({ provider: "claude", key: KEY }, { settings, call: bad.call })));
  assert.equal(result.ok, false);
  assert.equal(result.code, "BAD_KEY");
  assert.ok(!result.message.includes("acme-corp") && !result.message.includes(KEY));
  assert.equal(calls.length - before, 1, "a wrong key is not retried");
});
