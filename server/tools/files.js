// What people in a room can do with its files, through the same token as everything else:
//   list_room_files, get_room_file, file_versions   anyone in the room, including a guest and a watcher (read only)
//   attach_file                                     the controller, or a person who joined as the host (guests cannot:
//                                                   what is attached reaches the agent)
// Deleting, restoring and the agent's on/off switch are the host's and live in host-actions.js, behind the host gate.
// File content only ever leaves here inside a JSON answer; nothing serves a file as a page, and no token goes in an address.
import { asStore, defaultStore } from "../store/index.js";
import { ApiError } from "../errors.js";
import { authenticate } from "../auth.js";
import { authenticateWriter } from "../rooms.js";
import { nudge } from "../hub.js";
import { bestEffort } from "../store/best-effort.js";
import { StoreError } from "../store/errors.js";
import { checkFileName, checkFileContent } from "../files/names.js";
import { fileLimits } from "../files/limits.js";
import { formatBytes } from "../agent/tools.js";

export const FILES_UNAVAILABLE = "Files need the local data file. They aren't available with Supabase storage.";

export function needFiles(store) {
  if (!store.supportsFiles) throw new ApiError(409, "FILES_UNAVAILABLE", FILES_UNAVAILABLE);
}

/** A checked name, or a 400 that doesn't repeat what was typed. */
export function requireFileName(name) {
  const checked = checkFileName(name);
  if (!checked.ok) throw new ApiError(400, "BAD_FILE_NAME", checked.message);
  return checked.name;
}

/** The same store rules, said as the API says things. */
export function fileApiError(e) {
  if (!(e instanceof StoreError)) return e;
  const limits = fileLimits();
  if (e.code === "FILE_TOO_LARGE") return new ApiError(400, "FILE_TOO_LARGE", `That file is too large. One file can hold at most ${formatBytes(limits.maxFileBytes)}.`);
  if (e.code === "TOO_MANY_FILES") return new ApiError(409, "TOO_MANY_FILES", `This room already holds ${limits.maxFiles} files, the most it can. Replace one instead.`);
  if (e.code === "ROOM_FULL") return new ApiError(409, "ROOM_FULL", `This room's file space (${formatBytes(limits.maxTotalBytes)}) is full.`);
  if (e.code === "UNSUPPORTED") return new ApiError(409, "FILES_UNAVAILABLE", FILES_UNAVAILABLE);
  return e;
}

const status = (store, sessionId, content) =>
  bestEffort(store.insertEvent({ session_id: sessionId, kind: "status", author: "system", content }), "status");

function versionOf(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Number.isInteger(raw) || raw < 1) throw new ApiError(400, "BAD_REQUEST", "A version is a whole number from 1.");
  return raw;
}

export async function listRoomFiles({ session_id, token }, { db = defaultStore() } = {}) {
  await authenticate(db, { session_id, token });
  const store = asStore(db);
  needFiles(store);
  const [files, usage] = await Promise.all([store.listFiles(session_id), store.fileUsage(session_id)]);
  const { maxFileBytes, maxFiles, maxTotalBytes } = fileLimits();
  return { files, usage, limits: { maxFileBytes, maxFiles, maxTotalBytes } };
}

export async function getRoomFile({ session_id, token, name, version }, { db = defaultStore() } = {}) {
  await authenticate(db, { session_id, token });
  const store = asStore(db);
  needFiles(store);
  const clean = requireFileName(name);
  const wanted = versionOf(version);
  const file = wanted ? await store.getFileVersion(session_id, clean, wanted) : await store.getFile(session_id, clean);
  if (!file) throw new ApiError(404, "FILE_NOT_FOUND", "There is no such file in this room.");
  return { file };
}

export async function fileVersions({ session_id, token, name }, { db = defaultStore() } = {}) {
  await authenticate(db, { session_id, token });
  const store = asStore(db);
  needFiles(store);
  const versions = await store.listFileVersions(session_id, requireFileName(name));
  if (!versions.length) throw new ApiError(404, "FILE_NOT_FOUND", "There is no such file in this room.");
  return { versions };
}

export async function attachFile({ session_id, token, name, content }, { db = defaultStore() } = {}) {
  const { me } = await authenticateWriter(db, { session_id, token });
  const store = asStore(db);
  needFiles(store);
  if (me.role !== "controller" && !me.is_host) {
    throw new ApiError(403, "NOT_ALLOWED", "Only the controller or the host can attach files, because an attached file can be read by the agent.");
  }
  const clean = requireFileName(name);
  const checked = checkFileContent(content);
  if (!checked.ok) throw new ApiError(400, "BAD_FILE_CONTENT", checked.message);

  let result;
  try {
    result = await store.putFile(session_id, { name: clean, content, author: me.name, limits: fileLimits() });
  } catch (e) {
    throw fileApiError(e);
  }
  if (!result.unchanged) {
    const { file, created } = result;
    await status(store, session_id, created ? `${me.name} attached ${file.name}, ${formatBytes(file.size)}` : `${me.name} replaced ${file.name}, version ${file.version}`);
    nudge(session_id);
  }
  return result;
}
