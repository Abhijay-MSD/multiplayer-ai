// The rules the database enforces, written once so the memory store can enforce
// the same ones the SQLite schema and the Postgres migrations do. Keep these in
// step with store/migrations/001_initial.sql and supabase/migrations.
import { StoreError } from "./errors.js";

export const STATUSES = ["active", "paused", "done"];
export const EVENT_KINDS = ["agent_message", "directive", "join", "takeover", "status", "comment"];
export const ROLES = ["controller", "watcher"];
export const RESERVED_NAMES = ["agent", "system"];
export const MAX_TASK = 4000;
export const MAX_TITLE = 120;
export const MAX_NAME = 40;
export const MAX_SIZED_EVENT = 4000; // directives and comments

const chars = (text) => Array.from(String(text)).length;
const trimSpaces = (text) => String(text).replace(/^ +| +$/g, "");

const fail = (message) => {
  throw new StoreError("CONSTRAINT", message);
};

export function checkSession({ title, task, status }) {
  if (typeof title !== "string" || typeof task !== "string") fail("A session needs a title and a task.");
  if (chars(task) > MAX_TASK || chars(title) > MAX_TITLE) fail("The task or title is too long.");
  if (status !== undefined && !STATUSES.includes(status)) fail(`Status must be one of ${STATUSES.join(", ")}.`);
}

export function checkEvent({ kind, author, content }) {
  if (!EVENT_KINDS.includes(kind)) fail(`Event kind must be one of ${EVENT_KINDS.join(", ")}.`);
  if (typeof author !== "string" || typeof content !== "string") fail("An event needs an author and content.");
  if ((kind === "directive" || kind === "comment") && chars(content) > MAX_SIZED_EVENT) fail("That text is too long.");
}

export function checkParticipantName(name) {
  const n = trimSpaces(name);
  if (chars(n) < 1 || chars(n) > MAX_NAME) fail(`A name is 1 to ${MAX_NAME} characters.`);
  if (RESERVED_NAMES.includes(n.toLowerCase())) fail(`"${n}" is reserved.`);
}

export function checkRole(role) {
  if (!ROLES.includes(role)) fail(`Role must be one of ${ROLES.join(", ")}.`);
}
