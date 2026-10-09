import { asStore, defaultStore } from "../store/index.js";
import { ApiError } from "../errors.js";
import { authenticate } from "../auth.js";
import { participantPublicFor } from "../store/index.js";
import { DEFAULT_CALLER } from "../host-actions.js";
import { roomInfo } from "../rooms.js";

// Participants only: the room's metadata, who is in it, and the full transcript.
export async function getSession({ session_id, token }, { db = defaultStore(), caller = DEFAULT_CALLER } = {}) {
  await authenticate(db, { session_id, token });

  const store = asStore(db);
  const [session, events, participants] = await Promise.all([
    store.getSession(session_id),
    store.listEvents(session_id),
    store.listParticipants(session_id, { columns: participantPublicFor(store) })
  ]);

  if (!session) throw new ApiError(404, "ROOM_NOT_FOUND", "This room doesn't exist.");

  return { session, room: { ...roomInfo(session), sharing: Boolean(caller.sharing && store.local) }, participants, events };
}
