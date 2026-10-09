import { asStore, defaultStore } from "../store/index.js";
import { triggerStep } from "./step_agent.js";
import { ApiError } from "../errors.js";
import { authenticateWriter } from "../rooms.js";
import { nudge } from "../hub.js";
import { assertMaxLength, defaultLimits, maxMessageChars } from "../limits.js";
import { defaultBudget } from "../budget.js";
import { DEFAULT_CALLER, countGuestMessages, guestCapFor } from "../host-actions.js";

// Only the current controller can steer the agent (PRD §13). Who the caller is
// comes from their token, and their role is read from the database at the
// moment the directive is written, so a handoff that landed a moment earlier is
// respected even if the sender's screen still shows the old state.
//
// `deps` is a test seam: a fake db and a trigger stub.
export async function sendDirective(
  { session_id, token, content },
  { db = defaultStore(), trigger = triggerStep, limits = defaultLimits, budget = defaultBudget, caller = DEFAULT_CALLER, env = process.env } = {}
) {
  const { me, session } = await authenticateWriter(db, { session_id, token });

  if (me.role !== "controller") {
    const rows = await asStore(db).listParticipants(session_id, { columns: "name, role" });
    const controller = rows.find((p) => p.role === "controller");
    throw new ApiError(
      403,
      "NOT_CONTROLLER",
      controller
        ? `Only the controller (${controller.name}) can message the agent. ` +
            "Ask them to hand control to you, or post a comment to the room instead."
        : "Nobody is controller right now, so nobody can message the agent. Take control first."
    );
  }

  const text = typeof content === "string" ? content.trim() : "";
  if (!text) throw new ApiError(400, "BAD_REQUEST", "A message can't be empty.");
  assertMaxLength(text, maxMessageChars(), "That message");

  // When shared, guests may send only so many messages to the agent in a room: the host's key pays for each.
  const store = asStore(db);
  if (caller.sharing && store.local && !me.is_host && !caller.host) {
    const cap = guestCapFor(session, env);
    if ((await countGuestMessages(store, session_id)) >= cap) {
      throw new ApiError(
        429,
        "GUEST_CAP",
        `The host's limit of ${cap} ${cap === 1 ? "message" : "messages"} from guests in this room has been reached. The host can raise it.`
      );
    }
  }

  // Pace first, then spend: a message refused for speed costs no step.
  limits.checkDirective(session_id, me.name);
  await budget.claim(db);

  const event = await asStore(db).insertEvent({ session_id, kind: "directive", author: me.name, content: text });
  nudge(session_id);

  // Queue a reply in the background (PRD FR-8). Replies are strictly serial per
  // session, one per directive, in send order. The reply arrives on the live
  // stream as an agent_message; this request does not wait for the model. If
  // control changes while this is queued, the directive stays attributed to its
  // sender and is still answered.
  trigger(session_id, event.id);

  return { event };
}
