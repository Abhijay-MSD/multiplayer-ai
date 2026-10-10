// Run: node --test test/   (no network, made-up keys, made-up model and organization names)
// How long a provider says to wait, read from a failed call and carried as a whole number of seconds on the failure. The
// Groq wording below is the real text from a failed run, with the model and organization replaced. The other providers'
// wording is NOT confirmed against their services (see docs/providers.md): those tests run against stand-ins only.
import test from "node:test";
import { keepLoopAlive } from "./helpers/keep-alive.js";
keepLoopAlive();
import assert from "node:assert/strict";
import * as failure from "../providers/failure.js";
import { callModel } from "../providers/index.js";

const MODEL = "llama-test-70b";
const ORG = "org_01testorganization0000000000";
const GROQ_TEXT = `Rate limit reached for model \`${MODEL}\` in organization \`${ORG}\` service tier \`on_demand\` on tokens per minute (TPM): Limit 8000, Used 5328, Requested 6660. Please try again in 29.91s. Need more tokens? Upgrade to Dev Tier today at https://console.example.test/settings/billing?org=${ORG}`;
const NOW = Date.parse("2026-10-21T07:00:00Z");
const hint = (o) => failure.hintFrom({ now: NOW, ...o });

// ── the wording, one test each ───────────────────────────────────────

test("the real Groq wording: 'Please try again in 29.91s' is 30 seconds, rounded up", () => {
  assert.equal(hint({ text: `Groq 429: ${GROQ_TEXT}` }), 30);
});
for (const [wording, text, seconds] of [
  ["a whole number of seconds", "Please try again in 7s.", 7],
  ["seconds with a fraction, rounded up", "Please try again in 0.2s.", 1],
  ["milliseconds, rounded up to a second", "Please try again in 850ms.", 1],
  ["many milliseconds", "Please try again in 4200ms.", 5],
  ["minutes and seconds with a fraction", "Please try again in 1m4.2s.", 65],
  ["minutes alone", "Please try again in 2m.", 120],
  ["minutes and seconds", "Please try again in 6m0s.", 360],
  ["hours, minutes and seconds, which is over the hour and so no hint", "Please try again in 1h2m3s.", null],
  ["an hour exactly", "Please try again in 1h.", 3600],
  ["just under an hour", "Please try again in 59m59.5s.", 3600],
  ["spaces and long unit names", "try again in 2 minutes 30 seconds", 150],
  ["retry in", "Retry in 12s", 12],
  ["retry after", "You can retry after 9 seconds.", 9],
  ["upper case", "PLEASE TRY AGAIN IN 3S", 3],
  ["a retryDelay field in a JSON body", '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"30s"}]}}', 30],
  ["a retryDelay with a fraction", '{"retryDelay":"0.5s"}', 1],
  ["a retryDelay of exactly an hour", '{"retryDelay":"3600s"}', 3600],
  ["a retryDelay inside text that was itself JSON-escaped", 'details: [{\\"retryDelay\\":\\"41s\\"}]', 41],
  ["a delay of nothing", "Please try again in 0s.", 0]
]) {
  test(`wording: ${wording}`, () => assert.equal(hint({ text }), seconds, text));
}

test("wording with no time in it is no hint", () => {
  for (const text of ["", "rate limited", "Please try again in a moment.", "try again later", "Limit 8000, Used 5328, Requested 6660", "try again in s", "try again in 5 parsecs", undefined, null, 42]) {
    assert.equal(hint({ text }), null, String(text));
  }
});

test("a hint over an hour, or below nothing, or not a number is ignored", () => {
  assert.equal(hint({ text: "try again in 3601s" }), null);
  assert.equal(hint({ text: "try again in 2h" }), null);
  assert.equal(hint({ text: '{"retryDelay":"7200s"}' }), null);
  assert.equal(hint({ header: "-5" }), null);
  assert.equal(hint({ header: "NaN" }), null);
  assert.equal(hint({ header: "Infinity" }), null);
  assert.equal(hint({ header: "soon" }), null);
  assert.equal(hint({ header: "99999" }), null);
  assert.equal(hint({ header: "" }), null);
  assert.equal(hint({ header: null }), null);
  assert.equal(hint({ text: "try again in -5s" }), null, "a minus sign is not part of the wording");
});

// ── the header ───────────────────────────────────────────────────────

test("Retry-After in seconds", () => {
  assert.equal(hint({ header: "30" }), 30);
  assert.equal(hint({ header: " 7 " }), 7);
  assert.equal(hint({ header: "29.91" }), 30);
  assert.equal(hint({ header: "0" }), 0);
  assert.equal(hint({ header: "3600" }), 3600);
});

