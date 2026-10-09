import { asStore, defaultStore } from "../store/index.js";
import { authenticateWriter } from "../rooms.js";
import { nudge } from "../hub.js";
import { bestEffort } from "../store/best-effort.js";

// Controller only: pause, resume or end the session. An ended room can be
// reopened this way; an archived one cannot (see rooms.js).
export async function setStatus({ session_id, token, status }, { db = defaultStore() } = {}) {
  await authenticateWriter(db, { session_id, token }, { controller: true, allowEnded: true });

  const store = asStore(db);
  await store.updateSession(session_id, { status });
  await bestEffort(
    store.insertEvent({ session_id, kind: "status", author: "system", content: `Session status changed to "${status}".` }),
    "status"
  );
  nudge(session_id);

  return { session_id, status };
}
