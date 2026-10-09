// Who is calling? A participant is identified by a secret token the server
// issued when they created or joined a room. Only its SHA-256 hash is stored,
// so a database leak does not hand out working credentials. The token is long
// and random, which is why a plain fast hash is enough here.
//
// Every tool that acts for a participant calls authenticate() and uses the name
// and role it returns. A name sent by the client is never trusted.
import crypto from "node:crypto";
import { ApiError } from "./errors.js";
import { AWAY_AFTER_MS } from "./presence.js";
import { asStore } from "./store/index.js";
import { nameKey as storeNameKey } from "./store/names.js";
import { hasUnsafeChars } from "./safe-text.js";

export const TOKEN_PREFIX = "mpai_";
export const MAX_NAME_CHARS = 40;
export const RESERVED_NAMES = ["agent", "system"]; // authors the server writes as

// What a client may see of a participant. Never the token hash or its dates.
export const PARTICIPANT_COLUMNS = "session_id, name, role, last_seen";

export const newToken = () => TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
export const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

export function tokenTtlMs() {
  const days = Number(process.env.TOKEN_TTL_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : 30) * 24 * 60 * 60 * 1000;
}

/** A fresh credential: the plaintext token (give it out once) and the columns to store. */
export function newCredential(now = Date.now()) {
  const token = newToken();
  return {
    token,
    columns: {
      token_hash: hashToken(token),
      token_expires_at: new Date(now + tokenTtlMs()).toISOString(),
      token_revoked_at: null
    }
  };
}

export const isAway = (participant, now = Date.now()) =>
  now - new Date(participant.last_seen).getTime() > AWAY_AFTER_MS;

// A participant row whose token can still be used: not revoked, not expired.
// Rows from before tokens existed have no expiry, so they are never live.
export const tokenIsLive = (row, now = Date.now()) =>
  !row.token_revoked_at && Boolean(row.token_expires_at) && new Date(row.token_expires_at).getTime() > now;

const invalidToken = () =>
  new ApiError(401, "INVALID_TOKEN", "Your access to this room has expired or isn't valid. Rejoin the room with your name.");

/**
 * Resolves a token to { session_id, name, role, last_seen } or throws.
 * The token must belong to `session_id`: a token for room A is refused in room B.
 */
export async function authenticate(db, { session_id, token }) {
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX) || token.length > 200) throw invalidToken();
  const data = await asStore(db).findByTokenHash(hashToken(token));
  if (!data || !tokenIsLive(data)) throw invalidToken();
  if (data.session_id !== session_id) {
    throw new ApiError(403, "FORBIDDEN", "That access is for a different room.");
  }
  return { session_id: data.session_id, name: data.name, role: data.role, last_seen: data.last_seen, is_host: Boolean(data.is_host) };
}

/** Same as authenticate(), and the person must currently be the controller. */
export async function authenticateController(db, args) {
  const me = await authenticate(db, args);
  if (me.role !== "controller") {
    throw new ApiError(403, "NOT_CONTROLLER", "Only the controller can do that.");
  }
  return me;
}

/** Marks a participant's token revoked (an operator action; no tool exposes it). */
export async function revokeToken(db, { session_id, name }) {
  await asStore(db).revokeToken(session_id, name);
}

// ── Names ───────────────────────────────────────────────────────────

/**
 * Trimmed display name, with runs of spaces made one. A name that holds a control character, a
 * text-direction mark or any other character that is not meant to be printed is refused, not cleaned:
 * what the person typed is not what would be shown.
 */
export function normalizeName(raw) {
  if (hasUnsafeChars(raw)) {
    throw new ApiError(400, "INVALID_NAME", "Names can't contain control characters, line breaks or text-direction marks. Use letters, numbers and ordinary punctuation.");
  }
  const name = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!name) throw new ApiError(400, "INVALID_NAME", "Enter a name to join with.");
  if (name.length > MAX_NAME_CHARS) {
    throw new ApiError(400, "INVALID_NAME", `Names can be up to ${MAX_NAME_CHARS} characters.`);
  }
  if (RESERVED_NAMES.includes(name.toLowerCase())) {
    throw new ApiError(400, "INVALID_NAME", `"${name}" is reserved. Pick a different name.`);
  }
  return name;
}

/** What "the same name" means: letter case and compatibility forms ignored. */
export const nameKey = storeNameKey;

/** "Sam" -> "Sam 2", "Sam 3", ... the first one nobody in the room has. */
export function suggestName(name, takenKeys) {
  for (let n = 2; n < 100; n++) {
    const suffix = ` ${n}`;
    const candidate = name.slice(0, MAX_NAME_CHARS - suffix.length) + suffix;
    if (!takenKeys.has(nameKey(candidate))) return candidate;
  }
  return `${name.slice(0, MAX_NAME_CHARS - 5)} ${crypto.randomInt(100, 1000)}`;
}
