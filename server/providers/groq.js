// Groq provider adapter. Groq exposes an OpenAI-compatible chat completions
// endpoint, so this is plain fetch: no SDK.
// Env: GROQ_API_KEY (required), GROQ_MODEL, GROQ_FALLBACK_MODEL,
// GROQ_SUMMARY_MODEL, GROQ_REASONING_EFFORT.
// Failure handling: 429/503 and gpt-oss "Parsing failed" 400s are retried, then the
// fallback model is tried; any other error fails immediately.

import { getSettings } from "../settings.js";
import { redact } from "../secrets.js";
import { NoKeyError } from "./failure.js";
import { DEFAULT_MODELS } from "./defaults.js";
import { escapeForLog } from "../safe-text.js";
import { splitAtTools, parseToolArguments, normalizeToolCalls, usageOf } from "./tool-format.js";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
export const DEFAULT_MODEL = DEFAULT_MODELS.groq;
export const DEFAULT_SUMMARY_MODEL = "openai/gpt-oss-20b";

// The gpt-oss models reason before they answer. Keep it short for chat-style
// replies; override with GROQ_REASONING_EFFORT (low | medium | high | none).
const DEFAULT_REASONING_EFFORT = "low";

// Retry "busy" responses (429/503) with backoff; a bad key or unknown model
// won't fix itself.
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// gpt-oss sometimes emits output Groq can't parse and answers 400 "Parsing
// failed" (code output_parse_failed), sometimes with the raw text in
// error.failed_generation and sometimes without. It is a sampling accident, not
// a bad request, so a quick retry usually works.
const MAX_PARSE_RETRIES = 2;
const PARSE_BACKOFF_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isRetryable = (status) => status === 429 || status === 503;
const isParseFailure = (e) =>
  e.status === 400 &&
  (/parsing failed/i.test(e.message) || e.error?.code === "output_parse_failed" || e.error?.code === "tool_use_failed" || (e.error != null && "failed_generation" in e.error));
const isTransient = (e) => isRetryable(e.status) || isParseFailure(e);

class GroqError extends Error {
  constructor(status, message, error) {
    super(message);
    this.status = status;
    this.error = error;
  }
}

// ["system","system","user","assistant","user"] -> "system*2,user,assistant,user"
function roleShape(messages) {
  const runs = [];
  for (const { role } of messages) {
    const last = runs[runs.length - 1];
    if (last?.role === role) last.n++;
    else runs.push({ role, n: 1 });
  }
  return runs.map((r) => (r.n > 1 ? `${r.role}*${r.n}` : r.role)).join(",");
}

// Stderr only, and never the key or message contents: status, error type/code,
// the start of failed_generation (model output), and the shape of the request.
function logFailure(status, body, messages, limit) {
  const err = body.error ?? {};
  const failed = typeof err.failed_generation === "string" ? redact(err.failed_generation.slice(0, 500)) : undefined;
  console.error(
    `[multiplayer-ai:groq-error] status=${status} type=${escapeForLog(err.type ?? "?")} code=${escapeForLog(err.code ?? "?")} ` +
    `messages=${messages.length} roles=${roleShape(messages)} ` +
    `max_tokens=${limit ?? "unset"}` +
    (failed !== undefined ? ` failed_generation=${escapeForLog(JSON.stringify(failed))}` : "")
  );
}

/**
 * Shape messages the way chat templates expect: system first, no empty
 * messages, no two neighbours with the same role (merged, blank-line joined).
 * Doesn't mutate the input.
 */
