import { asStore, defaultStore } from "../store/index.js";
import { bestEffort } from "../store/best-effort.js";
import { ApiError } from "../errors.js";
import { isAway, nameKey } from "../auth.js";
import { authenticateWriter } from "../rooms.js";
import { nudge } from "../hub.js";
import { DEFAULT_CALLER } from "../host-actions.js";
import { getControl } from "../control.js";
import { escapeForLog } from "../safe-text.js";

// Who holds the steering seat (PRD §13):
//   • Taking it for yourself is allowed only when nobody holds it, or the
//     controller is Away. Otherwise the controller has to hand it over.
//   • Handing it to someone else (`target`) is the controller's call alone, and
//     the target must be here.
// The caller is identified by their token, never by a name they send.
//
// When the app is shared (Same Wi-Fi, or in a container) the host decides, by the room's control policy:
//   • the host (the sign-in cookie holder) changes control at any time, immediately;
//   • Locked: nobody else changes control;
//   • Ask me (the default): a guest's request, or a guest controller's handoff to another guest, waits for
//     the host to approve it in their browser (it runs out after 5 minutes, and shows as a line in the room);
//   • Allow freely: the rules above, for guests.
export async function takeControl(
  { session_id, token, target },
  { db = defaultStore(), caller = DEFAULT_CALLER, control = getControl() } = {}
) {
  const { me, session } = await authenticateWriter(db, { session_id, token });

  const store = asStore(db);
  const shared = Boolean(caller.sharing && store.local);
  const rows = await store.listParticipants(session_id, { columns: store.local ? "name, role, last_seen, is_host" : "name, role, last_seen" });
  const controller = rows.find((p) => p.role === "controller");

  const wantsOther = typeof target === "string" && target.trim() && nameKey(target.trim()) !== nameKey(me.name);
  let next;
  let override = false; // the host's own takeover or handoff skips the "held and here" rule

  if (shared && caller.host) {
    override = true;
    if (!caller.direct && !me.is_host) await store.updateParticipant(session_id, me.name, { is_host: true });
  } else if (shared) {
    const policy = session.control_policy ?? "ask";
    if (policy === "locked") {
      throw new ApiError(403, "CONTROL_LOCKED", "The host has locked control, so only the host can change who is steering. Ask the host.");
    }
    if (policy === "ask") {
      if (wantsOther) {
        if (!controller || controller.name !== me.name) {
          throw new ApiError(403, "NOT_CONTROLLER", `Only the controller${controller ? ` (${controller.name})` : ""} can hand control to someone else.`);
        }
        const wanted = rows.find((p) => nameKey(p.name) === nameKey(target.trim()));
        if (!wanted) throw new ApiError(404, "NOT_FOUND", `"${target}" is not in this room.`);
        if (!wanted.is_host) return askHost({ store, control, session_id, kind: "handoff", name: me.name, to: wanted.name });
        // Handing control back to the host needs no one's approval.
        next = wanted;
      } else {
        if (controller?.name === me.name) return { controller: me.name }; // already yours
        return askHost({ store, control, session_id, kind: "take", name: me.name });
      }
    }
  }

  if (!next && wantsOther) {
    if (!controller) {
      throw new ApiError(403, "NOT_CONTROLLER", "Nobody is controller right now. Take control for yourself instead.");
    }
    if (controller.name !== me.name && !override) {
      throw new ApiError(
        403,
        "NOT_CONTROLLER",
        `Only the controller (${controller.name}) can hand control to someone else.`
      );
    }
    next = rows.find((p) => nameKey(p.name) === nameKey(target.trim()));
    if (!next) throw new ApiError(404, "NOT_FOUND", `"${target}" is not in this room.`);
    if (isAway(next)) {
      const age = Math.round((Date.now() - new Date(next.last_seen).getTime()) / 1000);
      throw new ApiError(
        409,
        "TARGET_AWAY",
        `Can't hand control to "${next.name}": they're away (last seen ${age}s ago). Hand off to someone who is here.`
      );
    }
  } else if (!next) {
    if (controller?.name === me.name) return { controller: me.name }; // already yours
    if (!override && controller && !isAway(controller)) {
      throw new ApiError(
        403,
        "CONTROL_HELD",
        `${controller.name} is driving and is here. Ask them to hand control to you, or post a comment to the room.`
      );
    }
    next = rows.find((p) => p.name === me.name);
  }

  // One controller, everyone else a watcher
  await store.setController(session_id, next.name);

  // Write takeover event so all clients see the change
  await bestEffort(
    store.insertEvent({ session_id, kind: "takeover", author: next.name, content: `${next.name} took control.` }),
    "takeover"
  );
  nudge(session_id);

  return { controller: next.name };
}

// A request waits for the host. Asking again for the same thing returns the request already waiting.
async function askHost({ store, control, session_id, kind, name, to = null }) {
  const request = control.add({ sessionId: session_id, kind, name, to });
  if (request.created) {
    // Names are checked when they are set, but one saved before that was checked may still hold a control character.
    const [who, whom] = [escapeForLog(name), escapeForLog(to)];
    const line = kind === "handoff" ? `${who} asked to hand control to ${whom}. The host has to approve it.` : `${who} asked for control. The host has to approve it.`;
    await bestEffort(store.insertEvent({ session_id, kind: "status", author: "system", content: line }), "status");
    console.error(`[multiplayer-ai] ${line.replace(" The host has to approve it.", "")} Approve or deny it in your browser.`);
    nudge(session_id);
  }
  return { pending: true, request_id: request.id, expires_at: new Date(request.expiresAt).toISOString() };
}
