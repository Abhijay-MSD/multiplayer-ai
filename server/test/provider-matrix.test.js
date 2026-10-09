// Run: node --test test/   (no network, made-up keys)
// Every provider, against the same set of things going wrong. Whatever the provider, a failed reply must reach the room
// as the same few categories, must not carry the provider's own words, and must not leak the key anywhere, even when the
// provider's error repeats the key back. The requests are stood in for, so nothing here shows what a real provider does.
import test from "node:test";
import { keepLoopAlive } from "./helpers/keep-alive.js";
keepLoopAlive();
import assert from "node:assert/strict";
import { callModel } from "../providers/index.js";
import { CATEGORY_MESSAGES } from "../providers/failure.js";
import { registerSecret, redact } from "../secrets.js";

const KEY = "matrix_made_up_key_5c4d3e2f1a0b9c8d";
const ACCOUNT = "acme-corp-account-4471";
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// How each provider words a success and an error. `error` gets the text the provider "chose" to say.
const SHAPES = {
  groq: { ok: (t) => ({ choices: [{ message: { content: t } }] }), error: (m) => ({ error: { message: m } }) },
  compat: { ok: (t) => ({ choices: [{ message: { content: t } }] }), error: (m) => ({ error: { message: m } }) },
  claude: { ok: (t) => ({ content: [{ type: "text", text: t }], usage: { input_tokens: 1, output_tokens: 1 } }), error: (m) => ({ type: "error", error: { type: "api_error", message: m } }) },
  gemini: { ok: (t) => ({ candidates: [{ content: { parts: [{ text: t }] }, finishReason: "STOP" }] }), error: (m) => ({ error: { message: m } }) }
};

function setup(provider) {
  const env = { groq: "GROQ_API_KEY", claude: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY", compat: "OPENAI_COMPAT_API_KEY" }[provider];
  for (const v of ["GROQ_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_COMPAT_API_KEY", "GROQ_FALLBACK_MODEL", "GEMINI_FALLBACK_MODEL"]) delete process.env[v];
  process.env[env] = KEY;
  if (provider === "compat") Object.assign(process.env, { OPENAI_COMPAT_BASE_URL: "https://api.example.test/v1", OPENAI_COMPAT_MODEL: "m1" });
}

/** Runs one reply through `provider`, with the network standing in as `respond(url, init)`. */
async function reply(provider, respond, extra = {}) {
  setup(provider);
  const seen = [];
  const stand = async (url, init) => (seen.push({ url: String(url), init }), respond(String(url), init));
  const saved = globalThis.fetch;
  if (provider === "gemini") globalThis.fetch = stand;
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try {
    const out = await callModel({ provider, messages: [{ role: "user", content: "hello" }], fetchImpl: stand, maxRetries: 0, maxParseRetries: 0, ...extra }).then(
      (v) => ({ value: v }),
      (e) => ({ error: e })
    );
    return { ...out, seen, lines };
  } finally {
    console.error = orig;
    globalThis.fetch = saved;
  }
}

const PROVIDERS = ["groq", "gemini", "claude", "compat"];

for (const provider of PROVIDERS) {
  const shape = SHAPES[provider];
  const upstream = (status, message = "upstream says no") => () => json(status, shape.error(message));

  test(`${provider}: a good answer comes back as text`, async () => {
    const r = await reply(provider, () => json(200, shape.ok("fine, thanks")));
    assert.equal(r.value?.text, "fine, thanks", r.error?.detail);
  });

  const cases = [
    ["a key the provider refuses (401)", upstream(401), "BAD_KEY"],
    ["a key without permission (403)", upstream(403), "BAD_KEY"],
    ["too many requests (429)", upstream(429), "NO_QUOTA"],
    ["the provider down (503)", upstream(503), "BUSY"],
    ["the provider failing (500)", upstream(500), "BUSY"],
    ["a model that doesn't exist (404)", upstream(404), "MODEL_NOT_FOUND"],
    ["the connection dropped", () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); }, "NETWORK"],
    ["no way to reach the provider", () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); }, "NETWORK"]
  ];
  for (const [what, respond, category] of cases) {
    test(`${provider}: ${what} reaches the room as ${category}, in the category's own words`, async () => {
      const r = await reply(provider, respond);
      assert.ok(r.error, "it fails");
      assert.equal(r.error.category, category, r.error.detail);
      assert.equal(r.error.message, CATEGORY_MESSAGES[category]);
    });
  }

  test(`${provider}: a request that never answers fails as TIMEOUT`, async () => {
    const r = await reply(provider, (_url, init) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal.reason ?? new Error("aborted")))), { timeoutMs: 40 });
    assert.equal(r.error?.category, "TIMEOUT", r.error?.detail);
  });

  test(`${provider}: when the provider's error repeats the key and an account name, neither the room's message, the detail nor the terminal has the key`, async () => {
    const forget = registerSecret(KEY);
    try {
      for (const status of [400, 401, 500]) {
        const r = await reply(provider, (_u, init) => json(status, shape.error(`Rejected for ${ACCOUNT}. You sent ${JSON.stringify(init?.headers ?? {})} and ${init?.body ?? ""}`)));
        assert.ok(r.error, `status ${status}: it fails`);
        const everything = [r.error.message, r.error.detail, ...r.lines, redact(r.error.stack ?? "")].join("\n");
        assert.ok(!everything.includes(KEY), `status ${status}: the key is in what the room, the detail or the terminal got`);
        assert.ok(!r.error.message.includes(ACCOUNT), "the room's message is only the category's");
      }
    } finally {
      forget();
    }
  });

  test(`${provider}: the key is only ever in a header or the request's own setup, never in an address`, async () => {
    const r = await reply(provider, () => json(200, shape.ok("x")));
    for (const s of r.seen) assert.ok(!s.url.includes(KEY), `${s.url.slice(0, 60)} holds the key`);
  });
}

test("a provider that is not set up says so, for each provider", async () => {
  for (const provider of ["groq", "gemini", "claude"]) {
    setup(provider);
    for (const v of ["GROQ_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"]) delete process.env[v];
    const r = await callModel({ provider, messages: [], fetchImpl: async () => json(200, {}) }).catch((e) => e);
    assert.equal(r.category, "NO_KEY", provider);
  }
});