export function normalizeMessages(messages) {
  const kept = messages.filter((m) => typeof m.content === "string" && m.content.trim() !== "");
  const ordered = [...kept.filter((m) => m.role === "system"), ...kept.filter((m) => m.role !== "system")];
  const out = [];
  for (const m of ordered) {
    const last = out[out.length - 1];
    if (last?.role === m.role) last.content += `\n\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

/** The tools in the chat-completions shape (Groq and any OpenAI-compatible service): {type:"function", function:{name, description, parameters}}. */
export const chatTools = (tools) => tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

/**
 * Internal messages -> chat-completions messages. The plain part is shaped by normalizeMessages as always; a finished tool
 * call is an assistant message with tool_calls (arguments as a JSON string) followed by one {role:"tool", tool_call_id} message each.
 */
export function toChatMessages(messages) {
  const { prefix, tail } = splitAtTools(messages);
  const out = normalizeMessages(prefix);
  for (const m of tail) {
    if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    else if (m.role === "assistant") {
      const calls = (m.toolCalls ?? []).map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.rawArgs ?? JSON.stringify(c.args ?? {}) } }));
      out.push({ role: "assistant", content: m.content ? m.content : calls.length ? null : "", ...(calls.length ? { tool_calls: calls } : {}) });
    } else out.push({ role: m.role, content: m.content });
  }
  return out;
}

/** What a chat-completions answer holds: the text, the tool calls (arguments parsed, or marked unreadable), the usage. */
export function readChatMessage(body) {
  const message = body.choices?.[0]?.message ?? {};
  const toolCalls = normalizeToolCalls(
    (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((c) => {
      const raw = c?.function?.arguments;
      const parsed = parseToolArguments(raw);
      return { id: c?.id, name: c?.function?.name, ...parsed, ...(parsed.argsError && typeof raw === "string" ? { rawArgs: raw.slice(0, 4000) } : {}) };
    })
  );
  return { text: typeof message.content === "string" ? message.content.trim() : "", toolCalls, usage: usageOf(body.usage?.prompt_tokens, body.usage?.completion_tokens) };
}

// `credentials` ({ apiKey, model }) is for testing a key that is not saved yet; otherwise
// the key is the one in force: GROQ_API_KEY, else the saved one.
function apiKey(credentials) {
  const key = credentials?.apiKey ?? getSettings().apiKey("groq");
  if (!key) throw new NoKeyError("groq", "Groq");
  return key;
}

function reasoningParam(model) {
  const effort = process.env.GROQ_REASONING_EFFORT || DEFAULT_REASONING_EFFORT;
  // Only the gpt-oss models accept the setting; others would reject it.
  if (!model.startsWith("openai/gpt-oss") || effort === "none") return {};
  return { reasoning_effort: effort };
}

// max_completion_tokens counts reasoning tokens too, so on a reasoning model a
// cap sized for the answer alone can be used up before the answer starts.
// Add headroom for the thinking; the cap is a runaway guard, and answer length
// is steered by the prompt. Callers that pass no cap get none.
const REASONING_HEADROOM = { low: 512, medium: 1024, high: 2048 };

function tokenLimit(model, maxOutputTokens) {
  if (!maxOutputTokens) return undefined;
  const effort = reasoningParam(model).reasoning_effort;
  return maxOutputTokens + (effort ? REASONING_HEADROOM[effort] ?? REASONING_HEADROOM.high : 0);
}

async function generate(model, messages, { maxOutputTokens, label, fallback, fetchImpl, credentials, tools }) {
  const started = Date.now();
  const limit = tokenLimit(model, maxOutputTokens);
  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey(credentials)}` },
    body: JSON.stringify({
      model,
      messages,
      ...(tools?.length ? { tools: chatTools(tools) } : {}),
      ...(limit ? { max_completion_tokens: limit } : {}),
      ...reasoningParam(model)
    })
  });
  const body = await res.json().catch(() => ({}));
  // Groq's completion_tokens counts the model's reasoning too. Report what the
  // person reads and what the model spent thinking separately, so a cap that is
  // too tight for the thinking is visible.
  const total = body.usage?.completion_tokens;
  const reasoning = body.usage?.completion_tokens_details?.reasoning_tokens;
  const visible = total != null && reasoning != null ? total - reasoning : total;
  const finish = body.choices?.[0]?.finish_reason;
  console.error(
    `[multiplayer-ai:timing] ${label} groq model=${model}${fallback ? " (fallback)" : ""} status=${res.status} ` +
    `duration=${Date.now() - started}ms prompt_tokens=${escapeForLog(body.usage?.prompt_tokens ?? "?")} ` +
    `output_tokens=${escapeForLog(visible ?? "?")} reasoning_tokens=${escapeForLog(reasoning ?? "?")}` +
    (finish ? ` finish=${escapeForLog(finish)}` : "")
  );
  if (finish === "length") {
    console.error(
      `[multiplayer-ai] ${label} reply from ${model} was cut off at the token limit ` +
      `(max_completion_tokens=${limit ?? "unset"}, reasoning used ${escapeForLog(reasoning ?? "?")}). Raise MAX_OUTPUT_TOKENS.`
    );
  }
  if (!res.ok) {
    logFailure(res.status, body, messages, limit);
    throw new GroqError(res.status, `Groq ${res.status}: ${body.error?.message ?? "request failed"}`, body.error);
  }
  return readChatMessage(body);
}

