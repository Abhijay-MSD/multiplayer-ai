// Rate limits and size limits.
//
// Rate limits are in memory: a sliding window of timestamps per key. They reset
// when the server restarts, which is fine because the step queue is in memory
// too (one server process). The daily step budget is different: it is stored in
// the database (budget.js) so a restart can't refill it.
//
// Keys: an IP for creating and joining rooms, and "session|name" for messages.
// The name comes from the authenticated token, never from the client.
import { ApiError } from "./errors.js";
import { intSetting } from "./config.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_KEYS = 50_000; // memory bound per limiter; the oldest idle keys go first

// What an "off" limit is: it records nothing and refuses nothing.
const NO_LIMIT = { hit: () => ({ ok: true }), prune() {}, size: 0 };

/** A sliding-window limiter. `hit(key)` records an attempt and says whether it fits. */
export function createLimiter({ limit, windowMs, now = Date.now, maxKeys = MAX_KEYS }) {
  const hits = new Map(); // key -> timestamps inside the window, oldest first

  const live = (key, t) => {
    const stamps = hits.get(key);
    if (!stamps) return null;
    while (stamps.length && stamps[0] <= t - windowMs) stamps.shift();
    if (!stamps.length) {
      hits.delete(key);
      return null;
    }
    return stamps;
  };

  return {
    /** { ok: true } and the attempt is recorded, or { ok: false, retryAfter } in whole seconds and nothing is recorded. */
    hit(key) {
      const t = now();
      const stamps = live(key, t) ?? [];
      if (stamps.length >= limit) {
        return { ok: false, retryAfter: Math.max(1, Math.ceil((stamps[0] + windowMs - t) / 1000)) };
      }
      stamps.push(t);
      hits.set(key, stamps);
      if (hits.size > maxKeys) this.prune(); // bound memory under a flood of distinct keys
      return { ok: true };
    },
    /** Is `key` still under the limit? Records nothing. { ok: true } or { ok: false, retryAfter } in whole seconds. */
    peek(key) {
      const t = now();
      const stamps = live(key, t);
      if (stamps && stamps.length >= limit) return { ok: false, retryAfter: Math.max(1, Math.ceil((stamps[0] + windowMs - t) / 1000)) };
      return { ok: true };
    },
    /** Forget keys whose window has passed; if still over the bound, drop the oldest. */
    prune() {
      const t = now();
      for (const key of [...hits.keys()]) live(key, t);
      while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
    },
    get size() {
      return hits.size;
    }
  };
}

// An IPv6 caller can rotate through a whole /64 at no cost, so the first four
// groups are the key. IPv4-mapped addresses count as their IPv4 address.
export function ipKey(ip) {
  if (!ip) return null;
  const s = String(ip).toLowerCase().replace(/^::ffff:/, "");
  if (!s.includes(":")) return s;
  const groups = s.split("::")[0].split(":");
  return groups.slice(0, 4).join(":") + "::/64";
}

const limited = (what, retryAfter) =>
  new ApiError(429, "RATE_LIMITED", what, { retry_after: retryAfter });

const wait = (s) => {
  if (s < 60) return `${s} ${s === 1 ? "second" : "seconds"}`;
  const m = Math.ceil(s / 60);
  return `${m} ${m === 1 ? "minute" : "minutes"}`;
};

/**
 * The limiters the tools use. Limits are read from the environment when the set
 * is built (once, at startup); tests build their own with a clock they control.
 */
export function createLimits({ env = process.env, now = Date.now, local = false } = {}) {
  const make = (name, windowMs) => createLimiter({ limit: intSetting(name, env), windowMs, now });
  // On a local store the per-IP limits are off unless set: everyone who can reach
  // the app is on the host's own network, and the host's per-room step cap still applies.
  const makeIp = (name) =>
    local && !String(env[name] ?? "").trim() ? NO_LIMIT : make(name, HOUR);
  const create = makeIp("CREATE_LIMIT_PER_HOUR");
  const join = makeIp("JOIN_LIMIT_PER_HOUR");
  const directive = make("DIRECTIVE_LIMIT_PER_MIN", MINUTE);
  // Only wrong invite secrets are counted (see checkInvite / failInvite); right ones and token holders never are.
  const invite = createLimiter({ limit: intSetting("INVITE_FAILURES_PER_10_MIN", env), windowMs: 10 * MINUTE, now });
  const comment = make("COMMENT_LIMIT_PER_MIN", MINUTE);

  // An unknown IP (a call that didn't come over HTTP, such as MCP) is not limited by IP.
  const byIp = (limiter, what) => (ip) => {
    const key = ipKey(ip);
    if (!key) return;
    const r = limiter.hit(key);
    if (!r.ok) throw limited(what(r.retryAfter), r.retryAfter);
  };
  const byPerson = (limiter, what) => (session_id, name) => {
    const r = limiter.hit(`${session_id}|${name}`);
    if (!r.ok) throw limited(what(r.retryAfter), r.retryAfter);
  };

  return {
    checkCreate: byIp(create, (s) => `Too many rooms were started from this connection. Wait about ${wait(s)}, then try again.`),
    checkJoin: byIp(join, (s) => `Too many people joined rooms from this connection. Wait about ${wait(s)}, then try again.`),
    checkInvite(ip) {
      const key = ipKey(ip);
      if (!key) return;
      const r = invite.peek(key);
      if (!r.ok) throw limited(`Too many wrong invite links were tried from this connection. Wait about ${wait(r.retryAfter)}, then try again.`, r.retryAfter);
    },
    failInvite(ip) {
      const key = ipKey(ip);
      if (key) invite.hit(key);
    },
    checkDirective: byPerson(directive, (s) => `You're sending messages to the agent too fast. Wait ${wait(s)} and send it again.`),
    checkComment: byPerson(comment, (s) => `You're posting comments too fast. Wait ${wait(s)} and post it again.`),
    prune() {
      [create, join, directive, comment, invite].forEach((l) => l.prune());
    }
  };
}

// The limits the tools use when a caller doesn't pass its own. Replaced at
// startup by a local-mode set (useLimits) when the store is local.
let current = createLimits();
export const defaultLimits = {
  checkCreate: (ip) => current.checkCreate(ip),
  checkJoin: (ip) => current.checkJoin(ip),
  checkInvite: (ip) => current.checkInvite(ip),
  failInvite: (ip) => current.failInvite(ip),
  checkDirective: (session_id, name) => current.checkDirective(session_id, name),
  checkComment: (session_id, name) => current.checkComment(session_id, name),
  prune: () => current.prune()
};
export const useLimits = (limits) => {
  current = limits;
};

// Housekeeping so idle keys don't pile up between hits.
setInterval(() => defaultLimits.prune(), 10 * MINUTE).unref();

// ── Sizes ──────────────────────────────────────────────────────────

/** Up to `max` characters of `text`, cut on a whole character (never half of an emoji). */
export const truncateChars = (text, max) => {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
};

/** Throws a form-friendly 400 when `text` is over the limit. Length counts UTF-16 units, as the browser's maxLength does. */
export function assertMaxLength(text, max, what) {
  if (text.length > max) {
    throw new ApiError(
      400,
      "BAD_REQUEST",
      `${what} is too long: ${text.length.toLocaleString("en-US")} characters, and the limit is ${max.toLocaleString("en-US")}. Shorten it and try again.`
    );
  }
}

export const maxMessageChars = () => intSetting("MAX_MESSAGE_CHARS");
export const maxTitleChars = () => intSetting("MAX_TITLE_CHARS");
export const maxParticipants = () => intSetting("MAX_PARTICIPANTS_PER_ROOM");
