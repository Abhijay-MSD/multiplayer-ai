// What the person chose (which provider, which model, the key) and where it lives.
//
// Saved in settings.json in the data folder, owner-only (mode 600 on macOS and Linux;
// Windows ignores that). That keeps other accounts on this computer out. It does NOT
// protect against anyone who can use this account, or against a backup or sync tool that
// copies the folder. The key is in this file in plain text.
//
// Environment variables override what is saved, field by field:
//   PROVIDER;  GROQ_API_KEY, GROQ_MODEL;  GEMINI_API_KEY, GEMINI_MODEL;
//   OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_API_KEY, OPENAI_COMPAT_MODEL.
//
// A key never leaves this module except through apiKey(), which only the provider
// adapters call. Everything meant for a browser comes from publicView().
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_MODELS, PROVIDER_IDS } from "./providers/defaults.js";
import { parseCompatBaseUrl } from "./providers/compat-url.js";
import { prepareDataDir, secureFile } from "./store/dataDir.js";

export { PROVIDER_IDS, DEFAULT_MODELS };
export const SETTINGS_FILE_NAME = "settings.json";
export const LEGACY_DEFAULT_PROVIDER = "gemini"; // what an environment with no PROVIDER used before settings existed

export const PROVIDER_LABELS = { groq: "Groq", gemini: "Gemini", claude: "Claude", compat: "OpenAI-compatible" };

const ENV_NAMES = {
  groq: { key: "GROQ_API_KEY", model: "GROQ_MODEL" },
  gemini: { key: "GEMINI_API_KEY", model: "GEMINI_MODEL" },
  claude: { key: "ANTHROPIC_API_KEY", model: "ANTHROPIC_MODEL" },
  compat: { key: "OPENAI_COMPAT_API_KEY", model: "OPENAI_COMPAT_MODEL", baseUrl: "OPENAI_COMPAT_BASE_URL" }
};
const MAX_KEY_CHARS = 512;
const MAX_MODEL_CHARS = 200;

export class SettingsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SettingsError";
    this.code = code;
  }
}

const clean = (v) => (typeof v === "string" ? v.trim() : "");
const last4 = (key) => (key && key.length >= 8 ? key.slice(-4) : null);

/** Does `dir`, or a folder above it, contain a .git entry? */
export function insideGitRepo(dir) {
  let at = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(at, ".git"))) return at;
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/**
 * `dir` is the data folder (settings are kept in memory only when it is null, for
 * code that has no folder). `env` is read each time, so a change takes effect at once.
 */
