// Run: node --test test/   (no network, no real model)
// Saved settings: where they live, who can read the file, what overrides what, and
// what a browser is ever shown.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createSettings, insideGitRepo, SettingsError, SETTINGS_FILE_NAME } from "../settings.js";
import { tempDir, cleanup } from "./helpers/stores.js";

after(cleanup);

const POSIX = process.platform !== "win32";
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
const KEY = "gsk_saved_key_for_the_test_1234"; // made up
const OTHER = "AIzaSy_other_made_up_key_5678";

const fresh = (env = {}) => {
  const dir = path.join(tempDir(), "data");
  return { dir, env, settings: createSettings({ dir, env }) };
};

test("nothing is set up on a new computer: the old default provider, no key, not configured", () => {
  const { settings } = fresh();
  assert.equal(settings.provider(), "gemini");
  assert.equal(settings.providerSource(), "default");
  assert.equal(settings.apiKey(), null);
  assert.equal(settings.configured(), false);
  assert.equal(settings.problem(), null);
});

test("a saved provider and key are used; the file is owner-only and the folder is made if needed", { skip: !POSIX }, () => {
  const { dir, settings } = fresh();
  settings.save({ provider: "groq" });
  settings.saveKey("groq", KEY);
  assert.equal(settings.provider(), "groq");
  assert.equal(settings.apiKey("groq"), KEY);
  assert.equal(settings.configured(), true);
  const file = path.join(dir, SETTINGS_FILE_NAME);
  assert.equal(mode(file), "600");
  assert.equal(mode(dir), "700");
  assert.deepEqual(fs.readdirSync(dir), [SETTINGS_FILE_NAME], "no temporary file is left behind");
});

test("each provider has its own key, and deleting one leaves the others", () => {
  const { settings } = fresh();
  settings.saveKey("groq", KEY);
  settings.saveKey("gemini", OTHER);
  assert.equal(settings.apiKey("groq"), KEY);
  assert.equal(settings.apiKey("gemini"), OTHER);
  assert.equal(settings.deleteKey("groq"), true);
  assert.equal(settings.apiKey("groq"), null);
  assert.equal(settings.apiKey("gemini"), OTHER);
  assert.equal(settings.deleteKey("groq"), false, "nothing left to delete");
});

test("the saved file is what another process sees on its next read", () => {
  const { dir, env, settings } = fresh();
  const other = createSettings({ dir, env });
  settings.saveKey("groq", KEY);
  assert.equal(other.apiKey("groq"), KEY);
  settings.deleteKey("groq");
  assert.equal(other.apiKey("groq"), null);
});

test("environment variables override saved settings, field by field, and the view says which", () => {
  const env = { PROVIDER: "groq", GROQ_API_KEY: "gsk_from_the_environment_9999", GROQ_MODEL: "env-model" };
  const { settings } = fresh(env);
  settings.save({ provider: "gemini", model: "saved-gemini-model" });
  settings.saveKey("groq", KEY);
  settings.saveKey("gemini", OTHER);
  assert.equal(settings.provider(), "groq", "PROVIDER wins over the saved choice");
  assert.equal(settings.apiKey("groq"), "gsk_from_the_environment_9999", "the environment key wins over the saved one");
  assert.equal(settings.model("groq"), "env-model");
  assert.equal(settings.model("gemini"), "saved-gemini-model", "a provider with no override keeps its saved model");
  assert.equal(settings.apiKey("gemini"), OTHER);

  const view = settings.publicView();
  assert.deepEqual(view.provider_override, { field: "provider", variable: "PROVIDER" });
  const groq = view.providers.find((p) => p.id === "groq");
  assert.deepEqual(groq.overrides, [{ field: "key", variable: "GROQ_API_KEY" }, { field: "model", variable: "GROQ_MODEL" }]);
  assert.equal(groq.key.source, "env");
  assert.equal(groq.key.last4, "9999");
  assert.equal(groq.key.saved, true, "the saved key is still there, just not in use");
  assert.equal(groq.key.saved_last4, KEY.slice(-4));
});

test("a blank environment variable does not override", () => {
  const { settings } = fresh({ GROQ_API_KEY: "   ", PROVIDER: "" });
  settings.save({ provider: "groq" });
  settings.saveKey("groq", KEY);
  assert.equal(settings.apiKey("groq"), KEY);
  assert.equal(settings.provider(), "groq");
});

test("a key in the environment alone counts as configured", () => {
  assert.equal(fresh({ GEMINI_API_KEY: "AIzaSy_env_only_key_0000" }).settings.configured(), true);
  assert.equal(fresh({ PROVIDER: "groq", GEMINI_API_KEY: "AIzaSy_env_only_key_0000" }).settings.configured(), false, "a key for a different provider does not");
});

