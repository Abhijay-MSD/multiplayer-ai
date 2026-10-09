import { asStore, defaultStore } from "../store/index.js";
import { ApiError } from "../errors.js";
import { hashToken } from "../auth.js";

// One round trip: the update only matches a live token for this room, so a
// wrong, expired or revoked token updates nothing and is refused.
export async function touchParticipant(db, { session_id, token, lastSeen }) {
  const now = new Date().toISOString();
  const name = await asStore(db).touchByToken({ sessionId: session_id, tokenHash: hashToken(token ?? ""), lastSeen: lastSeen ?? now, now });
  if (!name) {
    throw new ApiError(401, "INVALID_TOKEN", "Your access to this room has expired or isn't valid. Rejoin the room with your name.");
  }
  return name;
}

export async function heartbeat({ session_id, token }, { db = defaultStore() } = {}) {
  const now = new Date().toISOString();
  await touchParticipant(db, { session_id, token, lastSeen: now });
  return { ok: true, last_seen: now };
}
