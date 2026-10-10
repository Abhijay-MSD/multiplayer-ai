import { GoogleGenerativeAI } from "@google/generative-ai";
import { getSettings } from "../settings.js";
import { NoKeyError } from "./failure.js";
import { escapeForLog } from "../safe-text.js";
import { splitAtTools, normalizeToolCalls, usageOf } from "./tool-format.js";

// Made when first needed, so a missing key surfaces at call time, not import time, and
// made again if the key changes. `credentials` ({ apiKey, model }) is for testing a key
// that is not saved yet; otherwise the key is GEMINI_API_KEY, else the saved one.
let _client = null; // { key, sdk }

function client(credentials) {
  const key = credentials?.apiKey ?? getSettings().apiKey("gemini");
  if (!key) throw new NoKeyError("gemini", "Gemini");
  if (_client?.key !== key) _client = { key, sdk: new GoogleGenerativeAI(key) };
  return _client.sdk;
}


// Gemini 3.5 flash thinks by default (measured: ~600 thought tokens, ~28s for
// "hi"). Keep it minimal for chat-style replies; override with
// GEMINI_THINKING_LEVEL (minimal | low | medium | high | none).
const DEFAULT_THINKING_LEVEL = "minimal";

// Retry only on "busy" responses; a bad key or unknown model won't fix itself.
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000; // 1s, 2s, 4s (± jitter)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function statusOf(e) {
  if (typeof e?.status === "number") return e.status;
  const m = /\[(\d{3})[ \]]/.exec(String(e?.message ?? ""));
  return m ? Number(m[1]) : null;
}

const isRetryable = (e) => [503, 429].includes(statusOf(e));

/** Runs one model, retrying 503/429 with exponential backoff + jitter. */
async function generateWithRetry(modelName, input, { fallback = false, label = "step", config = {}, maxRetries = MAX_RETRIES, credentials, timeoutMs, signal } = {}) {
  let generationConfig = config;
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    const kind = fallback ? "fallback" : attempt > 0 ? `retry ${attempt}` : "first try";
    try {
      const model = client(credentials).getGenerativeModel({ model: modelName, generationConfig }, timeoutMs ? { timeout: timeoutMs } : undefined);
      const result = await model.generateContent(input, signal ? { signal } : undefined);
      const u = result.response.usageMetadata ?? {};
      console.error(
        `[multiplayer-ai:timing] ${label} gemini model=${modelName} attempt=${attempt + 1} (${kind}) ` +
        `status=200 duration=${Date.now() - started}ms prompt_tokens=${escapeForLog(u.promptTokenCount ?? "?")} ` +
        `output_tokens=${escapeForLog(u.candidatesTokenCount ?? "?")} thought_tokens=${escapeForLog(u.thoughtsTokenCount ?? 0)}`
      );
      const text = result.response.text().trim();
      // A function call has no id of its own in this library, so the adapter numbers them. The model's own parts are kept for
      // replay, because they may carry fields this code doesn't know about (a signature the service wants back).
      const calls = typeof result.response.functionCalls === "function" ? result.response.functionCalls() ?? [] : [];
      const toolCalls = normalizeToolCalls(calls.map((c, i) => ({ id: `gemini_call_${i + 1}`, name: c?.name, args: c?.args && typeof c.args === "object" ? c.args : {} })));
      return { text, toolCalls, usage: usageOf(u.promptTokenCount, u.candidatesTokenCount), stoppedForLength: result.response.candidates?.[0]?.finishReason === "MAX_TOKENS", raw: toolCalls.length ? { provider: "gemini", parts: result.response.candidates?.[0]?.content?.parts ?? [] } : undefined };
    } catch (e) {
      console.error(
        `[multiplayer-ai:timing] ${label} gemini model=${modelName} attempt=${attempt + 1} (${kind}) ` +
        `status=${statusOf(e) ?? "error"} duration=${Date.now() - started}ms`
      );
      // A model that rejects the thinking setting would fail every step; drop it
      // and try once more rather than break replies. Loud so it gets noticed.
      if (statusOf(e) === 400 && generationConfig.thinkingConfig && !/api key/i.test(String(e?.message ?? ""))) {
        console.error(`[multiplayer-ai] ${modelName} rejected thinkingConfig (400); retrying once without it`);
        const { thinkingConfig, ...rest } = generationConfig;
        generationConfig = rest;
        attempt--;
        continue;
      }
      if (!isRetryable(e) || attempt >= maxRetries) throw e;
      const delay = BASE_DELAY_MS * 2 ** attempt * (0.75 + Math.random() * 0.5);
      console.error(
        `[multiplayer-ai] ${modelName} returned ${statusOf(e)}; retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)}ms`
      );
      await sleep(delay);
    }
  }
}

// maxOutputTokens counts the model's thinking as well as the answer, so a cap
// sized for the answer alone can be used up before it starts. Leave room.
const THINKING_HEADROOM = { minimal: 128, low: 512, medium: 1024, high: 2048 };
export const thinkingHeadroom = (level) =>
  ["none", "default", "", undefined].includes(level) ? THINKING_HEADROOM.high : THINKING_HEADROOM[level] ?? THINKING_HEADROOM.high;

