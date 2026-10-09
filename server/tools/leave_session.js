import { defaultStore } from "../store/index.js";
import { AWAY_AFTER_MS } from "../presence.js";
import { touchParticipant } from "./heartbeat.js";

// Best-effort "I closed the tab": marks the participant away right now by
// pushing last_seen just past the Away threshold. The row and the token are
// kept (history, identity colour and the controller role survive); a heartbeat
// or re-join brings them back to Here.
export async function leaveSession({ session_id, token }, { db = defaultStore() } = {}) {
  const away = new Date(Date.now() - AWAY_AFTER_MS - 1000).toISOString();
  await touchParticipant(db, { session_id, token, lastSeen: away });
  return { ok: true };
}
