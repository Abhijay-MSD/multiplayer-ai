// Adapter for any provider that speaks the OpenAI chat-completions format at a
// base address the person gives (plus the model name and, usually, a key). Plain
// fetch, no SDK. Settings: OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_API_KEY,
// OPENAI_COMPAT_MODEL, or what was saved in Settings.
//
// The key goes only in an Authorization header, only to the address that was checked by
// parseCompatBaseUrl (https, or http for this computer), and a redirect is refused so the
// key cannot follow one to another host. A local model server that needs no key may be
// used without one.
//
// 429/503 are retried with backoff, as for the other providers; any other error fails at once.
import { getSettings } from "../settings.js";
import { chatTools, readChatMessage, toChatMessages } from "./groq.js";
import { parseCompatBaseUrl } from "./compat-url.js";
import { BadSettingsError } from "./failure.js";
import { escapeForLog } from "../safe-text.js";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isRetryable = (status) => status === 429 || status === 503;

class CompatError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function target(credentials) {
  const settings = getSettings();
  const url = parseCompatBaseUrl(credentials?.baseUrl ?? settings.baseUrl());
  if (!url.ok) throw new BadSettingsError(url.message);
  const model = credentials?.model || settings.model("compat");
  if (!model) throw new BadSettingsError("Enter the name of the model to use.");
  const key = credentials?.apiKey ?? settings.apiKey("compat");
  if (!key && !url.local) throw new BadSettingsError("No API key is set up for this provider.");
  return { url, model, key };
}

async function generate({ url, model, key }, messages, { maxOutputTokens, label, fetchImpl, tools }) {
  const started = Date.now();
  const res = await fetchImpl(`${url.base}/chat/completions`, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, messages, ...(tools?.length ? { tools: chatTools(tools) } : {}), ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}) })
  });
  const body = await res.json().catch(() => ({}));
  console.error(
    `[multiplayer-ai:timing] ${label} compat host=${url.host} model=${model} status=${res.status} ` +
    `duration=${Date.now() - started}ms prompt_tokens=${escapeForLog(body.usage?.prompt_tokens ?? "?")} output_tokens=${escapeForLog(body.usage?.completion_tokens ?? "?")}`
  );
  if (!res.ok) throw new CompatError(res.status, `${url.host} ${res.status}: ${body.error?.message ?? "request failed"}`);
  return readChatMessage(body);
}

/** callModel({ messages }) -> { text, toolCalls, model }. Same contract as the other adapters. */
export async function callModel({
  messages,
  tools = [], // the agent's tools, in the internal format (agent/tools.js); none means a plain text request
  signal, // aborts the request when the person presses Stop
  model: modelOverride,
  maxOutputTokens,
  maxRetries = MAX_RETRIES,
  label = "step",
  fetchImpl = fetch,
  timeoutMs,
  credentials
}) {
  const t = target(credentials);
  if (modelOverride) t.model = modelOverride;
  const signals = [timeoutMs ? AbortSignal.timeout(timeoutMs) : null, signal ?? null].filter(Boolean);
  const send = signals.length ? (u, init) => fetchImpl(u, { ...init, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] }) : fetchImpl;
  const normalized = toChatMessages(messages);
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await generate(t, normalized, { maxOutputTokens, label, fetchImpl: send, tools });
      return { text: r.text || (r.toolCalls.length ? "" : "(no response)"), toolCalls: r.toolCalls, model: t.model, usage: r.usage };
    } catch (e) {
      if (!isRetryable(e.status) || attempt >= maxRetries) throw e;
      const delay = BASE_DELAY_MS * 2 ** attempt * (0.75 + Math.random() * 0.5);
      console.error(`[multiplayer-ai] ${t.url.host} returned ${e.status}; retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
}
