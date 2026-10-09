// What the host can do about a shared room, apart from using it: approve or deny a request for control,
// choose the control policy, raise the cap on guest messages, make a new link, remove a person.
// The routes in host-routes.js are the only callers, and they sit behind the host gate.
import { ApiError } from "./errors.js";
import { asStore } from "./store/index.js";
import { nudge } from "./hub.js";
import { bestEffort } from "./store/best-effort.js";
import { intSetting, maxStepsPerSession } from "./config.js";
import { fileLimits, loopLimits } from "./files/limits.js";
import { fileApiError, needFiles, requireFileName } from "./tools/files.js";
import { formatBytes } from "./agent/tools.js";
import { roomState as stateOf } from "./rooms.js";
import { hasUnsafeChars, hasUnsafeCharsExceptNewline } from "./safe-text.js";
import { maxTitleChars, truncateChars } from "./limits.js";
import { stepInProgressFor } from "./tools/step_agent.js";

/** How a direct call (MCP, a script) is treated: it is on this computer, so it may start rooms, but it is never marked as the host's browser. */
export const DEFAULT_CALLER = Object.freeze({ host: true, sharing: false, direct: true });

export const POLICIES = ["locked", "ask", "free"];
export const MAX_GUEST_CAP = 100000;

const status = (store, sessionId, content) =>
  bestEffort(store.insertEvent({ session_id: sessionId, kind: "status", author: "system", content }), "status");

async function need(store, sessionId) {
  const room = await store.getSession(sessionId);
  if (!room) throw new ApiError(404, "ROOM_NOT_FOUND", "This room doesn't exist.");
  return room;
}

/** How many messages guests may send in a room: its own cap if the host set one, else GUEST_STEP_CAP_PER_ROOM (20). */
export const guestCapFor = (room, env = process.env) => room.guest_step_cap ?? intSetting("GUEST_STEP_CAP_PER_ROOM", env);

/** Messages to the agent from people other than the host. */
export async function countGuestMessages(store, sessionId) {
  const [events, people] = await Promise.all([
    store.listEvents(sessionId, { kinds: ["directive"], columns: "author" }),
    store.listParticipants(sessionId, { columns: "name, is_host" })
  ]);
  const hosts = new Set(people.filter((p) => p.is_host).map((p) => p.name));
  return events.filter((e) => !hosts.has(e.author)).length;
}

export async function rotateInvite({ store: db, sessionId }) {
  const store = asStore(db);
  const room = await need(store, sessionId);
  await store.updateSession(sessionId, { invite_version: room.invite_version + 1 });
  nudge(sessionId);
  return room.invite_version + 1;
}

export async function setPolicy({ store: db, sessionId, policy }) {
  const store = asStore(db);
  if (!POLICIES.includes(policy)) throw new ApiError(400, "BAD_REQUEST", "Choose Locked, Ask me or Allow freely.");
  await need(store, sessionId);
  await store.updateSession(sessionId, { control_policy: policy });
  nudge(sessionId);
}

export async function setGuestCap({ store: db, sessionId, cap }) {
  const store = asStore(db);
  const ok = cap === null || (Number.isInteger(cap) && cap >= 0 && cap <= MAX_GUEST_CAP);
  if (!ok) throw new ApiError(400, "BAD_REQUEST", `The limit is a whole number from 0 to ${MAX_GUEST_CAP}.`);
  await need(store, sessionId);
  await store.updateSession(sessionId, { guest_step_cap: cap });
  nudge(sessionId);
}

/** Approve or deny a waiting request. Exactly one of two simultaneous decisions takes effect. */
export async function decideControl({ store: db, control, sessionId, requestId, decision }) {
  const store = asStore(db);
  if (!["approve", "deny"].includes(decision)) throw new ApiError(400, "BAD_REQUEST", "Approve or deny.");
  const request = control.take(sessionId, requestId); // synchronous: whoever gets here first has it
  if (!request) throw new ApiError(404, "REQUEST_GONE", "That request has already been answered, or it ran out of time.");
  if (decision === "deny") {
    await status(store, sessionId, `The host said no to ${request.name}'s request for control.`);
    nudge(sessionId);
    return { decision, name: request.name };
  }
  const next = request.kind === "handoff" ? request.to : request.name;
  const people = await store.listParticipants(sessionId, { columns: "name" });
  if (!people.some((p) => p.name === next)) throw new ApiError(404, "REQUEST_GONE", `${next} is no longer in this room.`);
  await store.setController(sessionId, next);
  await bestEffort(
    store.insertEvent({ session_id: sessionId, kind: "takeover", author: next, content: `${next} took control (the host approved).` }),
    "takeover"
  );
  nudge(sessionId);
  return { decision, name: next };
}

