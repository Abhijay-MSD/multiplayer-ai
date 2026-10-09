// What every adapter needs for tool calling, in one place.
//
// The internal message format the agent loop speaks (providers turn it into their own shape):
//   { role: "system" | "user", content }
//   { role: "assistant", content, toolCalls?: [{ id, name, args, argsError?, rawArgs? }], raw? }
//   { role: "tool", toolCallId, name, content, isError? }
// `raw` is whatever an adapter wants back to replay the model's own turn exactly (Gemini keeps its parts, which may carry
// signatures this code doesn't understand). An adapter's callModel returns
//   { text, toolCalls, model, usage: { inputTokens, outputTokens } | null, raw? }
// where `usage` is null when the provider didn't report it: a count is never estimated.

const MAX_ARGUMENT_CHARS = 1_000_000; // a model that sends more than this isn't making a file for a room; it is not even parsed

/** Index of the first tool-related message, to split a conversation into the plain part and the tool part. */
export function splitAtTools(messages) {
  const at = messages.findIndex((m) => m.role === "tool" || (m.role === "assistant" && m.toolCalls?.length));
  return at === -1 ? { prefix: messages, tail: [] } : { prefix: messages.slice(0, at), tail: messages.slice(at) };
}

/** { args } or { args: null, argsError } from the arguments as a model sent them: a JSON string, an object, or nothing. */
export function parseToolArguments(raw) {
  if (raw === undefined || raw === null || raw === "") return { args: {} };
  if (typeof raw === "object" && !Array.isArray(raw)) return { args: raw };
  if (typeof raw !== "string") return { args: null, argsError: "malformed" };
  if (raw.length > MAX_ARGUMENT_CHARS) return { args: null, argsError: "too large" };
  try {
    const value = JSON.parse(raw);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return { args: value };
  } catch {
    // fall through
  }
  return { args: null, argsError: "malformed" };
}

/** Every call gets an id that is text and different from the others, and a name that is text. */
export function normalizeToolCalls(calls) {
  if (!Array.isArray(calls)) return [];
  const seen = new Set();
  return calls.map((c, i) => {
    let id = typeof c?.id === "string" && c.id ? c.id : `call_${i + 1}`;
    while (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    return { ...c, id, name: typeof c?.name === "string" ? c.name : "" };
  });
}

/** { inputTokens, outputTokens } from the numbers a provider reported, or null if it reported neither. */
export function usageOf(input, output) {
  const n = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
  const i = n(input);
  const o = n(output);
  return i === null && o === null ? null : { inputTokens: i, outputTokens: o };
}

const MENTIONS_TOOLS = /\b(tools?|tool[ _-]?(use|calling|choice)|function[ _-]?calling|functions?)\b/i;
const SAYS_NO = /not (be )?(supported|enabled|available|allowed|recogni[sz]ed|valid)|unsupported|does(?:n't| not) support|unrecogni[sz]ed|unknown|invalid|can ?not|isn't|disabled/i;

/**
 * Did the provider turn this request down because of the tools in it? `failure` is a ProviderFailure ({ status, detail }).
 * Only a 400 or 422 that talks about tools and says no counts: a bad key, a busy provider and a bad model name must not
 * be mistaken for it, or a real failure would be hidden behind a quiet switch to text.
 */
export function toolsRejected(failure) {
  if (!failure || ![400, 422].includes(failure.status)) return false;
  const text = String(failure.detail ?? "");
  return MENTIONS_TOOLS.test(text) && SAYS_NO.test(text);
}
