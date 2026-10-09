// Run: node --test test/   (no network beyond this computer)
// "Test key": one request, no retries, a timeout, and an answer in a few words that never
// repeats what the provider said. The provider is a stand-in (a local server, or a fetch
// that returns what the test says), so the status codes here are what these tests assume
// providers send, not what any provider has been seen to send.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { testKey, TEST_MESSAGES } from "../key-test.js";
import { callModel } from "../providers/index.js";
import { createSettings, setSettings } from "../settings.js";
import { startFakeProvider, ok, fail, echoError, hang, drop } from "./helpers/fakeProvider.js";

const KEY = "test_key_made_up_for_key_tests_0001";
const quiet = async (fn) => {
  const log = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  try {
    return [await fn(), lines];
  } finally {
    console.error = log;
  }
};
const servers = [];
after(async () => {
  for (const s of servers) await s.close();
  setSettings(createSettings({ dir: null }));
});
const provider = async (handler) => {
  const p = await startFakeProvider(handler);
  servers.push(p);
  return p;
};
const settings = createSettings({ dir: null, env: {} });

// ── an OpenAI-compatible provider, over real HTTP ─────────────────────

test("a working key: one request, to the chat endpoint, with the key in the Authorization header only", async () => {
  const p = await provider(ok("ok"));
  const [result] = await quiet(() => testKey({ provider: "compat", key: KEY, baseUrl: p.base, model: "m1" }, { settings }));
  assert.deepEqual(result, { ok: true, model: "m1" });
  assert.equal(p.requests.length, 1);
  const req = p.requests[0];
  assert.equal(req.url, "/v1/chat/completions");
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);
  assert.ok(!req.url.includes(KEY) && !req.body.includes(KEY), "never in the address or the body");
  const body = JSON.parse(req.body);
  assert.equal(body.model, "m1");
  assert.ok(body.max_tokens <= 16, "a tiny reply is asked for");
});

for (const [status, code] of [[401, "BAD_KEY"], [403, "BAD_KEY"], [429, "NO_QUOTA"], [404, "MODEL_NOT_FOUND"], [500, "BUSY"], [503, "BUSY"]]) {
  test(`a ${status} is reported as ${code}, after exactly one request (no retry)`, async () => {
    const p = await provider(fail(status, "upstream words that must not be repeated: acme-corp"));
    const [result] = await quiet(() => testKey({ provider: "compat", key: KEY, baseUrl: p.base, model: "m1" }, { settings }));
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(result.message, TEST_MESSAGES[code]);
    assert.ok(!JSON.stringify(result).includes("acme-corp"), "the provider's own words are not passed on");
    assert.equal(p.requests.length, 1, "one request only");
  });
}

test("a provider that does not answer in time is reported as a timeout", async () => {
  const p = await provider(hang());
  const started = Date.now();
  const [result] = await quiet(() => testKey({ provider: "compat", key: KEY, baseUrl: p.base, model: "m1" }, { settings, timeoutMs: 250 }));
  assert.equal(result.code, "TIMEOUT");
  assert.ok(Date.now() - started < 3000);
});

test("a provider that cannot be reached is reported as a network problem", async () => {
  const p = await provider(ok("ok"));
  const base = p.base;
  await p.close();
  const [dead] = await quiet(() => testKey({ provider: "compat", key: KEY, baseUrl: base, model: "m1" }, { settings }));
  assert.equal(dead.code, "NETWORK");
  const [nameless] = await quiet(() => testKey({ provider: "compat", key: KEY, baseUrl: "https://no-such-host.invalid/v1", model: "m1" }, { settings, timeoutMs: 3000 }));
  assert.equal(nameless.code, "NETWORK");
});

test("a connection dropped mid-request is a network problem too", async () => {
  const p = await provider(drop());
  const [result] = await quiet(() => testKey({ provider: "compat", key: KEY, baseUrl: p.base, model: "m1" }, { settings }));
  assert.equal(result.code, "NETWORK");
});

test("a redirect is refused, so the key cannot follow it to another host", async () => {
  const target = await provider(ok("ok"));
  const p = await provider((req, res) => {
    res.writeHead(307, { Location: target.base + "/chat/completions" });
    res.end();
  });
  const [result] = await quiet(() => testKey({ provider: "compat", key: KEY, baseUrl: p.base, model: "m1" }, { settings }));
  assert.equal(result.ok, false);
  assert.equal(target.requests.length, 0, "nothing reached the host it was redirected to");
});

// ── things wrong before any request is made ───────────────────────────

test("no key, a bad address or no model are answered without contacting anyone", async () => {
  const p = await provider(ok("ok"));
  assert.deepEqual((await testKey({ provider: "groq" }, { settings })).code, "NO_KEY");
  assert.equal((await testKey({ provider: "compat", key: KEY, baseUrl: "http://example.com/v1", model: "m1" }, { settings })).code, "BAD_URL");
  assert.equal((await testKey({ provider: "compat", key: KEY, baseUrl: p.base }, { settings })).code, "BAD_SETTINGS");
  assert.equal((await testKey({ provider: "compat", baseUrl: "https://api.example.com/v1", model: "m1" }, { settings })).code, "NO_KEY");
  assert.equal((await testKey({ provider: "nobody", key: KEY }, { settings })).code, "BAD_REQUEST");
  assert.equal(p.requests.length, 0);
});

