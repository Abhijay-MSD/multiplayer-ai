// The columns each table has, and the named subsets of participant columns the
// code asks for. A store hands back only the columns asked for, so a caller
// that wants the public view cannot receive a token hash by accident.
import { StoreError } from "./errors.js";

export const SESSION_COLUMNS = [
  "id", "title", "task", "status", "step_count", "agent_working", "summary",
  "summarized_through_event_id", "created_at", "updated_at"
];
// The extra columns only the local stores have (migration 002). Supabase has none of them.
export const SESSION_SHARING_COLUMNS = ["invite_version", "guest_step_cap", "control_policy"];
export const EVENT_COLUMNS = ["id", "session_id", "kind", "author", "content", "reply_to", "created_at"];

export const PARTICIPANT_PUBLIC = ["session_id", "name", "role", "last_seen"];
// The same with the host mark: asked for by name, and only of a store that has it.
export const withHostMark = (columns) => [...columns, "is_host"];
export const PARTICIPANT_AUTH = [...PARTICIPANT_PUBLIC, "token_expires_at", "token_revoked_at"];
export const PARTICIPANT_ROOM = [...PARTICIPANT_PUBLIC, "token_hash", "token_expires_at", "token_revoked_at"];
export const PARTICIPANT_ALL_COLUMNS = [...PARTICIPANT_ROOM, "is_host"];

/** The public columns of a participant for `store`: with the host mark when the store keeps one. */
export const participantPublicFor = (store) => (store.local ? withHostMark(PARTICIPANT_PUBLIC) : PARTICIPANT_PUBLIC);
/** The columns the hub reads (public plus the server-only token fields) for `store`. */
export const participantRoomFor = (store) => (store.local ? withHostMark(PARTICIPANT_ROOM) : PARTICIPANT_ROOM);

/** "a, b" or ["a", "b"] -> ["a", "b"], each checked against `allowed`; empty or missing -> `fallback`. */
export function pickColumns(columns, allowed, fallback = allowed) {
  if (columns == null || columns === "" || columns === "*") return [...fallback];
  const list = (Array.isArray(columns) ? columns : String(columns).split(",")).map((c) => String(c).trim()).filter(Boolean);
  if (!list.length) return [...fallback];
  for (const c of list) {
    if (!allowed.includes(c)) throw new StoreError("CONSTRAINT", `Unknown column "${c}".`);
  }
  return list;
}

export const project = (row, columns) =>
  row && Object.fromEntries(columns.filter((c) => c in row).map((c) => [c, row[c]]));
