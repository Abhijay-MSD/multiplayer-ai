// Run: node --test test/   (no network, made-up keys, made-up model and organization names)
// The host's terminal keeps the provider's own detail, so the host can see what went wrong, with keys hidden as before and now also
// organization identifiers and the query strings of addresses. The Groq text is the real wording from a failed run, with the model
// and the organization replaced.
import test, { after } from "node:test";
import { keepLoopAlive } from "./helpers/keep-alive.js";
keepLoopAlive();
import assert from "node:assert/strict";
import { toProviderFailure } from "../providers/failure.js";
import { callModel } from "../providers/index.js";
import { registerSecret } from "../secrets.js";
import { makers, cleanup } from "./helpers/stores.js";
import { createLimits } from "../limits.js";

const { createSession } = await import("../tools/create_session.js");
const { stepAgent, setStepDeps } = await import("../tools/step_agent.js");
const { forgetRoom, TOOL_FORMAT_CONFIRMED } = await import("../agent/support.js");

after(cleanup);

const MODEL = "llama-test-70b";
const ORG = "org_01testorganization0000000000";
const KEY = "mask_made_up_key_5c4d3e2f1a0b9c8d";
const GROQ_TEXT = `Rate limit reached for model \`${MODEL}\` in organization \`${ORG}\` service tier \`on_demand\` on tokens per minute (TPM): Limit 8000, Used 5328, Requested 6660. Please try again in 29.91s. Need more tokens? Upgrade to Dev Tier today at https://console.example.test/settings/billing?org=${ORG}&session=abc123`;
const failed = (message, extra = {}) => toProviderFailure(Object.assign(new Error(message), { status: 429, ...extra }), "groq");

test("the organization id in the real Groq text is not in the detail, and the rest of what went wrong still is", () => {
  const f = failed(`Groq 429: ${GROQ_TEXT}`);
  assert.ok(!f.detail.includes(ORG), f.detail);
  assert.ok(!f.detail.includes("01testorganization"), "nor a part of it");
  assert.match(f.detail, /Rate limit reached for model `llama-test-70b` in organization `\[org hidden\]` service tier `on_demand`/);
  assert.match(f.detail, /tokens per minute \(TPM\): Limit 8000, Used 5328, Requested 6660\. Please try again in 29\.91s\./);
});

test("the query string of an address is hidden, and the address and its path stay", () => {
  const f = failed(`Groq 429: ${GROQ_TEXT}`);
  assert.ok(!f.detail.includes("session=abc123"));
  assert.equal(failed(`Upgrade at https://console.example.test/settings/billing?org=${ORG}&session=abc123`).detail, "Upgrade at https://console.example.test/settings/billing?[query hidden]");
  assert.ok(!f.detail.includes("?org="));
  for (const [text, expected] of [
    ["see http://a.example/x?token=abc&b=2 for more", "see http://a.example/x?[query hidden] for more"],
    ["see https://a.example/?x=1.", "see https://a.example/?[query hidden]."],
    ["(https://a.example/p?q=1)", "(https://a.example/p?[query hidden])"],
    ["https://a.example/no-query and https://b.example/q?z=9", "https://a.example/no-query and https://b.example/q?[query hidden]"],
    ["why? because https://a.example/p stays", "why? because https://a.example/p stays"]
  ]) assert.equal(failed(text).detail, expected, text);
});

test("organization identifiers are hidden wherever they turn up: in words, in a path, in a field, after other punctuation", () => {
  for (const text of [`organization ${ORG} is out`, `/v1/organizations/${ORG}/limits`, `{"organization":"${ORG}"}`, `org=${ORG}`, `(${ORG}),`, `${ORG}`, `x_${ORG}`.slice(2), "org_ABC123def456", "ORG_ABC123def456"]) {
    const d = failed(text).detail;
    assert.doesNotMatch(d, /org_[A-Za-z0-9]{3,}/i, `${text} -> ${d}`);
    assert.match(d, /\[org hidden\]/);
  }
  assert.equal(failed("org-2xYz9AbCdEf12345 is the id").detail, "[org hidden] is the id", "the other common shape, org- and letters and digits");
});

