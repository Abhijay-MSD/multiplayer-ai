// Run: node --test test/   (no network, no real model)
import test from "node:test";
import { keepLoopAlive } from "./helpers/keep-alive.js";
keepLoopAlive();
import assert from "node:assert/strict";
import { callModel, normalizeMessages } from "../providers/groq.js";
import { callModel as callActive, maxOutputTokensFromEnv } from "../providers/index.js";
import { thinkingHeadroom } from "../providers/gemini.js";

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const ok = (text) => reply(200, { choices: [{ message: { content: text } }], usage: { prompt_tokens: 5, completion_tokens: 3 } });

const parseFailure = (generated = "<|channel|>analysis garbage") =>
  reply(400, { error: { message: "Parsing failed. The model generated output that could not be parsed.", type: "invalid_request_error", code: "tool_use_failed", failed_generation: generated } });

test.beforeEach(() => {
  process.env.GROQ_API_KEY = "test-key";
  delete process.env.GROQ_MODEL;
  delete process.env.GROQ_FALLBACK_MODEL;
  delete process.env.GROQ_REASONING_EFFORT;
  delete process.env.MAX_OUTPUT_TOKENS;
  delete process.env.PROVIDER;
});

// Capture what the adapter writes to stderr while `fn` runs.
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

test("sends the messages and returns the text", async () => {
  let seen;
  const fetchImpl = async (url, init) => ((seen = { url, init }), ok("  hello  "));
  const out = await callModel({ messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], fetchImpl });
  assert.equal(out.text, "hello");
  assert.equal(out.model, "openai/gpt-oss-120b");
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
  assert.equal(seen.init.headers.Authorization, "Bearer test-key");
});

test("a missing key says how to set it", async () => {
  delete process.env.GROQ_API_KEY;
  await assert.rejects(callModel({ messages: [], fetchImpl: async () => ok("x") }), (e) => e.category === "NO_KEY" && /No Groq API key is set up/.test(e.message));
});

test("a bad request surfaces Groq's message and is not retried", async () => {
  let calls = 0;
  const fetchImpl = async () => (calls++, reply(401, { error: { message: "Invalid API Key" } }));
  await assert.rejects(callModel({ messages: [], fetchImpl }), /Groq 401: Invalid API Key/);
  assert.equal(calls, 1);
});

