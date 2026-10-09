// Keeping keys out of logs, errors and responses.
//
// redact(text) hides every key this copy knows about (saved, from the environment,
// or being tested right now), in the forms a key turns up in (as is, URL-encoded,
// JSON-escaped), and the usual places a key is echoed: "Bearer ...", "api_key=...",
// "x-goog-api-key: ...", "?key=...".
//
// It matches the keys it knows. A partial or altered copy of a key that an upstream
// service chooses to echo is not something it can recognise.
import util from "node:util";
import { getSettings } from "./settings.js";

export const MASK = "[key hidden]";
const MIN_SECRET_LENGTH = 8; // shorter strings would match ordinary words

const ephemeral = new Set();

/** Treats `secret` as a key until the returned function is called. For a key being tested but not yet saved. */
export function registerSecret(secret) {
  if (typeof secret !== "string" || !secret) return () => {};
  ephemeral.add(secret);
  return () => ephemeral.delete(secret);
}

export function knownSecrets() {
  const out = new Set(ephemeral);
  for (const s of getSettings().allSecrets()) out.add(s);
  return [...out].filter((s) => typeof s === "string" && s.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
}

const forms = (secret) => {
  const list = new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]);
  try {
    list.add(Buffer.from(secret).toString("base64"));
  } catch {
    // not encodable; the other forms still apply
  }
  return [...list];
};

const PATTERNS = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer " + MASK],
  [/((?:x-goog-api-key|x-api-key|api[-_]?key|authorization|access[-_]?token|invite)["']?\s*[:=]\s*["']?)(?!Bearer )(?!\[key hidden\])[^\s"',;}&]{4,}/gi, "$1" + MASK],
  [/([?&](?:key|api_key|apikey|access_token)=)[^&\s"']+/gi, "$1" + MASK],
  [/([#?&]k=)[A-Za-z0-9_-]{16,}/g, "$1" + MASK] // the invite secret in a share link
];

export function redact(text) {
  let out = String(text ?? "");
  for (const secret of knownSecrets()) for (const form of forms(secret)) out = out.split(form).join(MASK);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Hides keys in an error's message and stack, in place, and in its cause. Returns the error. */
export function redactError(e, seen = new Set()) {
  if (!e || typeof e !== "object" || seen.has(e)) return e;
  seen.add(e);
  try {
    if (typeof e.message === "string") e.message = redact(e.message);
    if (typeof e.stack === "string") e.stack = redact(e.stack);
    if (e.cause) redactError(e.cause, seen);
  } catch {
    // a frozen error: nothing more can be done to it
  }
  return e;
}

const METHODS = ["log", "info", "warn", "error", "debug"];

/**
 * Makes console.log/info/warn/error/debug hide keys in everything they print. A second
 * line of defence: no code is meant to print a key, and this is for the day one does.
 * Returns a function that puts the console back.
 */
export function installLogRedaction(target = console) {
  if (target.__multiplayerAiRedaction) return target.__multiplayerAiRedaction.uninstall;
  const originals = {};
  for (const m of METHODS) {
    originals[m] = target[m];
    target[m] = (...args) =>
      originals[m].apply(
        target,
        args.map((a) => {
          if (typeof a === "string") return redact(a);
          if (a instanceof Error) return redactError(a);
          if (a && typeof a === "object") {
            const text = util.inspect(a, { depth: 6, breakLength: Infinity });
            const clean = redact(text);
            return clean === text ? a : clean;
          }
          return a;
        })
      );
  }
  const uninstall = () => {
    for (const m of METHODS) target[m] = originals[m];
    delete target.__multiplayerAiRedaction;
  };
  Object.defineProperty(target, "__multiplayerAiRedaction", { value: { uninstall }, configurable: true });
  return uninstall;
}
