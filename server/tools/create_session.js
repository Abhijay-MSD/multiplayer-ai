import { asStore, defaultStore } from "../store/index.js";
import { bestEffort } from "../store/best-effort.js";
import { ApiError } from "../errors.js";
import { newCredential, normalizeName } from "../auth.js";
import { triggerStep } from "./step_agent.js";
import { assertMaxLength, defaultLimits, maxMessageChars, maxTitleChars, truncateChars } from "../limits.js";
import { defaultBudget } from "../budget.js";
import { publicBaseUrl } from "../config.js";
import { getSettings } from "../settings.js";
import { DEFAULT_CALLER } from "../host-actions.js";
import { hasUnsafeChars, plainLabel } from "../safe-text.js";

/**
 * Starts a room and makes the caller its controller. The task is saved as the
 * first directive. With `auto_start` the agent answers it straight away (the web
 * app does this); without it nothing runs until step_agent is called, as before.
 */
export async function createSession(
  { task, title, creator_name, auto_start = false },
  { db = defaultStore(), trigger = triggerStep, ip, limits = defaultLimits, budget = defaultBudget, keyCheck = () => getSettings().configured(), caller = DEFAULT_CALLER } = {}
) {
  // When the app is shared, only the host starts rooms: a room that runs the agent spends the host's key.
  const store = asStore(db);
  if (caller.sharing && store.local && !caller.host) {
    throw new ApiError(403, "HOST_ONLY", "Only the person running Multiplayer AI can start a room. Ask the host to start one and send you its link.");
  }
  const creator = normalizeName(creator_name);
  // A title someone typed is refused if it holds control characters; one made from the task is cleaned.
  const typedTitle = typeof title === "string" ? title.trim() : "";
  if (hasUnsafeChars(typedTitle)) {
    throw new ApiError(400, "INVALID_TITLE", "A title can't contain control characters, line breaks or text-direction marks.");
  }
  const taskText = typeof task === "string" ? task.trim() : "";
  if (!taskText) throw new ApiError(400, "BAD_REQUEST", "Describe the task for the agent.");
  assertMaxLength(taskText, maxMessageChars(), "The task");
  // A title is a label: cut it to the limit (on a whole character) rather than refuse the room.
  const sessionTitle = truncateChars(typedTitle || plainLabel(taskText.slice(0, 60)) || "Untitled room", maxTitleChars());

  // A copy that runs on one person's computer has no use for a room whose agent can't answer.
  // (Supabase mode is unchanged: it never asked.)
  if (auto_start === true && store.local && !keyCheck()) {
    throw new ApiError(409, "NO_KEY", "No model key is set up on this computer yet. Open Setup to add one, then start the room again.");
  }

  // Checked after the request is known to be well formed, and before anything is written.
  limits.checkCreate(ip);
  // A room that starts the agent spends a step; one started over MCP without auto_start does not.
  if (auto_start === true) await budget.claim(db);

  // The agent may use the room's files from the start only when nobody else can reach this copy: sharing is off and it is not
  // in a container (which always counts as shared). The host can change it per room in Host controls.
  const session = await store.createSession({ title: sessionTitle, task: taskText, files_enabled: store.supportsFiles === true && !caller.sharing });

  // Add creator as controller, with their access token. The token is returned
  // once, here; only its hash is stored.
  const { token, columns } = newCredential();
  await store.insertParticipant({ session_id: session.id, name: creator, role: "controller", ...columns, ...(store.local ? { is_host: Boolean(caller.host) } : {}) });

  // Write join event
  await bestEffort(
    store.insertEvent({ session_id: session.id, kind: "join", author: creator, content: `${creator} created the session.` }),
    "join"
  );

  // Write the task as the first directive so step_agent has something to act on
  const directive = await store.insertEvent({ session_id: session.id, kind: "directive", author: creator, content: taskText });

  // Same path as a controller's directive: queued, answered in order, one reply.
  if (auto_start === true) trigger(session.id, directive.id);

  const publicUrl = publicBaseUrl(process.env, { local: store.local });
  return {
    session_id: session.id,
    token,
    you: { name: creator, role: "controller" },
    join_url: `${publicUrl}/s/${session.id}/join`,
    session_url: `${publicUrl}/s/${session.id}`,
    title: sessionTitle,
    auto_start: auto_start === true,
    next_step: auto_start === true
      ? "The agent is answering the task now; the reply will appear in the room."
      : "Call step_agent with this session_id and your token to get the first agent response."
  };
}