test("falls back to the second model when the first stays busy", async () => {
  process.env.GROQ_FALLBACK_MODEL = "openai/gpt-oss-20b";
  const models = [];
  const fetchImpl = async (_url, init) => {
    const model = JSON.parse(init.body).model;
    models.push(model);
    return model === "openai/gpt-oss-120b" ? reply(429, { error: { message: "rate limited" } }) : ok("from fallback");
  };
  const out = await callModel({ messages: [], fetchImpl, maxRetries: 0 });
  assert.equal(out.text, "from fallback");
  assert.equal(out.usedFallback, true);
  assert.deepEqual(models, ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
});

test("a parse failure is retried on the same model and then succeeds", async () => {
  process.env.GROQ_FALLBACK_MODEL = "openai/gpt-oss-20b";
  const models = [];
  const fetchImpl = async (_url, init) => {
    models.push(JSON.parse(init.body).model);
    return models.length === 1 ? parseFailure() : ok("hi there");
  };
  const out = await callModel({ messages: [{ role: "user", content: "hi" }], fetchImpl, parseBackoffMs: 0 });
  assert.equal(out.text, "hi there");
  assert.equal(out.model, "openai/gpt-oss-120b");
  assert.equal(out.usedFallback, undefined);
  assert.deepEqual(models, ["openai/gpt-oss-120b", "openai/gpt-oss-120b"]);
});

test("a 400 carrying failed_generation counts as a parse failure even without the message text", async () => {
  let calls = 0;
  const fetchImpl = async () =>
    ++calls === 1 ? reply(400, { error: { message: "bad output", failed_generation: "x" } }) : ok("fine");
  const out = await callModel({ messages: [{ role: "user", content: "hi" }], fetchImpl, parseBackoffMs: 0 });
  assert.equal(out.text, "fine");
  assert.equal(calls, 2);
});

test("a parse failure with no failed_generation at all (code output_parse_failed) is retried too", async () => {
  let calls = 0;
  const fetchImpl = async () =>
    ++calls === 1 ? reply(400, { error: { message: "Parsing failed. Please adjust your prompt.", type: "invalid_request_error", code: "output_parse_failed" } }) : ok("fine");
  const out = await callModel({ messages: [{ role: "user", content: "hi" }], fetchImpl, parseBackoffMs: 0 });
  assert.equal(out.text, "fine");
  assert.equal(calls, 2);
});

test("when every primary attempt fails to parse, it retries twice and then uses the fallback", async () => {
  process.env.GROQ_FALLBACK_MODEL = "openai/gpt-oss-20b";
  const models = [];
  const fetchImpl = async (_url, init) => {
    const model = JSON.parse(init.body).model;
    models.push(model);
    return model === "openai/gpt-oss-120b" ? parseFailure() : ok("from fallback");
  };
  const out = await callModel({ messages: [{ role: "user", content: "hi" }], fetchImpl, parseBackoffMs: 0 });
  assert.equal(out.text, "from fallback");
  assert.equal(out.usedFallback, true);
  assert.equal(out.model, "openai/gpt-oss-20b");
  assert.deepEqual(models, ["openai/gpt-oss-120b", "openai/gpt-oss-120b", "openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
});

test("a parse failure on every attempt, with no fallback, surfaces the error", async () => {
  let calls = 0;
  const fetchImpl = async () => (calls++, parseFailure());
  await assert.rejects(callModel({ messages: [], fetchImpl, parseBackoffMs: 0 }), /Groq 400: Parsing failed/);
  assert.equal(calls, 3); // first try + 2 retries
});

test("a plain 400 fails immediately: no retry, no fallback", async () => {
  process.env.GROQ_FALLBACK_MODEL = "openai/gpt-oss-20b";
  let calls = 0;
  const fetchImpl = async () => (calls++, reply(400, { error: { message: "model `nope` does not exist", type: "invalid_request_error", code: "model_not_found" } }));
  await assert.rejects(callModel({ messages: [], fetchImpl, parseBackoffMs: 0 }), /Groq 400: model `nope` does not exist/);
  assert.equal(calls, 1);
});

test("a 400 is logged to stderr with its shape but never the key or message contents", async () => {
  const long = "G".repeat(800);
  const fetchImpl = async () => parseFailure(long);
  const lines = await captureStderr(() =>
    assert.rejects(
      callModel({
        messages: [{ role: "system", content: "SECRET-SYSTEM" }, { role: "user", content: "SECRET-USER" }],
        maxOutputTokens: 100,
        fetchImpl,
        maxParseRetries: 0
      })
    )
  );
  const line = lines.find((l) => l.includes("[multiplayer-ai:groq-error]"));
  assert.ok(line, "an error line was logged");
  assert.match(line, /status=400 type=invalid_request_error code=tool_use_failed messages=2 roles=system,user max_tokens=612/);
  assert.ok(line.includes("G".repeat(500)) && !line.includes("G".repeat(501)), "failed_generation is cut at 500 chars");
  const all = lines.join("\n");
  assert.ok(!all.includes("test-key") && !all.includes("SECRET-SYSTEM") && !all.includes("SECRET-USER"));
});

test("reasoning models get headroom on a small token cap; others get the cap as given", async () => {
  const sent = [];
  const fetchImpl = async (_url, init) => (sent.push(JSON.parse(init.body)), ok("x"));
  await callModel({ messages: [], maxOutputTokens: 400, model: "openai/gpt-oss-20b", fetchImpl });
  await callModel({ messages: [], maxOutputTokens: 400, model: "qwen/qwen3.8-27b", fetchImpl });
  await callModel({ messages: [], fetchImpl });
  assert.equal(sent[0].max_completion_tokens, 912); // 400 + 512 for low-effort reasoning
  assert.equal(sent[0].reasoning_effort, "low");
  assert.equal(sent[1].max_completion_tokens, 400);
  assert.equal(sent[1].reasoning_effort, undefined);
  assert.equal("max_completion_tokens" in sent[2], false);
});

test("normalizeMessages puts system first, drops empties and merges same-role neighbours", () => {
  const out = normalizeMessages([
    { role: "user", content: "a" },
    { role: "system", content: "s1" },
    { role: "user", content: "b" },
    { role: "assistant", content: "  " },
    { role: "system", content: "s2" },
    { role: "assistant", content: "r" }
  ]);
  assert.deepEqual(out, [
    { role: "system", content: "s1\n\ns2" },
    { role: "user", content: "a\n\nb" },
    { role: "assistant", content: "r" }
  ]);
});

test("normalizeMessages leaves an already-clean array alone and does not mutate its input", () => {
  const input = [{ role: "system", content: "s" }, { role: "user", content: "u" }, { role: "assistant", content: "a" }, { role: "user", content: "u2" }];
  const copy = structuredClone(input);
  assert.deepEqual(normalizeMessages(input), input);
  assert.deepEqual(input, copy);
});

// ── Token reporting and MAX_OUTPUT_TOKENS ───────────────────────────

const withUsage = (usage, finish = "stop") =>
  reply(200, { choices: [{ message: { content: "answer" }, finish_reason: finish }], usage });

test("the timing line reports reasoning tokens apart from the visible answer", async () => {
  const lines = await captureStderr(() =>
    callModel({
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: async () =>
        withUsage({ prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 30 } })
    })
  );
  const timing = lines.find((l) => l.includes("[multiplayer-ai:timing]"));
  assert.match(timing, /prompt_tokens=100 output_tokens=20 reasoning_tokens=30 finish=stop/);
});

test("without a reasoning breakdown the output count is the total and reasoning shows as unknown", async () => {
  const lines = await captureStderr(() =>
    callModel({ messages: [{ role: "user", content: "hi" }], fetchImpl: async () => withUsage({ prompt_tokens: 100, completion_tokens: 50 }) })
  );
  assert.match(lines.find((l) => l.includes("[multiplayer-ai:timing]")), /output_tokens=50 reasoning_tokens=\?/);
});

test("a reply cut off at the token limit is logged with what to change", async () => {
  const lines = await captureStderr(() =>
    callModel({
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 100,
      fetchImpl: async () =>
        withUsage({ prompt_tokens: 10, completion_tokens: 612, completion_tokens_details: { reasoning_tokens: 600 } }, "length")
    })
  );
  assert.ok(lines.some((l) => /cut off at the token limit \(max_completion_tokens=612, reasoning used 600\)\. Raise MAX_OUTPUT_TOKENS/.test(l)));
});

test("MAX_OUTPUT_TOKENS caps the visible reply and leaves room for reasoning on top", async () => {
  process.env.PROVIDER = "groq";
  const sent = [];
  const fetchImpl = async (_url, init) => (sent.push(JSON.parse(init.body)), ok("x"));

  process.env.MAX_OUTPUT_TOKENS = "300";
  await callActive({ messages: [], fetchImpl });
  assert.equal(sent[0].max_completion_tokens, 812); // 300 for the answer + 512 for low-effort reasoning

  process.env.GROQ_REASONING_EFFORT = "medium";
  await callActive({ messages: [], fetchImpl });
  assert.equal(sent[1].max_completion_tokens, 1324); // 300 + 1024

  await callActive({ messages: [], maxOutputTokens: 400, fetchImpl }); // an explicit cap (the summary) wins
  assert.equal(sent[2].max_completion_tokens, 1424);

  delete process.env.MAX_OUTPUT_TOKENS;
  await callActive({ messages: [], fetchImpl });
  assert.equal("max_completion_tokens" in sent[3], false, "blank means no cap");
});

test("MAX_OUTPUT_TOKENS ignores anything that is not a positive whole number", () => {
  assert.equal(maxOutputTokensFromEnv("300"), 300);
  for (const bad of [undefined, "", "abc", "0", "-5", "1.5", "NaN"]) assert.equal(maxOutputTokensFromEnv(bad), undefined, String(bad));
});

test("the Gemini adapter leaves thinking room too, by level", () => {
  assert.equal(thinkingHeadroom("minimal"), 128);
  assert.equal(thinkingHeadroom("low"), 512);
  assert.equal(thinkingHeadroom("high"), 2048);
  assert.equal(thinkingHeadroom("none"), 2048, "when the model decides how much to think, leave the most");
});

// ── the optional timeout and test credentials (added with Settings) ──

test("without timeoutMs the request is made exactly as before: no abort signal is attached", async () => {
  let seen;
  const fetchImpl = async (url, init) => ((seen = init), ok("x"));
  await callModel({ messages: [{ role: "user", content: "u" }], fetchImpl });
  assert.equal(seen.signal, undefined);
  assert.equal(seen.redirect, undefined, "and nothing else about the request changed");
  assert.deepEqual(Object.keys(seen).sort(), ["body", "headers", "method"]);
});

test("with timeoutMs a request that does not answer is abandoned, and the error is a timeout", async () => {
  const fetchImpl = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const started = Date.now();
  await assert.rejects(callModel({ messages: [{ role: "user", content: "u" }], fetchImpl, timeoutMs: 100, maxRetries: 0 }), (e) => e.name === "TimeoutError");
  assert.ok(Date.now() - started < 2000);
});

test("through the active provider, that timeout is classified as TIMEOUT with a message that has no upstream text", async () => {
  const fetchImpl = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  process.env.PROVIDER = "groq";
  await assert.rejects(callActive({ messages: [{ role: "user", content: "u" }], fetchImpl, timeoutMs: 100, maxRetries: 0 }), (e) => e.category === "TIMEOUT" && e.name === "ProviderFailure");
});

test("credentials given for a test replace the saved ones for that call only, and never fall back to another model", async () => {
  delete process.env.GROQ_API_KEY;
  process.env.GROQ_FALLBACK_MODEL = "openai/gpt-oss-20b";
  const seen = [];
  const fetchImpl = async (url, init) => (seen.push(JSON.parse(init.body).model + "|" + init.headers.Authorization), reply(503, { error: { message: "busy" } }));
  await assert.rejects(callModel({ messages: [{ role: "user", content: "u" }], fetchImpl, maxRetries: 0, credentials: { apiKey: "candidate-key-0001", model: "m-test" } }));
  assert.deepEqual(seen, ["m-test|Bearer candidate-key-0001"], "one request, with the candidate key, and no fallback model");
  await assert.rejects(callModel({ messages: [], fetchImpl: async () => ok("x") }), (e) => e.category === "NO_KEY", "the candidate key was not kept");
});
