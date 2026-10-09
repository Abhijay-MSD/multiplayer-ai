// The stores the shared behavior tests run against. Each entry makes a fresh,
// empty store; `cleanup()` removes any temp folder and closes what was opened.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMemoryStore } from "../../store/memory.js";
import { createSqliteStore } from "../../store/sqlite.js";

const opened = [];
const folders = [];

export function tempDir(prefix = "multiplayer-ai-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  folders.push(dir);
  return dir;
}

export const makers = {
  memory: async (options) => track(createMemoryStore(options)),
  // A real file, like production: the folder is created and locked down by the store.
  sqlite: async (options = {}) => track(await createSqliteStore({ file: path.join(tempDir(), "data", "multiplayer-ai.db"), externalPollMs: 0, ...options })),
  // The in-memory SQLite database: same SQL, no file.
  "sqlite (:memory:)": async (options = {}) => track(await createSqliteStore({ file: ":memory:", ...options }))
};

function track(store) {
  opened.push(store);
  return store;
}

export async function cleanup() {
  for (const s of opened.splice(0)) await s.close();
  for (const d of folders.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

/** Rewinds a room's last activity, the way an old room looks, for the archive tests. */
export function ageRoom(store, sessionId, ms) {
  const when = new Date(Date.now() - ms).toISOString();
  if (store.kind === "memory") store._tables.sessions.get(sessionId).updated_at = when;
  else store._db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(when, sessionId);
}