test("Retry-After as an HTTP date is the time until then, rounded up", () => {
  assert.equal(hint({ header: "Wed, 21 Oct 2026 07:00:45 GMT" }), 45);
  assert.equal(hint({ header: new Date(NOW + 45_200).toUTCString() }), 45, "an HTTP date has whole seconds");
  assert.equal(hint({ header: "Wed, 21 Oct 2026 07:02:00 GMT" }), 120);
  assert.equal(hint({ header: "Wed, 21 Oct 2026 08:00:01 GMT" }), null, "more than an hour away");
  assert.equal(hint({ header: "Wed, 21 Oct 2026 06:59:00 GMT" }), null, "a date already past is below nothing");
});

test("the header wins over the text when both are there", () => {
  assert.equal(hint({ header: "10", text: GROQ_TEXT }), 10);
  assert.equal(hint({ header: "Wed, 21 Oct 2026 07:00:20 GMT", text: GROQ_TEXT }), 20);
});

test("a header that is not usable is no hint of its own, and the text is read instead", () => {
  assert.equal(hint({ header: "soon", text: GROQ_TEXT }), 30);
  assert.equal(hint({ header: "99999", text: GROQ_TEXT }), 30);
  assert.equal(hint({ header: "-1", text: "try again in 8s" }), 8);
});

test("a duration is read the same wherever it turns up", () => {
  assert.equal(failure.parseDuration("1h2m3s"), 3723);
  assert.equal(failure.parseDuration("1m4.2s"), 64.2);
  assert.equal(failure.parseDuration("850ms"), 0.85);
  assert.equal(failure.parseDuration("2m"), 120);
  assert.equal(failure.parseDuration("30s"), 30);
  assert.equal(failure.parseDuration("soon"), null);
});

// ── every adapter carries it on the failure ──────────────────────────

const KEY = "hint_made_up_key_5c4d3e2f1a0b9c8d";
const ENV = { groq: "GROQ_API_KEY", claude: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY", compat: "OPENAI_COMPAT_API_KEY" };
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
// How each provider words an error. `retryInfo` is the Gemini way of saying how long.
const ERRORS = {
  groq: (m) => ({ error: { message: m, type: "tokens", code: "rate_limit_exceeded" } }),
  compat: (m) => ({ error: { message: m } }),
  claude: (m) => ({ type: "error", error: { type: "rate_limit_error", message: m } }),
  gemini: (m, retryDelay) => ({ error: { code: 429, message: m, status: "RESOURCE_EXHAUSTED", details: retryDelay ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }] : [] } })
};
const PREFIX = { groq: "Groq 429: ", compat: "", claude: "", gemini: "" };

async function failWith(provider, response, extra = {}) {
  for (const v of Object.values(ENV)) delete process.env[v];
  delete process.env.MAX_OUTPUT_TOKENS;
  process.env[ENV[provider]] = KEY;
  if (provider === "compat") Object.assign(process.env, { OPENAI_COMPAT_BASE_URL: "https://api.example.test/v1", OPENAI_COMPAT_MODEL: "m1" });
  const stand = async () => response();
  const saved = globalThis.fetch;
  if (provider === "gemini") globalThis.fetch = stand;
  const err = console.error;
  console.error = () => {};
  try {
    return await callModel({ provider, messages: [{ role: "user", content: "hi" }], fetchImpl: stand, maxRetries: 0, maxParseRetries: 0, ...extra }).then(
      () => assert.fail("the call should have failed"),
      (e) => e
    );
  } finally {
    console.error = err;
    globalThis.fetch = saved;
  }
}

for (const provider of ["groq", "compat", "claude"]) {
  test(`${provider}: a Retry-After header becomes retryAfterSeconds on the failure`, async () => {
    const f = await failWith(provider, () => json(429, ERRORS[provider]("slow down"), { "Retry-After": "17" }));
    assert.equal(f.category, "NO_QUOTA");
    assert.equal(f.retryAfterSeconds, 17);
  });
  test(`${provider}: an HTTP-date Retry-After becomes whole seconds`, async () => {
    const f = await failWith(provider, () => json(429, ERRORS[provider]("slow down"), { "Retry-After": new Date(Date.now() + 40_500).toUTCString() }));
    assert.ok(f.retryAfterSeconds >= 39 && f.retryAfterSeconds <= 41, `${f.retryAfterSeconds}`);
    assert.ok(Number.isInteger(f.retryAfterSeconds));
  });
  test(`${provider}: with no header the wording of the error is read`, async () => {
    const f = await failWith(provider, () => json(429, ERRORS[provider](`${PREFIX[provider] === "Groq 429: " ? "" : ""}${GROQ_TEXT}`)));
    assert.equal(f.retryAfterSeconds, 30);
  });
  test(`${provider}: an error with no hint at all has retryAfterSeconds null`, async () => {
    const f = await failWith(provider, () => json(429, ERRORS[provider]("slow down")));
    assert.equal(f.retryAfterSeconds, null);
  });
  test(`${provider}: a header over an hour is ignored`, async () => {
    const f = await failWith(provider, () => json(429, ERRORS[provider]("slow down"), { "Retry-After": "7200" }));
    assert.equal(f.retryAfterSeconds, null);
  });
}

