import { defaultStore } from "../store/index.js";
import { ApiError } from "../errors.js";
import { authenticate } from "../auth.js";
import { stopRoom } from "./step_agent.js";

// Stop: the controller, or a person who joined as the host, ends the step that is running in the room. The request to the model
// is aborted, the room is told who stopped it, files already written stay, and messages waiting behind it are dropped (and said
// to be). With nothing running it does nothing and says so. A guest who isn't steering can't.
export async function stopAgent({ session_id, token }, { db = defaultStore() } = {}) {
  const me = await authenticate(db, { session_id, token });
  if (me.role !== "controller" && !me.is_host) {
    throw new ApiError(403, "NOT_ALLOWED", "Only the controller or the host can stop the agent.");
  }
  return stopRoom(session_id, me.name);
}
