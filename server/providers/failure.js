// What went wrong when a model call failed, in a few categories.
//
// People in a room see only the category message. The provider's own words can
// contain an account name, a project, a quota figure or part of a key, so they go to
// the host's terminal (redacted) and nowhere else.
import { redact } from "../secrets.js";
import { escapeForLog } from "../safe-text.js";

export const CATEGORY_MESSAGES = {
  NO_KEY: "No API key is set up yet. The host needs to add one in Settings.",
  BAD_KEY: "The model provider didn't accept the API key. The host needs to check it in Settings.",
  NO_QUOTA: "The model provider says this key is out of quota or is being rate limited.",
  BUSY: "The model provider is busy right now. Try again in a moment.",
  NETWORK: "The host's computer couldn't reach the model provider.",
  TIMEOUT: "The model provider took too long to answer.",
  MODEL_NOT_FOUND: "The model provider doesn't know the model or address in Settings. The host needs to check them.",
  BAD_SETTINGS: "The provider settings are incomplete or not usable. The host needs to check them in Settings.",
  UNKNOWN: "Something went wrong on the host's computer. The details are in its terminal."
};

// ── how long the provider says to wait ──────────────────────────────

const MAX_HINT_SECONDS = 3600; // a hint of more than an hour is not a wait someone sits through: it is treated as no hint
const UNIT_SECONDS = { ms: 0.001, millisecond: 0.001, milliseconds: 0.001, s: 1, sec: 1, secs: 1, second: 1, seconds: 1, m: 60, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600 };
const UNIT = "milliseconds?|ms|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s";
const PART = `\\d+(?:\\.\\d+)?\\s*(?:${UNIT})(?![a-z])`;
const ONLY_PARTS = new RegExp(`^\\s*(?:${PART}\\s*)+$`, "i");
const EACH_PART = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT})(?![a-z])`, "gi");
// "try again in 29.91s", "retry in 1m4.2s", "retry after 9 seconds": the phrase, then a duration
const PHRASE = new RegExp(`\\b(?:try again|retry)\\s+(?:in|after)\\s+((?:${PART}\\s*)+)`, "i");
// a JSON field such as "retryDelay": "30s", possibly inside text that was itself JSON-escaped
const FIELD = /retryDelay\\*"\s*:\s*\\*"([^"\\]+)\\*"/i;

/** A duration such as "29.91s", "850ms", "1m4.2s", "2m" or "1h2m3s" as a number of seconds, or null when it is not one. */
export function parseDuration(text) {
  const s = String(text ?? "");
  if (!ONLY_PARTS.test(s)) return null;
  let total = 0;
  for (const m of s.matchAll(EACH_PART)) total += Number(m[1]) * UNIT_SECONDS[m[2].toLowerCase()];
  return total;
}

/** Whole seconds, rounded up, or null when the number is not usable: not a number, below nothing, or over an hour. */
function wholeSeconds(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const whole = Math.ceil(seconds);
  return whole > MAX_HINT_SECONDS ? null : whole;
}

/** A Retry-After header: a number of seconds, or an HTTP date. null when it is neither, or not usable. */
function fromHeader(value, now) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const v = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(v)) return wholeSeconds(Number(v));
  const at = Date.parse(v);
  return Number.isFinite(at) && /[a-z]/i.test(v) ? wholeSeconds((at - now) / 1000) : null;
}

function fromText(text) {
  const s = typeof text === "string" ? text : "";
  const field = FIELD.exec(s);
  const phrase = PHRASE.exec(s);
  for (const found of [field?.[1], phrase?.[1]]) {
    if (found === undefined) continue;
    const d = parseDuration(found);
    if (d !== null) return wholeSeconds(d);
  }
  return null;
}

/**
 * How many whole seconds the provider says to wait, or null. A usable Retry-After header (`header`, as it came) wins; otherwise the
 * error's own words (`text`) are read. A hint that is not usable is no hint; a header that is not usable does not stop the text
 * from being read.
 */
export function hintFrom({ header = null, text = "", now = Date.now() } = {}) {
  return fromHeader(header, now) ?? fromText(text);
}

/** A model call that failed. `message` is the category message; `detail` is the redacted upstream text for the terminal. */
export class ProviderFailure extends Error {
  constructor(category, { status = null, detail = "", provider = null, retryAfterSeconds = null } = {}) {
    super(CATEGORY_MESSAGES[category] ?? CATEGORY_MESSAGES.UNKNOWN);
    this.name = "ProviderFailure";
    this.category = category;
    this.status = status;
    this.detail = detail;
    this.provider = provider;
    this.retryAfterSeconds = retryAfterSeconds; // whole seconds the provider said to wait, or null
  }
}

/** Thrown by an adapter when there is no key to use. */
export class NoKeyError extends Error {
  constructor(provider, label) {
    super(`No ${label} API key is set up. Add one in Settings.`);
    this.name = "NoKeyError";
    this.category = "NO_KEY";
    this.provider = provider;
  }
}

/** Thrown by an adapter when its settings (address, model) can't be used. */
export class BadSettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = "BadSettingsError";
    this.category = "BAD_SETTINGS";
  }
}

const NETWORK_CODES = /^(ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|CERT_|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|ERR_TLS|ERR_SSL|UND_ERR_SOCKET|UND_ERR_CONNECT)/;

function statusOf(e) {
  if (typeof e?.status === "number") return e.status;
  const m = /\[(\d{3})[ \]]/.exec(String(e?.message ?? ""));
  return m ? Number(m[1]) : null;
}

/** Which category an error belongs to. Reads the error's status, code and (as a last resort) wording. */
export function categoryOf(e) {
  if (e?.category && CATEGORY_MESSAGES[e.category]) return e.category;
  const message = String(e?.message ?? "");
  const code = String(e?.cause?.code ?? e?.code ?? "");
  const status = statusOf(e);

  if (e?.name === "TimeoutError" || e?.name === "AbortError" || /aborted|timed? ?out|timeout/i.test(message)) return "TIMEOUT";
  if (NETWORK_CODES.test(code) || /fetch failed|network|getaddrinfo|socket hang up|certificate|self.signed/i.test(message) && status === null) return "NETWORK";
  if (status === 401 || status === 403) return "BAD_KEY";
  if (status === 400 && /api key not valid|api_key_invalid|invalid api key|incorrect api key|invalid_api_key/i.test(message)) return "BAD_KEY";
  if (status === 429) return "NO_QUOTA";
  if (status === 404) return "MODEL_NOT_FOUND";
  if (status === 400 && /model.*(not found|does not exist|decommission|not supported)|unknown model/i.test(message)) return "MODEL_NOT_FOUND";
  if (status !== null && status >= 500) return "BUSY";
  return "UNKNOWN";
}

/** Wraps any error from a model call as a ProviderFailure with a category and a redacted detail line. */
export function toProviderFailure(e, provider = null) {
  if (e instanceof ProviderFailure) return e;
  const detail = escapeForLog(redact(String(e?.message ?? e).split("\n")[0]).slice(0, 300));
  // The hint is read from the whole of what the provider said (the header an adapter kept, the message, and the structured details
  // some providers send), before the detail is cut for the terminal.
  const text = `${String(e?.message ?? e)}\n${e?.errorDetails !== undefined ? safeJson(e.errorDetails) : ""}`;
  return new ProviderFailure(categoryOf(e), { status: statusOf(e), detail, provider, retryAfterSeconds: hintFrom({ header: e?.retryAfter, text }) });
}

function safeJson(v) {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}