async function generateWithRetry(model, messages, opts) {
  let busy = 0;
  let parse = 0;
  for (;;) {
    try {
      return await generate(model, messages, opts);
    } catch (e) {
      let delay;
      if (isParseFailure(e) && parse < opts.maxParseRetries) {
        parse++;
        delay = opts.parseBackoffMs * parse;
        console.error(`[multiplayer-ai] ${model} produced unparseable output; retry ${parse}/${opts.maxParseRetries} in ${delay}ms`);
      } else if (isRetryable(e.status) && busy < opts.maxRetries) {
        delay = BASE_DELAY_MS * 2 ** busy * (0.75 + Math.random() * 0.5);
        busy++;
        console.error(`[multiplayer-ai] ${model} returned ${e.status}; retry ${busy}/${opts.maxRetries} in ${Math.round(delay)}ms`);
      } else {
        throw e;
      }
      await sleep(delay);
    }
  }
}

/**
 * callModel({ messages, tools }) -> { text, toolCalls, model, usedFallback? }
 * Same contract as providers/gemini.js. `thinkingLevel` is accepted and ignored.
 */
export async function callModel({
  messages,
  tools = [], // the agent's tools, in the internal format (agent/tools.js); none means a plain text request
  signal, // aborts the request when the person presses Stop
  model: modelOverride, // run exactly this model: no fallback (used for summaries)
  maxOutputTokens,
  maxRetries = MAX_RETRIES,
  maxParseRetries = MAX_PARSE_RETRIES,
  parseBackoffMs = PARSE_BACKOFF_MS,
  label = "step",
  fetchImpl = fetch,
  timeoutMs, // give up on one request after this long (none by default)
  credentials // { apiKey, model } to use instead of the saved settings, to test a key
}) {
  const primary = modelOverride || credentials?.model || getSettings().model("groq");
  const fallback = modelOverride || credentials ? "" : process.env.GROQ_FALLBACK_MODEL || "";
  const signals = [timeoutMs ? AbortSignal.timeout(timeoutMs) : null, signal ?? null].filter(Boolean);
  const send = signals.length ? (url, init) => fetchImpl(url, { ...init, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] }) : fetchImpl;
  const opts = { maxOutputTokens, label, maxRetries, maxParseRetries, parseBackoffMs, fetchImpl: send, credentials, tools };
  const normalized = toChatMessages(messages);

  try {
    const r = await generateWithRetry(primary, normalized, opts);
    return { text: r.text || (r.toolCalls.length ? "" : "(no response)"), toolCalls: r.toolCalls, model: primary, usage: r.usage };
  } catch (e) {
    if (!isTransient(e) || !fallback || fallback === primary) throw e;
    console.error(`[multiplayer-ai] ${primary} failed after retries (${e.status}); falling back to ${fallback}`);
    const r = await generateWithRetry(fallback, normalized, { ...opts, fallback: true });
    return { text: r.text || (r.toolCalls.length ? "" : "(no response)"), toolCalls: r.toolCalls, model: fallback, usage: r.usage, usedFallback: true };
  }
}
