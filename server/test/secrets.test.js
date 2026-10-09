// Run: node --test test/   (no network)
// Hiding keys: in text, in errors, and in everything the console prints.
import test from "node:test";
import assert from "node:assert/strict";
import { createSettings, setSettings } from "../settings.js";
import { redact, redactError, registerSecret, installLogRedaction, MASK } from "../secrets.js";

const KEY = "gsk_made_up_key_for_the_redaction_test_7Q9x";

const withSettings = (env, fn) => {
  setSettings(createSettings({ env }));
  try {
    return fn();
  } finally {
    setSettings(createSettings({ dir: null }));
  }
};

test("a key from the environment is hidden wherever it appears, in each form it turns up in", () => {
  withSettings({ GROQ_API_KEY: KEY }, () => {
    for (const text of [
      `plain ${KEY} here`,
      `url-encoded ${encodeURIComponent(KEY)}`,
      `inside json ${JSON.stringify({ k: KEY })}`,
      `base64 ${Buffer.from(KEY).toString("base64")}`,
      `${KEY}${KEY}`
    ]) {
      const out = redact(text);
      assert.ok(!out.includes(KEY) && !out.includes(Buffer.from(KEY).toString("base64")), out);
      assert.ok(out.includes(MASK), out);
    }
  });
});

test("a key being tested is hidden until the test is over", () => {
  const candidate = "AIzaSy_candidate_key_not_saved_yet_0000";
  assert.equal(redact(`x ${candidate}`), `x ${candidate}`, "unknown to this copy, so nothing to hide");
  const forget = registerSecret(candidate);
  assert.ok(!redact(`x ${candidate}`).includes(candidate));
  forget();
  assert.ok(redact(`x ${candidate}`).includes(candidate));
});

test("a saved key is hidden too", () => {
  setSettings(createSettings({ dir: null }));
  const settings = createSettings({ dir: null });
  settings.saveKey("groq", KEY);
  setSettings(settings);
  try {
    assert.ok(!redact(`leak: ${KEY}`).includes(KEY));
  } finally {
    setSettings(createSettings({ dir: null }));
  }
});

test("the usual ways a key is echoed are hidden even when the key itself is not known", () => {
  const unknown = "tok_unknown_value_abcdefghij";
  for (const text of [
    `Authorization: Bearer ${unknown}`,
    `{"authorization":"Bearer ${unknown}"}`,
    `x-goog-api-key: ${unknown}`,
    `https://example.test/v1/models?key=${unknown}&alt=json`,
    `api_key=${unknown}`,
    `"apiKey": "${unknown}"`
  ]) {
    assert.ok(!redact(text).includes(unknown), `${text} -> ${redact(text)}`);
  }
});

test("ordinary text is left alone, including short words that look like part of a key", () => {
  withSettings({ GROQ_API_KEY: "abc" }, () => {
    const text = "The abc agent replied: a plan for the trip, key points first.";
    assert.equal(redact(text), text, "a secret under 8 characters would match ordinary words, so it is not used");
  });
  assert.equal(redact("Rate limit reached for model gpt-oss in organization org-123"), "Rate limit reached for model gpt-oss in organization org-123");
});

test("an error's message and stack are cleaned in place, along with its cause", () => {
  withSettings({ GROQ_API_KEY: KEY }, () => {
    const e = new Error(`bad: ${KEY}`, { cause: new Error(`inner ${KEY}`) });
    redactError(e);
    assert.ok(!e.message.includes(KEY) && !e.stack.includes(KEY) && !e.cause.message.includes(KEY) && !e.cause.stack.includes(KEY));
  });
});

test("with log redaction installed, nothing printed by the console contains a key, however it is passed", () => {
  const lines = [];
  const fake = { log: (...a) => lines.push(a), info: (...a) => lines.push(a), warn: (...a) => lines.push(a), error: (...a) => lines.push(a), debug: (...a) => lines.push(a) };
  withSettings({ GROQ_API_KEY: KEY }, () => {
    const uninstall = installLogRedaction(fake);
    fake.error(`as text ${KEY}`);
    fake.error("with format %s", KEY);
    fake.error(new Error(`as error ${KEY}`));
    fake.warn({ nested: { header: `Bearer ${KEY}` } });
    fake.log("fine", 42, { harmless: true });
    assert.ok(!JSON.stringify(lines, (k, v) => (v instanceof Error ? v.message + v.stack : v)).includes(KEY));
    assert.deepEqual(lines.at(-1), ["fine", 42, { harmless: true }], "unrelated output is untouched");
    assert.equal(installLogRedaction(fake), uninstall, "installing twice does not stack");
    uninstall();
    fake.error(KEY);
    assert.equal(lines.at(-1)[0], KEY, "uninstalled: the console is as it was");
  });
});