/** Writes a line for each request that ran out of time. */
export async function sweepControl({ store: db, control }) {
  const store = asStore(db);
  for (const r of control.expire()) {
    await status(store, r.sessionId, r.kind === "handoff" ? `${r.name}'s request to hand control to ${r.to} expired.` : `${r.name}'s request for control expired.`);
    nudge(r.sessionId);
  }
}

/** Revokes a person's token, frees their name and drops their requests. The host cannot be removed. */
export async function removePerson({ store: db, control, sessionId, name }) {
  const store = asStore(db);
  await need(store, sessionId);
  const people = await store.listParticipants(sessionId, { columns: "name, is_host" });
  const person = people.find((p) => p.name === name);
  if (!person) throw new ApiError(404, "NOT_FOUND", `"${name}" is not in this room.`);
  if (person.is_host) throw new ApiError(409, "CANNOT_REMOVE_HOST", "The host can't be removed from their own room.");
  control.dropFor(sessionId, name);
  await store.deleteParticipant(sessionId, name);
  await status(store, sessionId, `${name} was removed by the host.`);
  nudge(sessionId);
}

export const CONFIRM_DELETE_ROOM = "delete room";
export const MAX_BRIEF_CHARS = 1500;

function needRooms(store) {
  if (!store.local) throw new ApiError(409, "ROOMS_UNAVAILABLE", "Your rooms need the local data file. They aren't available with Supabase storage.");
}

/** Every room, the one with the latest activity first: { id, title, created_at, last_activity, people, state, archived_by_host, step_count, agent_working }. */
export async function listRooms({ store: db }) {
  const store = asStore(db);
  needRooms(store);
  const rooms = await store.listSessions({ limit: 100000 });
  const out = await Promise.all(
    rooms.map(async (r) => ({
      id: r.id,
      title: r.title,
      created_at: r.created_at,
      last_activity: r.updated_at,
      people: (await store.listParticipants(r.id, { columns: "name" })).length,
      state: stateOf(r),
      archived_by_host: Boolean(r.archived_at),
      step_count: r.step_count,
      agent_working: Boolean(r.agent_working)
    }))
  );
  return out.sort((a, b) => (a.last_activity < b.last_activity ? 1 : a.last_activity > b.last_activity ? -1 : a.id < b.id ? 1 : -1));
}

/** Rename a room. The same rules as a title typed when starting one: no control characters; too long is cut on a whole character. */
export async function renameRoom({ store: db, sessionId, title }) {
  const store = asStore(db);
  needRooms(store);
  if (typeof title !== "string") throw new ApiError(400, "BAD_REQUEST", "A title can't be empty.");
  if (hasUnsafeChars(title)) throw new ApiError(400, "INVALID_TITLE", "A title can't contain control characters, line breaks or text-direction marks.");
  const clean = title.trim();
  if (!clean) throw new ApiError(400, "BAD_REQUEST", "A title can't be empty.");
  await need(store, sessionId);
  await store.updateSession(sessionId, { title: truncateChars(clean, maxTitleChars()) });
  nudge(sessionId);
}

/** Archive a room (read-only for everyone) or unarchive it, which also reopens one that was archived by silence. */
export async function setArchived({ store: db, sessionId, archived }) {
  const store = asStore(db);
  needRooms(store);
  if (typeof archived !== "boolean") throw new ApiError(400, "BAD_REQUEST", "Choose archive or unarchive.");
  const room = await need(store, sessionId);
  if (archived) {
    if (room.archived_at) return;
    await store.updateSession(sessionId, { archived_at: new Date().toISOString() });
    await status(store, sessionId, "The host archived this room.");
  } else {
    if (!room.archived_at && stateOf(room) !== "archived") return;
    await store.updateSession(sessionId, { archived_at: null });
    await status(store, sessionId, "The host unarchived this room."); // a new event is activity, which also reopens a room archived by silence
  }
  nudge(sessionId);
}

/** Delete one room, with its events, people and files, behind the typed words. Not while its agent is working. */
export async function deleteRoom({ store: db, sessionId, confirm }) {
  const store = asStore(db);
  needRooms(store);
  if (confirm !== CONFIRM_DELETE_ROOM) throw new ApiError(400, "CONFIRM_MISMATCH", `Type "${CONFIRM_DELETE_ROOM}" to confirm.`);
  const room = await need(store, sessionId);
  if (room.agent_working || stepInProgressFor(sessionId)) throw new ApiError(409, "AGENT_WORKING", "The agent is replying in this room right now. Wait for it to finish, or stop it, then try again.");
  await store.deleteSession(sessionId);
  await store.compact();
  return { deleted: true };
}