test("a model on this computer can be tested without a key, and sends no Authorization header", async () => {
  const p = await provider(ok("ok"));
  const [result] = await quiet(() => testKey({ provider: "compat", baseUrl: p.base, model: "m1" }, { settings }));
  assert.equal(result.ok, true);
  assert.equal(p.requests[0].headers.authorization, undefined);
});

test("with no key typed, the key already in force is the one tested", async () => {
  const p = await provider(ok("ok"));
  const mine = createSettings({ dir: null, env: { OPENAI_COMPAT_API_KEY: KEY } });
  const [result] = await quiet(() => testKey({ provider: "compat", baseUrl: p.base, model: "m1" }, { settings: mine }));
  assert.equal(result.ok, true);
  assert.equal(p.requests[0].headers.authorization, `Bearer ${KEY}`);
});

// ── Groq, through its own adapter ─────────────────────────────────────

const groqVia = (respond) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { calls, call: (args) => callModel({ ...args, fetchImpl }) };
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("Groq: a bad key (401) is reported as BAD_KEY after one request", async () => {
  const g = groqVia(() => json(401, { error: { message: "Invalid API Key for account acme-corp" } }));
  const [result] = await quiet(() => testKey({ provider: "groq", key: KEY }, { settings, call: g.call }));
  assert.equal(result.code, "BAD_KEY");
  assert.equal(g.calls.length, 1);
  assert.equal(g.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.ok(!JSON.stringify(result).includes("acme-corp"));
});

test("Groq: busy and rate-limit answers are not retried in a test, even though a room would retry them", async () => {
  for (const [status, code] of [[429, "NO_QUOTA"], [503, "BUSY"]]) {
    const g = groqVia(() => json(status, { error: { message: "slow down" } }));
    const [result] = await quiet(() => testKey({ provider: "groq", key: KEY }, { settings, call: g.call }));
    assert.equal(result.code, code);
    assert.equal(g.calls.length, 1, `${status}: one request`);
  }
});

test("Groq: the test never falls back to another model, and asks for a few tokens", async () => {
  const g = groqVia(() => json(200, { choices: [{ message: { content: "ok" } }] }));
  const [result] = await quiet(() => testKey({ provider: "groq", key: KEY, model: "some/model" }, { settings, call: g.call }));
  assert.equal(result.ok, true);
  const body = JSON.parse(g.calls[0].init.body);
  assert.equal(body.model, "some/model");
  assert.ok(body.max_completion_tokens <= 1024);
});

// ── Gemini, through its own adapter (which uses the SDK, which uses fetch) ──

async function withGlobalFetch(respond, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  };
  try {
    return [await fn(calls), calls];
  } finally {
    globalThis.fetch = real;
  }
}

test("Gemini: a rejected key (a 400 that says the key is not valid) is BAD_KEY after ONE request, with no second try", async () => {
  const [[result], calls] = await withGlobalFetch(
    () => json(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }),
    () => quiet(() => testKey({ provider: "gemini", key: KEY }, { settings }))
  );
  assert.equal(result.code, "BAD_KEY");
  assert.equal(calls.length, 1, "the thinking-setting retry is skipped when the key is what was rejected");
  assert.equal(new Headers(calls[0].init.headers).get("x-goog-api-key"), KEY, "the key travels in a header");
  assert.ok(!calls[0].url.includes(KEY), "never in the address");
});

test("Gemini: out of quota (429) is NO_QUOTA after one request", async () => {
  const [[result], calls] = await withGlobalFetch(
    () => json(429, { error: { code: 429, message: "Quota exceeded for project acme-corp-project", status: "RESOURCE_EXHAUSTED" } }),
    () => quiet(() => testKey({ provider: "gemini", key: KEY }, { settings }))
  );
  assert.equal(result.code, "NO_QUOTA");
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(result).includes("acme-corp"));
});

test("Gemini: an unreachable network is NETWORK, and a slow answer is TIMEOUT", async () => {
  const [[down]] = await withGlobalFetch(() => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); }, () => quiet(() => testKey({ provider: "gemini", key: KEY }, { settings })));
  assert.equal(down.code, "NETWORK");
  const [[slow]] = await withGlobalFetch(
    (url, init) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })))),
    () => quiet(() => testKey({ provider: "gemini", key: KEY }, { settings, timeoutMs: 200 }))
  );
  assert.equal(slow.code, "TIMEOUT");
});

test("Gemini: a working key is ok", async () => {
  const [[result]] = await withGlobalFetch(
    () => json(200, { candidates: [{ content: { parts: [{ text: "ok" }], role: "model" }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } }),
    () => quiet(() => testKey({ provider: "gemini", key: KEY }, { settings }))
  );
  assert.equal(result.ok, true);
});

// ── a key that is echoed back never comes out ─────────────────────────

test("a provider that repeats the request in its error does not get the key into the answer or the terminal", async () => {
  const p = await provider(echoError(401));
  const [result, lines] = await quiet(() => testKey({ provider: "compat", key: KEY, baseUrl: p.base, model: "m1" }, { settings }));
  assert.equal(result.code, "BAD_KEY");
  assert.ok(!JSON.stringify(result).includes(KEY));
  const terminal = lines.join("\n");
  assert.ok(!terminal.includes(KEY), "not in what was printed");
  assert.match(terminal, /acme-corp/, "but the host can read what the provider said");
});

test("an unnamed failure still says where to look", () => {
  assert.match(TEST_MESSAGES.UNKNOWN, /terminal/);
});
