// The storage interface. Everything the server keeps (rooms, their events and
// people, access tokens, the daily step count, the rolling summary) goes through
// a store. Three implementations, one set of behavior tests:
//
//   sqlite    the default. One file on this computer (store/sqlite.js).
//   supabase  optional and frozen: a Postgres database you run (store/supabase.js).
//   memory    for tests (store/memory.js).
//
// A store is created with createStoreFromEnv() and handed to the code that uses
// it. Every method is async and returns plain objects. A broken rule throws a
// StoreError (see errors.js); a database that cannot be reached throws an Error.
//
//   kind, local, notifies          'sqlite' | 'supabase' | 'memory'; local = runs without an account;
//                                  notifies = tells subscribers about its own writes
//   subscribe(fn) -> unsubscribe   fn({ sessionId }); sessionId is null when another process wrote
//
//   createSession({ title, task, files_enabled }) -> session
//   getSession(id) -> session | null
//   updateSession(id, patch)       patch: status, step_count, agent_working, summary, summarized_through_event_id, files_enabled, model_calls, title, archived_at, brief (local stores)
//   clearAgentWorking()            lowers agent_working everywhere (after a crash)
//   deleteSession(id)              also removes its events and people
//   listSessions({ limit, offset }) -> sessions, oldest first
//   deleteAllSessions() -> count   every room, with its events and people
//   compact()                      make deleted content unrecoverable from the storage (SQLite: rewrite the file)
//   removeBackups() -> count       delete copies kept from before a migration (SQLite only)
//
//   insertEvent({ session_id, kind, author, content, reply_to }) -> event
//   getEvent(id) -> event | null
//   listEvents(sessionId, { kinds, afterId, uptoId, order, limit, columns }) -> events
//
//   listParticipants(sessionId, { columns }) -> people   (public columns unless more are asked for)
//   insertParticipant(row)         throws CONFLICT when the name or token hash is taken
//   updateParticipant(sessionId, name, patch)
//   deleteParticipant(sessionId, name)   frees the name and the token
//   setController(sessionId, name) one controller, everyone else a watcher
//
//   touchByToken({ sessionId, tokenHash, lastSeen, now }) -> name | null   (null: no live token)
//   findByTokenHash(hash) -> person (auth columns) | null
//   revokeToken(sessionId, name)
//
//   supportsFiles                  true for the local stores; false with Supabase, whose file methods refuse
//   putFile(sessionId, { name, content, author, onBehalfOf, limits }) -> { file, created, unchanged }
//                                  limits: { maxFileBytes, maxFiles, maxTotalBytes, versionsKept }. Checks the name
//                                  and the text itself, keeps the newest `versionsKept` versions, and drops the oldest
//                                  history (never a file's newest version) to fit the room's total, or refuses
//   getFile(sessionId, name) -> file with content | null     names match ignoring letter case
//   listFiles(sessionId) -> files (no content), by name
//   listFileVersions(sessionId, name) -> versions, newest first;  getFileVersion(sessionId, name, version) -> file | null
//   deleteFile(sessionId, name) -> boolean (removes its history too);  fileUsage(sessionId) -> { files, bytes }
//
//   claimStep(cap) -> { allowed, used }    takes one step from today's (UTC) count unless it is at cap
//   budgetStatus() -> 'ok' | 'missing' | 'unknown'
//   close()
//
// The summary is two columns of the session (summary, summarized_through_event_id),
// read with getSession and written with updateSession.
import { createMemoryStore } from "./memory.js";
import { createSqliteStoreFromEnv } from "./sqlite.js";
import { createSupabaseStore, createSupabaseStoreFromEnv } from "./supabase.js";

export { StoreError } from "./errors.js";
export { participantPublicFor, participantRoomFor } from "./columns.js";
export { nameKey } from "./names.js";
export { createMemoryStore, createSqliteStoreFromEnv, createSupabaseStore };
export { createSqliteStore } from "./sqlite.js";

export const STORE_KINDS = ["sqlite", "supabase", "memory"];

/** Which store the environment asks for: MULTIPLAYER_AI_STORE, default "sqlite". */
export function storeKind(env = process.env) {
  const kind = (env.MULTIPLAYER_AI_STORE || "sqlite").trim().toLowerCase();
  if (!STORE_KINDS.includes(kind)) {
    throw new Error(`MULTIPLAYER_AI_STORE must be one of ${STORE_KINDS.join(", ")} (it is "${env.MULTIPLAYER_AI_STORE}").`);
  }
  return kind;
}

export async function createStoreFromEnv(env = process.env, options = {}) {
  const kind = storeKind(env);
  if (kind === "memory") return createMemoryStore(options);
  if (kind === "supabase") return createSupabaseStoreFromEnv(env);
  return createSqliteStoreFromEnv(env, options);
}

/**
 * Lets code written for the Supabase client keep working: given a supabase-js
 * client (or the test stand-in) it returns a Supabase store around it; given a
 * store it returns it unchanged.
 */
const wrapped = new WeakMap();
export function asStore(db) {
  if (!db) throw new Error("No storage was provided.");
  if (typeof db.getSession === "function" && typeof db.claimStep === "function") return db;
  let store = wrapped.get(db);
  if (!store) wrapped.set(db, (store = createSupabaseStore(db)));
  return store;
}

// The store the server entry points open at startup and the tools use when a
// caller does not pass one.
let current = null;
export function setDefaultStore(store) {
  current = store;
}
export function defaultStore() {
  if (!current) throw new Error("Storage has not been opened yet.");
  return current;
}
export const hasDefaultStore = () => current !== null;
