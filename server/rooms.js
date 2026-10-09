// What state is a room in, and what may be done to it?
//
//   open      anyone in it can post.
//   ended     the controller set the status to "done". Read-only.
//   archived  no activity for ARCHIVE_AFTER_DAYS (default 7), or archived by the host from "Your rooms". Read-only. The host
//             can unarchive it there; a room archived by silence is reopened by the first new event the host's unarchive writes.
//
// Archiving is worked out when a room is read, from sessions.updated_at, which
// the database bumps on every new event. Nothing sweeps rooms, and there is
// nothing to undo: a room that has been quiet too long is simply read-only.
// People who were in it can still open it and read; nobody new can join, and
// every write is refused with 410.
import { ApiError } from "./errors.js";
import { authenticate, authenticateController } from "./auth.js";
import { asStore } from "./store/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function archiveAfterDays() {
  const n = Number(process.env.ARCHIVE_AFTER_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

/** "open" | "ended" | "archived". A session with no updated_at counts as fresh. */
export function roomState(session, now = Date.now()) {
  if (session.archived_at) return "archived"; // archived by the host from "Your rooms"
  const last = session.updated_at ? new Date(session.updated_at).getTime() : now;
  if (now - last > archiveAfterDays() * DAY_MS) return "archived"; // checked first
  if (session.status === "done") return "ended";
  return "open";
}

export const roomInfo = (session) => ({
  state: roomState(session),
  archive_after_days: archiveAfterDays(),
  ...(session.archived_at ? { archived_by_host: true } : {}),
  ...(session.control_policy ? { control_policy: session.control_policy } : {}) // local stores only
});

const notWritable = {
  archived: (session) =>
    new ApiError(
      410,
      "ROOM_ARCHIVED",
      session?.archived_at
        ? "The host archived this room. People who were in it can still read it, but nothing new can be posted."
        : `This room was archived after ${archiveAfterDays()} days without activity. People who were in it can still read it, but nothing new can be posted.`
    ),
  ended: () => new ApiError(410, "ROOM_ENDED", "This room has ended. It can still be read, but nothing new can be posted.")
};

/** Throws 410 unless the room accepts new posts. `allowEnded` lets the controller reopen an ended room. */
export function assertWritable(session, { allowEnded = false } = {}) {
  const state = roomState(session);
  if (state === "archived" || (state === "ended" && !allowEnded)) throw notWritable[state](session);
}

export async function loadSession(db, session_id) {
  const data = await asStore(db).getSession(session_id);
  if (!data) throw new ApiError(404, "ROOM_NOT_FOUND", "This room doesn't exist.");
  return data;
}

/**
 * For a tool that writes to a room: who is calling (by token) and the room, read
 * together in one round trip, and a refusal if the room is read-only. A bad token
 * is reported before a read-only room.
 */
export async function authenticateWriter(db, { session_id, token }, { controller = false, allowEnded = false } = {}) {
  const who = controller ? authenticateController : authenticate;
  const [me, session] = await Promise.allSettled([who(db, { session_id, token }), loadSession(db, session_id)]);
  if (me.status === "rejected") throw me.reason;
  if (session.status === "rejected") throw session.reason;
  assertWritable(session.value, { allowEnded });
  return { me: me.value, session: session.value };
}
