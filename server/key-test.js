// "Test key": one tiny request to the provider, through the same adapter a room uses,
// so a pass means a room's reply will work. One attempt only: a wrong key is not retried
// (and neither is anything else), and it gives up after TIMEOUT_MS.
//
// The answer names what went wrong in a few words. It never repeats the provider's own text.
import { callModel } from "./providers/index.js";
import { toProviderFailure } from "./providers/failure.js";
import { parseCompatBaseUrl } from "./providers/compat-url.js";
import { PROVIDER_IDS, getSettings } from "./settings.js";
import { registerSecret } from "./secrets.js";

export const TIMEOUT_MS = 10_000;

export const TEST_MESSAGES = {
  NO_KEY: "Paste a key first.",
  BAD_KEY: "The provider didn't accept this key. Check that you copied all of it, and that it is a key for this provider.",
  NO_QUOTA: "The provider answered that this key is out of quota or is being rate limited.",
  NETWORK: "Couldn't reach the provider. Check your internet connection (and the address, for an OpenAI-compatible provider).",
  TIMEOUT: `The provider didn't answer within ${TIMEOUT_MS / 1000} seconds.`,
  MODEL_NOT_FOUND: "The provider doesn't know that model or address. Check the model name.",
  BUSY: "The provider is busy or down right now. Try again in a moment.",
  UNKNOWN: "The test failed for a reason this screen can't name. The details are in the terminal where Multiplayer AI is running."
};

/**
 * { provider, key?, baseUrl?, model? } -> { ok: true, model } | { ok: false, code, message }.
 * With no `key` the key in force for that provider is tested.
 */
export async function testKey({ provider, key, baseUrl, model } = {}, { settings = getSettings(), call = callModel, timeoutMs = TIMEOUT_MS } = {}) {
  const id = String(provider ?? "").toLowerCase();
  if (!PROVIDER_IDS.includes(id)) return { ok: false, code: "BAD_REQUEST", message: "Choose one of the listed providers." };
  const credentials = {
    apiKey: (typeof key === "string" && key.trim()) || settings.apiKey(id) || undefined,
    model: (typeof model === "string" && model.trim()) || settings.model(id) || undefined
  };
  let local = false;
  if (id === "compat") {
    const url = parseCompatBaseUrl(baseUrl ?? settings.baseUrl());
    if (!url.ok) return { ok: false, code: "BAD_URL", message: url.message };
    credentials.baseUrl = url.base;
    local = url.local;
    if (!credentials.model) return { ok: false, code: "BAD_SETTINGS", message: "Enter the name of the model to use." };
  }
  if (!credentials.apiKey && !local) return { ok: false, code: "NO_KEY", message: TEST_MESSAGES.NO_KEY };

  const forget = registerSecret(credentials.apiKey); // hidden from any output while it is being tried
  try {
    await call({
      provider: id,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      maxOutputTokens: 8,
      maxRetries: 0,
      maxParseRetries: 0,
      timeoutMs,
      label: "key-test",
      credentials
    });
    return { ok: true, model: credentials.model ?? null };
  } catch (e) {
    const failure = toProviderFailure(e, id);
    console.error(
      `[multiplayer-ai] key test failed (${id}): ${failure.category}` + (failure.status ? ` (status ${failure.status})` : "") + (failure.detail ? `: ${failure.detail}` : "")
    );
    const message = failure.category === "BAD_SETTINGS" ? failure.detail || TEST_MESSAGES.UNKNOWN : TEST_MESSAGES[failure.category] ?? TEST_MESSAGES.UNKNOWN;
    return { ok: false, code: failure.category, message };
  } finally {
    forget();
  }
}