/**
 * Set (or clear, with an empty text) the room brief. It is read by everyone in the room and given to the agent as the host's
 * instructions. Line breaks are fine; control characters, text-direction marks and zero-width characters are refused.
 */
export async function setBrief({ store: db, sessionId, brief }) {
  const store = asStore(db);
  needRooms(store);
  if (typeof brief !== "string") throw new ApiError(400, "BAD_REQUEST", "A brief is text.");
  if (hasUnsafeCharsExceptNewline(brief)) throw new ApiError(400, "INVALID_BRIEF", "A brief can't contain control characters, text-direction marks or zero-width characters. Line breaks are fine.");
  const clean = brief.trim();
  if ([...clean].length > MAX_BRIEF_CHARS) throw new ApiError(400, "BRIEF_TOO_LONG", `A brief can be up to ${MAX_BRIEF_CHARS} characters.`);
  const room = await need(store, sessionId);
  const before = room.brief ?? "";
  if (before === clean) return;
  await store.updateSession(sessionId, { brief: clean });
  await status(store, sessionId, clean === "" ? "The host cleared the room brief." : before === "" ? "The host set the room brief." : "The host changed the room brief.");
  nudge(sessionId);
}

/** Switch the agent's use of the room's files on or off. */
export async function setFilesEnabled({ store: db, sessionId, enabled }) {
  const store = asStore(db);
  if (typeof enabled !== "boolean") throw new ApiError(400, "BAD_REQUEST", "Choose on or off.");
  await need(store, sessionId);
  needFiles(store);
  await store.updateSession(sessionId, { files_enabled: enabled });
  await status(store, sessionId, `The host turned ${enabled ? "on" : "off"} the agent's use of files in this room.`);
  nudge(sessionId);
}

/** Delete a file and its whole history. Only the host can. */
export async function deleteFile({ store: db, sessionId, name }) {
  const store = asStore(db);
  await need(store, sessionId);
  needFiles(store);
  const clean = requireFileName(name);
  const existing = await store.getFile(sessionId, clean);
  if (!existing || !(await store.deleteFile(sessionId, clean))) throw new ApiError(404, "FILE_NOT_FOUND", "There is no such file in this room.");
  await status(store, sessionId, `The host deleted ${existing.name}.`);
  nudge(sessionId);
}

/** Make an older version the newest one, as a new version. Only the host can. */
export async function restoreFile({ store: db, sessionId, name, version }) {
  const store = asStore(db);
  await need(store, sessionId);
  needFiles(store);
  const clean = requireFileName(name);
  if (!Number.isInteger(version) || version < 1) throw new ApiError(400, "BAD_REQUEST", "Choose a version to restore.");
  const old = await store.getFileVersion(sessionId, clean, version);
  if (!old) throw new ApiError(404, "FILE_NOT_FOUND", "There is no such version of that file.");
  let result;
  try {
    result = await store.putFile(sessionId, { name: old.name, content: old.content, author: "host", limits: fileLimits() });
  } catch (e) {
    throw fileApiError(e);
  }
  if (!result.unchanged) {
    await status(store, sessionId, `The host restored ${old.name} to version ${version} (now version ${result.file.version}).`);
    nudge(sessionId);
  }
  return result;
}

/** Everything the host's panel shows about one room, except the link. */
export async function roomState({ store: db, control, sessionId, env = process.env }) {
  const store = asStore(db);
  const room = await need(store, sessionId);
  const [guestMessages, people] = await Promise.all([countGuestMessages(store, sessionId), store.listParticipants(sessionId, { columns: "name, role, is_host, last_seen" })]);
  const files = store.supportsFiles ? await store.fileUsage(sessionId) : null;
  const { maxFileBytes, maxFiles, maxTotalBytes } = fileLimits(env);
  return {
    ...(store.local ? { brief: room.brief ?? "" } : {}),
    files: { available: Boolean(store.supportsFiles), enabled: Boolean(room.files_enabled), count: files?.files ?? 0, bytes: files?.bytes ?? 0, limits: { maxFileBytes, maxFiles, maxTotalBytes } },
    policy: room.control_policy,
    counters: { guest_messages: guestMessages, guest_cap: guestCapFor(room, env), room_steps: room.step_count, room_cap: maxStepsPerSession(env), ...(store.supportsFiles ? { model_calls: room.model_calls ?? 0, model_call_cap: loopLimits(env).roomModelCalls } : {}) },
    pending: control.list(sessionId).map((r) => ({ id: r.id, kind: r.kind, name: r.name, to: r.to, expires_at: new Date(r.expiresAt).toISOString() })),
    people: people.map((p) => ({ name: p.name, role: p.role, is_host: p.is_host, last_seen: p.last_seen }))
  };
}
