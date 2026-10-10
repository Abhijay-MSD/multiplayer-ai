// Run: node --test test/   (no network, made-up keys, made-up model and organization names)
// What the room is told when a provider limits the key: one of two sentences, never the provider's own words, a model name, an
// organization id, an account detail or an address. The Groq text is the real wording from a failed run, with the model and the
// organization replaced.
import test, { after } from "node:test";
import { keepLoopAlive } from "./helpers/keep-alive.js";
keepLoopAlive();
import assert from "node:assert/strict";
import * as failure from "../providers/failure.js";
import { callModel } from "../providers/index.js";
import { makers, cleanup } from "./helpers/stores.js";
import { createLimits } from "../limits.js";

const { createSession } = await import("../tools/create_session.js");
const { stepAgent, setStepDeps } = await import("../tools/step_agent.js");
const { forgetRoom, TOOL_FORMAT_CONFIRMED } = await import("../agent/support.js");

after(cleanup);

const MODEL = "llama-test-70b";
const ORG = "org_01testorganization0000000000";
const URL_IN_TEXT = `https://console.example.test/settings/billing?org=${ORG}`;
const GROQ_TEXT = `Rate limit reached for model \`${MODEL}\` in organization \`${ORG}\` service tier \`on_demand\` on tokens per minute (TPM): Limit 8000, Used 5328, Requested 6660. Please try again in 29.91s. Need more tokens? Upgrade to Dev Tier today at ${URL_IN_TEXT}`;
const FAST = (n) => `The model provider is limiting how fast this key can be used. Try again in about ${n} ${n === 1 ? "second" : "seconds"}.`;
const SLOW = "The model provider is limiting this key. Check the provider's console for the limit, then try again.";
const KEY = "limit_made_up_key_5c4d3e2f1a0b9c8d";
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const rateLimited = (message, headers) => () => json(429, { error: { message, type: "tokens", code: "rate_limit_exceeded" } }, headers);

async function fail(respond, provider = "groq") {
  const env = { groq: "GROQ_API_KEY", claude: "ANTHROPIC_API_KEY", compat: "OPENAI_COMPAT_API_KEY" }[provider];
  for (const v of ["GROQ_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_COMPAT_API_KEY"]) delete process.env[v];
  process.env[env] = KEY;
  if (provider === "compat") Object.assign(process.env, { OPENAI_COMPAT_BASE_URL: "https://api.example.test/v1", OPENAI_COMPAT_MODEL: "m1" });
  const err = console.error;
  console.error = () => {};
  try {
    return await callModel({ provider, messages: [{ role: "user", content: "hi" }], fetchImpl: async () => respond(), maxRetries: 0, maxParseRetries: 0 }).then(() => assert.fail("it should fail"), (e) => e);
  } finally {
    console.error = err;
  }
}

test("a wait of 120 seconds or less is said in seconds, one second in the singular", async () => {
  assert.equal((await fail(rateLimited(GROQ_TEXT))).message, FAST(30), "the real wording: 29.91s");
  assert.equal((await fail(rateLimited("slow"), "groq")).message, SLOW, "no hint: the longer sentence");
  assert.equal((await fail(rateLimited("Please try again in 850ms."))).message, FAST(1));
  assert.equal((await fail(rateLimited("slow", { "Retry-After": "1" }))).message, FAST(1));
  assert.equal((await fail(rateLimited("slow", { "Retry-After": "0" }))).message, FAST(1), "a wait of nothing is still said as one second, never 0");
  assert.equal((await fail(rateLimited("Please try again in 2m."))).message, FAST(120), "120 seconds is still short");
  assert.equal((await fail(rateLimited("Please try again in 1m4.2s."))).message, FAST(65));
});

test("a wait over 120 seconds, or none, is the longer sentence, which sends the host to the provider's console", async () => {
  assert.equal((await fail(rateLimited("Please try again in 2m1s."))).message, SLOW);
  assert.equal((await fail(rateLimited("Please try again in 6m0s."))).message, SLOW);
  assert.equal((await fail(rateLimited("slow", { "Retry-After": "121" }))).message, SLOW);
  assert.equal((await fail(rateLimited("slow", { "Retry-After": "7200" }))).message, SLOW, "an hint over an hour is no hint");
  assert.equal((await fail(rateLimited("slow"))).message, SLOW);
  assert.equal(failure.CATEGORY_MESSAGES.NO_QUOTA, SLOW);
});

test("a daily or monthly limit, or a billing or credit problem, is never called a short wait, whatever the hint", async () => {
  for (const text of [
    "Rate limit reached on tokens per day (TPD): Limit 100000, Used 99000. Please try again in 1m30s.",
    "Rate limit reached on requests per day (RPD). Please try again in 45s.",
    "You have reached your monthly limit. Please try again in 30s.",
    "Quota exceeded for metric generate_content_free_tier_requests, limit: 0 PerDay. retry in 20s",
    "Quota exceeded for quota metric GenerateRequestsPerMonthPerProject. Please retry in 20s.",
    "You exceeded your current quota, please check your plan and billing details. Try again in 10s.",
    "Your credit balance is too low to access the API. Please try again in 10s.",
    "Insufficient_quota: add a payment method. try again in 10s",
    "Monthly spend limit reached, try again in 10s"
  ]) {
    const f = await fail(rateLimited(text));
    assert.equal(f.message, SLOW, text);
    assert.equal(f.category, "NO_QUOTA", "the category is the same as ever");
  }
  // The same words in a header do not make it a short wait either.
  assert.equal((await fail(rateLimited("You have reached your daily limit.", { "Retry-After": "30" }))).message, SLOW);
});

