import { asStore, defaultStore } from "../store/index.js";
import { ApiError } from "../errors.js";
import { authenticateWriter } from "../rooms.js";
import { sendDirective } from "./send_directive.js";
import { stepInProgressFor } from "./step_agent.js";

// Retry: the controller's last message, sent again. It is a new message in the room, written by the same person with the same
// words, and it goes through sendDirective, so every rule for a message applies to it: only the controller, the host's limit on
// guest messages, the pace, the daily budget and the step cap. It is refused while the agent is working. Nothing here keeps the
// old reply or hides it: the room shows both.
export async function retryLast({ session_id, token }, opts = {}) {
  const { db = defaultStore() } = opts;
  const { me, session } = await authenticateWriter(db, { session_id, token });
  if (me.role !== "controller") throw new ApiError(403, "NOT_CONTROLLER", "Only the controller can send a message to the agent again.");
  if (session.agent_working || stepInProgressFor(session_id)) throw new ApiError(409, "AGENT_WORKING", "The agent is working. Wait for it to finish, or stop it, then try again.");
  const mine = (await asStore(db).listEvents(session_id, { kinds: ["directive"], order: "desc" })).find((e) => e.author === me.name);
  if (!mine) throw new ApiError(404, "NOTHING_TO_RETRY", "There is no earlier message from you to send again.");
  return sendDirective({ session_id, token, content: mine.content }, opts);
}