test("the view that goes to a browser never holds a key, only the last 4 characters", () => {
  const { settings } = fresh({ GEMINI_API_KEY: OTHER });
  settings.saveKey("groq", KEY);
  settings.save({ provider: "groq" });
  const text = JSON.stringify(settings.publicView());
  for (const secret of [KEY, OTHER, KEY.slice(0, -4), OTHER.slice(0, -4)]) assert.ok(!text.includes(secret), `the view must not contain ${secret.slice(0, 6)}...`);
  assert.ok(text.includes(KEY.slice(-4)) && text.includes(OTHER.slice(-4)));
});

test("a key too short to hide behind its last 4 characters shows none", () => {
  const { settings } = fresh();
  settings.saveKey("groq", "short");
  assert.equal(settings.publicView().providers.find((p) => p.id === "groq").key.last4, null);
});

test("what is not a usable key or choice is refused in words, and nothing is saved", () => {
  const { dir, settings } = fresh();
  const refuses = (fn, re) => assert.throws(fn, (e) => e instanceof SettingsError && re.test(e.message));
  refuses(() => settings.saveKey("groq", "   "), /Paste the key/);
  refuses(() => settings.saveKey("groq", "two words"), /no spaces/);
  refuses(() => settings.saveKey("groq", "line\nbreak"), /no spaces or line breaks/);
  refuses(() => settings.saveKey("groq", "k".repeat(600)), /too long/);
  refuses(() => settings.saveKey("nobody", KEY), /listed providers/);
  refuses(() => settings.save({ provider: "nobody" }), /listed providers/);
  refuses(() => settings.save({ provider: "compat", baseUrl: "http://example.com/v1" }), /http would send your key unprotected/);
  assert.ok(!fs.existsSync(path.join(dir, SETTINGS_FILE_NAME)));
});

test("keys are trimmed, and a model can be cleared back to the default", () => {
  const { settings } = fresh();
  settings.saveKey("groq", `  ${KEY}\n`);
  assert.equal(settings.apiKey("groq"), KEY);
  settings.save({ provider: "groq", model: "custom/model" });
  assert.equal(settings.model("groq"), "custom/model");
  settings.save({ provider: "groq", model: "" });
  assert.equal(settings.model("groq"), "openai/gpt-oss-120b");
});

test("an OpenAI-compatible provider is configured only with a usable address and a model (and a key, unless it runs on this computer)", () => {
  const { settings } = fresh();
  settings.save({ provider: "compat" });
  assert.equal(settings.configured(), false);
  settings.save({ provider: "compat", baseUrl: "https://api.example.com/v1/", model: "m1" });
  assert.equal(settings.baseUrl(), "https://api.example.com/v1", "stored without the trailing slash");
  assert.equal(settings.configured(), false, "a remote provider needs a key");
  settings.saveKey("compat", KEY);
  assert.equal(settings.configured(), true);
  settings.deleteKey("compat");
  settings.save({ provider: "compat", baseUrl: "http://localhost:11434/v1", model: "m1" });
  assert.equal(settings.configured(), true, "a model server on this computer may need no key");
  assert.equal(settings.publicView().providers.find((p) => p.id === "compat").sends_key_to, "localhost (http, port 11434)");
});

test("a damaged settings file is ignored with a warning, kept aside, and replaced on the next save", () => {
  const { dir, settings } = fresh();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SETTINGS_FILE_NAME);
  fs.writeFileSync(file, "{ this is not json");
  assert.equal(settings.apiKey("groq"), null);
  assert.match(settings.problem(), /could not be read/);
  assert.match(settings.publicView().problem, /could not be read/);
  settings.saveKey("groq", KEY);
  assert.equal(settings.problem(), null);
  assert.equal(settings.apiKey("groq"), KEY);
  const kept = fs.readdirSync(dir).filter((f) => f.includes("unreadable"));
  assert.equal(kept.length, 1, "the damaged file was kept, not destroyed");
  if (POSIX) assert.equal(mode(path.join(dir, kept[0])), "600");
});

test("allSecrets lists every key held or in the environment, for hiding them", () => {
  const { settings } = fresh({ GEMINI_API_KEY: OTHER, SUPABASE_SERVICE_KEY: "service-role-made-up-0000" });
  settings.saveKey("groq", KEY);
  assert.deepEqual(new Set(settings.allSecrets()), new Set([KEY, OTHER, "service-role-made-up-0000"]));
});

test("a data folder inside a git repository is noticed, and one outside is not", () => {
  const repo = tempDir("multiplayer-ai-repo-");
  fs.mkdirSync(path.join(repo, ".git"));
  fs.mkdirSync(path.join(repo, "deep", "data"), { recursive: true });
  assert.equal(insideGitRepo(path.join(repo, "deep", "data")), repo);
  assert.equal(insideGitRepo(tempDir("multiplayer-ai-plain-")), null);
});