test("words that only look a little like an identifier are left alone", () => {
  for (const text of ["the organization is out of tokens", "origin_server failed", "org chart", "gorg_x", "org_", "organization: acme"]) {
    assert.equal(failed(text).detail, text, text);
  }
});

test("keys are still hidden, together with the rest", () => {
  const stop = registerSecret(KEY);
  try {
    const f = failed(`Groq 429: bad ${KEY} in ${ORG} at https://x.example/p?key=${KEY}&org=${ORG}`);
    for (const secret of [KEY, ORG, "key=" + KEY]) assert.ok(!f.detail.includes(secret), f.detail);
    assert.match(f.detail, /\[key hidden\]/);
    assert.match(f.detail, /\[org hidden\]/);
  } finally {
    stop();
  }
});

test("the cut to 300 characters comes after the hiding, so no piece of an identifier is left at the cut", () => {
  const f = failed(`${"x".repeat(285)} ${ORG}`);
  assert.ok(!/org_/i.test(f.detail), f.detail);
  for (let pad = 270; pad < 300; pad++) assert.ok(!/org_[A-Za-z0-9]/i.test(failed(`${"y".repeat(pad)} ${ORG}`).detail), `pad ${pad}`);
});

test("the hint is still read from the whole text, and the room's sentence is unchanged by the hiding", () => {
  const f = failed(`Groq 429: ${GROQ_TEXT}`);
  assert.equal(f.retryAfterSeconds, 30);
  assert.equal(f.message, "The model provider is limiting how fast this key can be used. Try again in about 30 seconds.");
});

// ── what the terminal prints ─────────────────────────────────────────

test("the line the host's terminal gets for a failed step: the category, the status, the detail without the organization or the query, and the wait", async () => {
  const store = await makers.memory();
  const d = { db: store, trigger: () => {}, limits: createLimits({ env: {}, local: true }), budget: { claim: () => ({}) } };
  const room = await createSession({ task: "Write a long report", creator_name: "Maya" }, d);
  forgetRoom(room.session_id);
  process.env.GROQ_API_KEY = KEY;
  setStepDeps({
    db: store, summarize: async () => {}, provider: () => "groq", toolFormats: TOOL_FORMAT_CONFIRMED,
    call: (args) => callModel({ ...args, provider: "groq", maxRetries: 0, maxParseRetries: 0, fetchImpl: async () => new Response(JSON.stringify({ error: { message: GROQ_TEXT, type: "tokens", code: "rate_limit_exceeded" } }), { status: 429, headers: { "Content-Type": "application/json" } }) })
  });
  const printed = [];
  const orig = console.error;
  console.error = (...a) => printed.push(a.join(" "));
  try {
    await assert.rejects(stepAgent({ session_id: room.session_id, token: room.token }));
  } finally {
    console.error = orig;
  }
  const out = printed.join("\n");
  assert.ok(!out.includes(ORG), `the terminal output holds the organization:\n${out}`);
  assert.ok(!out.includes("01testorganization"));
  assert.ok(!out.includes("session=abc123") && !out.includes("?org="), "nor the query string");
  assert.ok(!out.includes(KEY), "nor the key");
  const line = printed.find((l) => /step failed for/.test(l));
  assert.ok(line, out);
  assert.match(line, /NO_QUOTA \(status 429\)/);
  assert.match(line, /Please try again in 29\.91s/);
  assert.match(line, /\[org hidden\]/);
  assert.match(line, /retry after 30 s/, "and the wait, as the host would want to read it");
  const events = JSON.stringify(await store.listEvents(room.session_id));
  assert.ok(!events.includes(ORG) && !events.includes("billing"), "the room never had any of it");
});