export function createSettings({ dir = null, env = process.env } = {}) {
  const file = dir ? path.join(dir, SETTINGS_FILE_NAME) : null;
  let cache = { stamp: null, data: {}, problem: null };
  let memory = {}; // used only when there is no folder

  function load() {
    if (!file) return { data: memory, problem: null };
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      cache = { stamp: null, data: {}, problem: null };
      return cache;
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (cache.stamp === stamp) return cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      cache = { stamp, data: parsed, problem: null };
    } catch {
      cache = { stamp, data: {}, problem: "settings.json could not be read, so it is being ignored. Saving new settings replaces it." };
    }
    return cache;
  }

  const saved = () => load().data;
  const savedKey = (p) => clean(saved().keys?.[p]) || null;
  const savedModel = (p) => clean(saved().models?.[p]) || null;
  const savedBaseUrl = () => clean(saved().compat_base_url) || null;
  const envValue = (name) => (name ? clean(env[name]) || null : null);

  function write(data) {
    if (!file) {
      memory = data;
      return;
    }
    if (cache.problem && fs.existsSync(file)) {
      // keep what could not be read, owner-only, rather than silently destroying it
      const copy = `${file}.unreadable-${Date.now()}`;
      fs.copyFileSync(file, copy);
      if (process.platform !== "win32") fs.chmodSync(copy, 0o600);
    }
    prepareDataDir(dir);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify({ version: 1, ...data }, null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    secureFile(file);
    cache = { stamp: null, data: {}, problem: null }; // read it back next time
  }

  const api = {
    file,

    /** The provider in use: PROVIDER, else what was saved, else the old default. */
    provider() {
      const fromEnv = clean(env.PROVIDER).toLowerCase();
      if (PROVIDER_IDS.includes(fromEnv)) return fromEnv;
      const fromFile = clean(saved().provider).toLowerCase();
      return PROVIDER_IDS.includes(fromFile) ? fromFile : LEGACY_DEFAULT_PROVIDER;
    },
    providerSource() {
      if (PROVIDER_IDS.includes(clean(env.PROVIDER).toLowerCase())) return "env";
      return PROVIDER_IDS.includes(clean(saved().provider).toLowerCase()) ? "saved" : "default";
    },

    model(provider = api.provider()) {
      return envValue(ENV_NAMES[provider]?.model) || savedModel(provider) || DEFAULT_MODELS[provider] || null;
    },
    baseUrl() {
      return envValue(ENV_NAMES.compat.baseUrl) || savedBaseUrl();
    },

    /** The key to use for `provider`: from the environment, else the saved one. Only the provider adapters call this. */
    apiKey(provider = api.provider()) {
      return envValue(ENV_NAMES[provider]?.key) || savedKey(provider);
    },

    hasKey(provider = api.provider()) {
      return Boolean(api.apiKey(provider));
    },

    /** Ready to answer: the provider has what it needs. A local OpenAI-compatible server may need no key. */
    configured() {
      const provider = api.provider();
      if (provider !== "compat") return api.hasKey(provider);
      const url = parseCompatBaseUrl(api.baseUrl());
      return url.ok && Boolean(api.model("compat")) && (api.hasKey("compat") || url.local);
    },

    /** Every key this copy holds or has in its environment, for hiding them from output. */
    allSecrets() {
      const out = [];
      for (const p of PROVIDER_IDS) {
        out.push(savedKey(p), envValue(ENV_NAMES[p].key));
      }
      out.push(clean(env.SUPABASE_SERVICE_KEY) || null);
      return out.filter(Boolean);
    },

    problem: () => load().problem,

    /** Everything the settings screen needs, and never a key (only the last 4 characters). */
    publicView() {
      const providers = PROVIDER_IDS.map((id) => {
        const names = ENV_NAMES[id];
        const envKey = envValue(names.key);
        const own = savedKey(id);
        const overrides = [];
        if (envKey) overrides.push({ field: "key", variable: names.key });
        if (envValue(names.model)) overrides.push({ field: "model", variable: names.model });
        if (names.baseUrl && envValue(names.baseUrl)) overrides.push({ field: "base_url", variable: names.baseUrl });
        const url = id === "compat" ? parseCompatBaseUrl(api.baseUrl()) : null;
        return {
          id,
          label: PROVIDER_LABELS[id],
          default_model: DEFAULT_MODELS[id],
          model: api.model(id),
          saved_model: savedModel(id),
          ...(id === "compat" ? { base_url: api.baseUrl(), saved_base_url: savedBaseUrl(), sends_key_to: url?.ok ? url.display : null } : {}),
          key: {
            present: Boolean(envKey || own),
            source: envKey ? "env" : own ? "saved" : null,
            last4: last4(envKey || own),
            saved: Boolean(own),
            saved_last4: last4(own)
          },
          overrides
        };
      });
      const providerOverride = clean(env.PROVIDER) && PROVIDER_IDS.includes(clean(env.PROVIDER).toLowerCase()) ? { field: "provider", variable: "PROVIDER" } : null;
      return {
        provider: api.provider(),
        provider_source: api.providerSource(),
        provider_override: providerOverride,
        configured: api.configured(),
        providers,
        file: file ?? null,
        problem: api.problem()
      };
    },

    /** Saves the provider and its model / address. Throws SettingsError with a message for the person. */
    save({ provider, model, baseUrl } = {}) {
      const id = clean(provider).toLowerCase();
      if (!PROVIDER_IDS.includes(id)) throw new SettingsError("BAD_REQUEST", "Choose one of the listed providers.");
      const data = structuredClone(saved());
      data.provider = id;
      if (model !== undefined) {
        const m = clean(model);
        if (m.length > MAX_MODEL_CHARS || /[\u0000-\u001f]/.test(m)) throw new SettingsError("BAD_REQUEST", "That model name isn't usable.");
        data.models = { ...(data.models ?? {}) };
        if (m) data.models[id] = m;
        else delete data.models[id];
      }
      if (id === "compat" && baseUrl !== undefined) {
        const url = parseCompatBaseUrl(baseUrl);
        if (!url.ok) throw new SettingsError("BAD_URL", url.message);
        data.compat_base_url = url.base;
      }
      write(data);
    },

    /** Saves a key for one provider. Throws SettingsError with a message for the person. */
    saveKey(provider, key) {
      const id = clean(provider).toLowerCase();
      if (!PROVIDER_IDS.includes(id)) throw new SettingsError("BAD_REQUEST", "Choose one of the listed providers.");
      const k = clean(key);
      if (!k) throw new SettingsError("BAD_REQUEST", "Paste the key first.");
      if (k.length > MAX_KEY_CHARS) throw new SettingsError("BAD_REQUEST", "That is too long to be a key.");
      if (/\s|[\u0000-\u001f]/.test(k)) throw new SettingsError("BAD_REQUEST", "A key has no spaces or line breaks in it. Copy it again without the surrounding text.");
      const data = structuredClone(saved());
      data.keys = { ...(data.keys ?? {}), [id]: k };
      write(data);
    },

    /** Removes the saved key (an environment key, if there is one, is untouched). Returns true if one was saved. */
    deleteKey(provider) {
      const id = clean(provider).toLowerCase();
      if (!PROVIDER_IDS.includes(id)) throw new SettingsError("BAD_REQUEST", "Choose one of the listed providers.");
      if (!savedKey(id)) return false;
      const data = structuredClone(saved());
      delete data.keys[id];
      if (!Object.keys(data.keys).length) delete data.keys;
      write(data);
      return true;
    }
  };
  return api;
}

// The settings in force for this process. Until the server entry points set them,
// they are the environment alone, which is what the code used before settings existed.
let current = createSettings({ dir: null });
export const setSettings = (settings) => {
  current = settings;
};
export const getSettings = () => current;
