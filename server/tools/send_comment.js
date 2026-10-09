import { asStore, defaultStore } from "../store/index.js";
import { ApiError } from "../errors.js";
import { authenticateWriter } from "../rooms.js";
import { nudge } from "../hub.js";
import { assertMaxLength, defaultLimits, maxMessageChars } from "../limits.js";

// A comment is room chat. Any participant can post one, the controller
// included. It never queues an agent step, never touches agent_working, and is
// kept out of the model context (see context.js).
export async function sendComment({ session_id, token, content }, { db = defaultStore(), limits = defaultLimits } = {}) {
  const { me } = await authenticateWriter(db, { session_id, token });

  const text = (content ?? "").trim();
  if (!text) throw new ApiError(400, "BAD_REQUEST", "A comment can't be empty.");
  assertMaxLength(text, maxMessageChars(), "That comment");
  limits.checkComment(session_id, me.name);

  const event = await asStore(db).insertEvent({ session_id, kind: "comment", author: me.name, content: text });
  nudge(session_id);
  return { event };
}