/** A function in the library's shape: {name, description, parameters: {type, properties, required}}. A function with no parameters has none. */
function declaration(t) {
  const props = t.parameters?.properties ?? {};
  return {
    name: t.name,
    description: t.description,
    ...(Object.keys(props).length ? { parameters: { type: t.parameters.type, properties: props, required: t.parameters.required ?? [] } } : {})
  };
}

/** The first turn is the whole conversation so far as text; each finished tool call follows as the model's turn and a function turn. */
function contentsFor(prompt, tail) {
  const contents = [{ role: "user", parts: [{ text: prompt }] }];
  for (const m of tail) {
    if (m.role === "assistant") {
      const parts =
        m.raw?.provider === "gemini"
          ? m.raw.parts
          : [...(m.content ? [{ text: m.content }] : []), ...(m.toolCalls ?? []).map((c) => ({ functionCall: { name: c.name, args: c.args && typeof c.args === "object" ? c.args : {} } }))];
      contents.push({ role: "model", parts });
    } else if (m.role === "tool") {
      const part = { functionResponse: { name: m.name, response: { content: m.content, ...(m.isError ? { error: true } : {}) } } };
      const last = contents.at(-1);
      if (last.role === "function") last.parts.push(part);
      else contents.push({ role: "function", parts: [part] });
    }
  }
  return contents;
}

/**
 * callModel({ messages, tools }) -> { text, toolCalls, model, usage, usedFallback? }
 *
 * messages: Array<{ role: "system"|"user"|"assistant", content: string }>
 * tools:    Array (ignored in v0 — text-only)
 *
 * `model` is the model that actually answered (it differs from GEMINI_MODEL
 * when the fallback was used).
 *
 * We build a single text prompt rather than using the multi-turn chat API
 * to avoid strict turn-alternation requirements (Gemini requires user/model
 * pairs, but our history can have consecutive same-role turns).
 */
export async function callModel({
  messages,
  tools = [], // the agent's tools, in the internal format (agent/tools.js); none means a plain text request
  signal, // aborts the request when the person presses Stop
  model: modelOverride, // run exactly this model: no fallback (used for summaries)
  thinkingLevel = process.env.GEMINI_THINKING_LEVEL || DEFAULT_THINKING_LEVEL,
  maxOutputTokens,
  maxRetries = MAX_RETRIES,
  label = "step",
  timeoutMs, // give up on one request after this long (none by default)
  credentials // { apiKey, model } to use instead of the saved settings, to test a key
}) {
  const primary = modelOverride || credentials?.model || getSettings().model("gemini");
  const fallback = modelOverride || credentials ? "" : process.env.GEMINI_FALLBACK_MODEL || "";
  // "none"/"default" leave thinking to the model; anything else is a Gemini 3
  // thinkingLevel (minimal | low | medium | high).
  const config = {};
  if (thinkingLevel && !["none", "default"].includes(thinkingLevel)) config.thinkingConfig = { thinkingLevel };
  if (maxOutputTokens) config.maxOutputTokens = maxOutputTokens + thinkingHeadroom(thinkingLevel);
  const opts = { label, config, maxRetries, credentials, timeoutMs, signal };

  const { prefix, tail } = splitAtTools(messages);
  let prompt = "";
  for (const msg of prefix) {
    if (msg.role === "system") {
      prompt += msg.content + "\n\n---\n\n";
    } else if (msg.role === "assistant") {
      prompt += `Agent: ${msg.content}\n\n`;
    } else {
      prompt += `User: ${msg.content}\n\n`;
    }
  }
  prompt += "Agent:";
  // With tools the request is the structured form: the text above as the first turn, then each finished tool call as the
  // model's own turn and one "function" turn holding every result (roles user, model and function are the library's).
  const input = tools.length || tail.length ? { contents: contentsFor(prompt, tail), ...(tools.length ? { tools: [{ functionDeclarations: tools.map(declaration) }] } : {}) } : prompt;
  const done = (r, model, extra = {}) => ({ text: r.text || (r.toolCalls.length ? "" : "(no response)"), toolCalls: r.toolCalls, model, usage: r.usage, stoppedForLength: Boolean(r.stoppedForLength), ...(r.raw ? { raw: r.raw } : {}), ...extra });

  try {
    return done(await generateWithRetry(primary, input, opts), primary);
  } catch (e) {
    // Fall back only when the primary is merely busy; other errors (bad key,
    // invalid model) are real problems and should surface as-is.
    if (!isRetryable(e) || !fallback || fallback === primary) throw e;

    console.error(`[multiplayer-ai] ${primary} still busy after retries; falling back to ${fallback}`);
    try {
      return done(await generateWithRetry(fallback, input, { ...opts, fallback: true }), fallback, { usedFallback: true });
    } catch (e2) {
      if (!isRetryable(e2)) throw e2;
      throw new Error(
        `Gemini is overloaded: ${primary} and ${fallback} both returned ${statusOf(e2)} after retries. Try again in a moment.`
      );
    }
  }
}
