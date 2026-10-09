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

/** A model call that failed. `message` is the category message; `detail` is the redacted upstream text for the terminal. */
export class ProviderFailure extends Error {
  constructor(category, { status = null, detail = "", provider = null } = {}) {
    super(CATEGORY_MESSAGES[category] ?? CATEGORY_MESSAGES.UNKNOWN);
    this.name = "ProviderFailure";
    this.category = category;
    this.status = status;
    this.detail = detail;
    this.provider = provider;
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
  return new ProviderFailure(categoryOf(e), { status: statusOf(e), detail, provider });
}
