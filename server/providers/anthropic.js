// Adapter for Claude, through its Messages API. Plain fetch, no SDK. Settings: ANTHROPIC_API_KEY and ANTHROPIC_MODEL,
// or what was saved in Settings.
//
// The tool-use shape (tools with input_schema, tool_use and tool_result blocks, is_error) was read from the provider's
// documentation (docs/providers.md). NOT CONFIRMED against the API's documentation: the address, the header names and
// the version value, the body and response fields, the error statuses and types, and the default model. They are what
// this adapter was written to; the tests pin what it does with them, not that they are right. Run Test key with a real
// key to find out.
//
// The key goes only in the x-api-key header, only to ENDPOINT, never in an address, a body, an argument or a log line,
// and a redirect is refused so the key cannot follow one to another host. Busy answers (429, 503, 529, or an error of
// type "overloaded_error") are retried with backoff; a key the API doesn't accept (401) and everything else fails at once.
import { getSettings } from "../settings.js";
import { NoKeyError } from "./failure.js";
import { normalizeMessages } from "./groq.js";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "./defaults.js"; // the API requires max_tokens, so a call with no cap still sends one
import { escapeForLog } from "../safe-text.js";
import { splitAtTools, parseToolArguments, normalizeToolCalls, usageOf } from "./tool-format.js";

export const ENDPOINT = "https://api.anthropic.com/v1/messages";
export const API_VERSION = "2023-06-01";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ClaudeError extends Error {
  constructor(status, message, type, retryAfter = null) {
    super(message);
    this.status = status;
    this.type = type;
    this.retryAfter = retryAfter; // the Retry-After header as it came, for the failure's hint
  }
}
const isRetryable = (e) => e.status === 429 || e.status === 503 || e.status === 529 || e.type === "overloaded_error";

// `credentials` ({ apiKey, model }) is for testing a key that is not saved yet; otherwise the key is the one in force:
// ANTHROPIC_API_KEY, else the saved one.
function apiKey(credentials) {
  const key = credentials?.apiKey ?? getSettings().apiKey("claude");
  if (!key) throw new NoKeyError("claude", "Claude");
  return key;
}

/**
 * The API takes the system text apart from the turns, and wants the turns to start with the user. A finished tool call is an
 * assistant turn of tool_use blocks followed by ONE user turn holding every tool_result, with the results before any text.
 */
function shape(messages) {
  const { prefix, tail } = splitAtTools(messages);
  const normalized = normalizeMessages(prefix);
  const system = normalized.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = normalized.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
  if (turns[0]?.role === "assistant") turns.unshift({ role: "user", content: "(Earlier messages are not shown.)" });
  for (const m of tail) {
    if (m.role === "assistant") {
      const blocks = [
        ...(m.content ? [{ type: "text", text: m.content }] : []),
        ...(m.toolCalls ?? []).map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args && typeof c.args === "object" ? c.args : {} }))
      ];
      turns.push({ role: "assistant", content: blocks });
    } else if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) };
      const last = turns.at(-1);
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) last.content.push(block);
      else turns.push({ role: "user", content: [block] });
    }
  }
  return { system, turns };
}

/** The tools in the Messages API shape: {name, description, input_schema}. */
const claudeTools = (tools) => tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

async function generate(model, shaped, { maxOutputTokens, label, fetchImpl, credentials, tools }) {
  const started = Date.now();
  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json", "x-api-key": apiKey(credentials), "anthropic-version": API_VERSION },
    body: JSON.stringify({
      model,
      max_tokens: maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS,
      ...(shaped.system ? { system: shaped.system } : {}),
      ...(tools?.length ? { tools: claudeTools(tools) } : {}),
      messages: shaped.turns
    })
  });
  const body = await res.json().catch(() => ({}));
  // Stderr only: no key, and none of the task or the answer.
  console.error(
    `[multiplayer-ai:timing] ${label} claude model=${model} status=${res.status} duration=${Date.now() - started}ms ` +
    `input_tokens=${escapeForLog(body.usage?.input_tokens ?? "?")} output_tokens=${escapeForLog(body.usage?.output_tokens ?? "?")}`
  );
  if (!res.ok) throw new ClaudeError(res.status, `Claude ${res.status}: ${body.error?.message ?? "request failed"}`, body.error?.type, res.headers?.get?.("retry-after") ?? null);
  const blocks = Array.isArray(body.content) ? body.content : [];
  const text = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("").trim();
  const toolCalls = normalizeToolCalls(blocks.filter((b) => b?.type === "tool_use").map((b) => ({ id: b.id, name: b.name, ...parseToolArguments(b.input) })));
  return { text, toolCalls, usage: usageOf(body.usage?.input_tokens, body.usage?.output_tokens), stoppedForLength: body.stop_reason === "max_tokens" };
}

/** callModel({ messages }) -> { text, toolCalls, model }. Same contract as the other adapters. */
export async function callModel({
  messages,
  tools = [], // the agent's tools, in the internal format (agent/tools.js); none means a plain text request
  signal, // aborts the request when the person presses Stop
  model: modelOverride, // run exactly this model (used for summaries)
  maxOutputTokens,
  maxRetries = MAX_RETRIES,
  baseDelayMs = BASE_DELAY_MS,
  label = "step",
  fetchImpl = fetch,
  timeoutMs, // give up on one request after this long (none by default)
  credentials // { apiKey, model } to use instead of the saved settings, to test a key
}) {
  const model = modelOverride || credentials?.model || getSettings().model("claude");
  const signals = [timeoutMs ? AbortSignal.timeout(timeoutMs) : null, signal ?? null].filter(Boolean);
  const send = signals.length ? (url, init) => fetchImpl(url, { ...init, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] }) : fetchImpl;
  const shaped = shape(messages);
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await generate(model, shaped, { maxOutputTokens, label, fetchImpl: send, credentials, tools });
      return { text: r.text || (r.toolCalls.length ? "" : "(no response)"), toolCalls: r.toolCalls, model, usage: r.usage, stoppedForLength: r.stoppedForLength };
    } catch (e) {
      if (!(e instanceof ClaudeError) || !isRetryable(e) || attempt >= maxRetries) throw e;
      const delay = baseDelayMs * 2 ** attempt * (0.75 + Math.random() * 0.5);
      console.error(`[multiplayer-ai] claude returned ${e.status}; retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
}