test("groq: the exact wording from the failed run, with a made-up model and organization, gives 30", async () => {
  const f = await failWith("groq", () => json(429, ERRORS.groq(GROQ_TEXT)));
  assert.equal(f.category, "NO_QUOTA");
  assert.equal(f.retryAfterSeconds, 30);
});

test("claude: a header carries it even when the body has other words", async () => {
  const f = await failWith("claude", () => json(429, ERRORS.claude("This request would exceed the rate limit for your organization"), { "retry-after": "12" }));
  assert.equal(f.retryAfterSeconds, 12);
});

test("gemini: a retryDelay in the error's details becomes retryAfterSeconds", async () => {
  const f = await failWith("gemini", () => json(429, ERRORS.gemini("Quota exceeded for metric generate_content_input_token_count per minute", "30s")));
  assert.equal(f.category, "NO_QUOTA");
  assert.equal(f.retryAfterSeconds, 30);
});

test("gemini: 'Please retry in 41.5s' in the message is read too, and no details means no hint", async () => {
  assert.equal((await failWith("gemini", () => json(429, ERRORS.gemini("Quota exceeded. Please retry in 41.5s.")))).retryAfterSeconds, 42);
  assert.equal((await failWith("gemini", () => json(429, ERRORS.gemini("Quota exceeded.")))).retryAfterSeconds, null);
});

test("a failure that is not a rate limit can carry a hint too, but nothing else about it changes", async () => {
  const f = await failWith("compat", () => json(503, ERRORS.compat("overloaded"), { "Retry-After": "5" }));
  assert.equal(f.category, "BUSY");
  assert.equal(f.retryAfterSeconds, 5);
  assert.equal(f.message, failure.CATEGORY_MESSAGES.BUSY);
});

test("the failure object always has the field: a whole number or null", async () => {
  const f = await failWith("groq", () => json(401, ERRORS.groq("bad key")));
  assert.ok("retryAfterSeconds" in f);
  assert.equal(f.retryAfterSeconds, null);
  assert.equal(new failure.ProviderFailure("UNKNOWN").retryAfterSeconds, null);
});

test("retries are the ones the adapters already made: a hint does not add or remove one", async () => {
  let calls = 0;
  const stand = async () => (calls++, json(429, ERRORS.compat("slow"), { "Retry-After": "1" }));
  for (const v of Object.values(ENV)) delete process.env[v];
  Object.assign(process.env, { OPENAI_COMPAT_API_KEY: KEY, OPENAI_COMPAT_BASE_URL: "https://api.example.test/v1", OPENAI_COMPAT_MODEL: "m1" });
  const err = console.error;
  console.error = () => {};
  try {
    await assert.rejects(callModel({ provider: "compat", messages: [{ role: "user", content: "hi" }], fetchImpl: stand, maxRetries: 1 }));
  } finally {
    console.error = err;
  }
  assert.equal(calls, 2, "one try and one retry, as maxRetries says");
});

// ── the docs say what is and is not confirmed ────────────────────────

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const providersDoc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../docs/providers.md"), "utf8").replace(/\s+/g, " ");

test("docs/providers.md says how the wait is read, and that only the Groq wording is a real one", () => {
  assert.match(providersDoc, /How long to wait/);
  assert.match(providersDoc, /Retry-After/);
  assert.match(providersDoc, /try again in 29\.91s/);
  assert.match(providersDoc, /retryDelay/);
  assert.match(providersDoc, /Only the Groq wording[^.]*comes from a real failed run/i);
  for (const who of ["Claude", "Gemini", "OpenAI-compatible"]) assert.match(providersDoc, new RegExp(`${who}[^|]*(NOT CONFIRMED|unconfirmed)`, "i"), who);
  assert.match(providersDoc, /tested only against stand-ins/i);
  assert.match(providersDoc, /Gemini[^.]*does not (?:show|give|expose) (?:us )?(?:the |its )?(?:response )?headers/i);
});