test("the word billing in an address, which the real per-minute text ends with, does not make it a long wait", async () => {
  assert.ok(GROQ_TEXT.includes("billing"), "the stand-in ends the way the real text does");
  assert.equal((await fail(rateLimited(GROQ_TEXT))).message, FAST(30));
});

test("the room's sentence holds none of the provider's words: no model, organization, address, limit figures or tier", async () => {
  for (const provider of ["groq", "compat", "claude"]) {
    for (const make of [() => rateLimited(GROQ_TEXT), () => rateLimited(GROQ_TEXT, { "Retry-After": "400" }), () => rateLimited(`daily: ${GROQ_TEXT}`)]) {
      const f = await fail(make(), provider);
      for (const secret of [MODEL, ORG, "org_", "http", "console.example", "billing", "8000", "5328", "6660", "on_demand", "TPM", "Dev Tier", "organization", "Groq", "29.91", KEY]) {
        assert.ok(!f.message.includes(secret), `${provider}: "${f.message}" holds ${secret}`);
      }
      assert.ok(f.message === SLOW || /^The model provider is limiting how fast this key can be used\. Try again in about \d+ seconds?\.$/.test(f.message), f.message);
    }
  }
});

test("a bad key, a missing model and a busy provider keep their own sentences, and a 429 is still NO_QUOTA", async () => {
  assert.equal((await fail(() => json(401, { error: { message: "no" } }))).message, failure.CATEGORY_MESSAGES.BAD_KEY);
  assert.equal((await fail(() => json(404, { error: { message: "no" } }))).message, failure.CATEGORY_MESSAGES.MODEL_NOT_FOUND);
  assert.equal((await fail(() => json(503, { error: { message: "busy" } }, { "Retry-After": "5" }))).message, failure.CATEGORY_MESSAGES.BUSY);
  assert.equal((await fail(rateLimited(GROQ_TEXT))).category, "NO_QUOTA");
  assert.equal(failure.CATEGORY_MESSAGES.BAD_KEY, "The model provider didn't accept the API key. The host needs to check it in Settings.");
});

test("a failure built by hand: the sentence follows the hint it is given", () => {
  assert.equal(new failure.ProviderFailure("NO_QUOTA", { retryAfterSeconds: 30 }).message, FAST(30));
  assert.equal(new failure.ProviderFailure("NO_QUOTA", { retryAfterSeconds: 30, longTerm: true }).message, SLOW);
  assert.equal(new failure.ProviderFailure("NO_QUOTA", { retryAfterSeconds: 121 }).message, SLOW);
  assert.equal(new failure.ProviderFailure("NO_QUOTA", { retryAfterSeconds: null }).message, SLOW);
  assert.equal(new failure.ProviderFailure("BUSY", { retryAfterSeconds: 30 }).message, failure.CATEGORY_MESSAGES.BUSY);
  assert.equal(new failure.ProviderFailure("NO_QUOTA", { retryAfterSeconds: 30 }).retryAfterSeconds, 30, "the number is still there for whoever asks");
  assert.equal(failure.rateLimitLine(30), FAST(30));
  assert.equal(failure.SHORT_WAIT_SECONDS, 120);
});

// ── in the room ──────────────────────────────────────────────────────

for (const kind of ["memory", "sqlite"]) {
  async function world(respond, provider = "groq") {
    const store = await makers[kind]();
    const d = { db: store, trigger: () => {}, limits: createLimits({ env: {}, local: true }), budget: { claim: () => ({}) } };
    const room = await createSession({ task: "Write a long report", creator_name: "Maya" }, d);
    forgetRoom(room.session_id);
    setStepDeps({
      db: store, summarize: async () => {}, provider: () => provider, toolFormats: TOOL_FORMAT_CONFIRMED,
      call: async (args) => { for (const v of ["GROQ_API_KEY"]) process.env[v] = KEY; return callModel({ ...args, provider, fetchImpl: async () => respond(), maxRetries: 0, maxParseRetries: 0 }); }
    });
    const lines = async () => (await store.listEvents(room.session_id)).filter((e) => e.kind === "status").map((e) => e.content);
    return { store, id: room.session_id, token: room.token, lines };
  }

  test(`[${kind}] the room is told the wait, in the usual "Agent could not reply" line, and nothing of the provider's text is stored anywhere`, async () => {
    const w = await world(rateLimited(GROQ_TEXT));
    const err = console.error;
    const printed = [];
    console.error = (...a) => printed.push(a.join(" "));
    try {
      await assert.rejects(stepAgent({ session_id: w.id, token: w.token }));
    } finally {
      console.error = err;
    }
    assert.deepEqual(await w.lines(), [`Agent could not reply: ${FAST(30)}`]);
    const everything = JSON.stringify(await w.store.listEvents(w.id));
    for (const secret of [MODEL, ORG, "console.example", "on_demand", "8000", KEY]) assert.ok(!everything.includes(secret), `the room holds ${secret}`);
    assert.ok(printed.some((l) => /step failed/.test(l)), "and the host's terminal says it failed");
  });

  test(`[${kind}] a long or unknown wait is the longer line`, async () => {
    for (const make of [() => rateLimited("slow"), () => rateLimited("slow", { "Retry-After": "600" }), () => rateLimited("tokens per day (TPD). try again in 10s")]) {
      const w = await world(make());
      const err = console.error;
      console.error = () => {};
      try {
        await assert.rejects(stepAgent({ session_id: w.id, token: w.token }));
      } finally {
        console.error = err;
      }
      assert.deepEqual(await w.lines(), [`Agent could not reply: ${SLOW}`]);
    }
  });
}
