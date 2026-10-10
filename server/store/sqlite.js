// The SQLite store (the default): the whole interface in store/index.js over one
// file, using Node's built-in node:sqlite. No server, no account.
//
// Every connection sets, before anything else:
//   busy_timeout   wait this long for another connection's write instead of failing at once
//   journal_mode=WAL   readers and a writer don't block each other; a second process can use the file
//   foreign_keys=ON    SQLite leaves this off by default; the cascade and set-null rules need it
import { StoreError } from "./errors.js";
import { createEmitter } from "./emitter.js";
import { nameKey } from "./names.js";
import {
  EVENT_COLUMNS, PARTICIPANT_ALL_COLUMNS, PARTICIPANT_PUBLIC, pickColumns
} from "./columns.js";
import { dataDir, DATA_FILE_NAME, prepareDataDir, secureFile } from "./dataDir.js";
import { migrate } from "./migrate.js";
import { checkFileName, checkFileContent } from "../files/names.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SESSION_PATCH = ["status", "step_count", "agent_working", "summary", "summarized_through_event_id", "invite_version", "guest_step_cap", "control_policy", "files_enabled", "model_calls", "title", "archived_at", "brief"];
const PARTICIPANT_PATCH = ["name", "role", "last_seen", "token_hash", "token_expires_at", "token_revoked_at", "is_host"];
const DEFAULT_BUSY_MS = 5000;
const EXTERNAL_POLL_MS = 1000;

// SQLite result codes (the low byte) and the extended codes for unique keys.
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CONSTRAINT = 19;
const EXTENDED_UNIQUE = [1555, 2067]; // primary key, unique index

function translate(e) {
  if (e instanceof StoreError) return e;
  const primary = typeof e?.errcode === "number" ? e.errcode & 0xff : null;
  if (primary === SQLITE_CONSTRAINT) {
    return new StoreError(EXTENDED_UNIQUE.includes(e.errcode) ? "CONFLICT" : "CONSTRAINT", e.message);
  }
  if (primary === SQLITE_BUSY || primary === SQLITE_LOCKED) {
    return new StoreError("BUSY", "The data file is in use by another program. Try again in a moment.");
  }
  return e;
}

/**
 * Opens (and if needed creates and migrates) the data file.
 * Options: `file` (a path, or ":memory:"), `busyTimeoutMs`, `migrations` (tests), `now`,
 * `externalPollMs` (0 turns off watching for another process's writes).
 */
export async function createSqliteStore({
  file,
  busyTimeoutMs = DEFAULT_BUSY_MS,
  migrations,
  now = () => new Date(),
  externalPollMs = EXTERNAL_POLL_MS
} = {}) {
  if (!file) throw new Error("createSqliteStore needs a file.");
  const { DatabaseSync } = await import("node:sqlite");
  const inMemory = file === ":memory:";
  if (!inMemory) {
    prepareDataDir(path.dirname(file));
    secureFile(file);
  }

  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
  db.exec("PRAGMA foreign_keys = ON");
  // Deleted content is overwritten with zeros instead of left behind in free pages.
  db.exec("PRAGMA secure_delete = ON");
  // Two copies of the app can open a brand-new file in the same instant (two MCP
  // sessions starting together). Switching to WAL and creating the schema each
  // need the file to themselves, and SQLite reports "locked" at once for some of
  // that instead of waiting. So set-up is retried, briefly, until the other copy is done.
  let migration;
  try {
    const deadline = Date.now() + Math.max(busyTimeoutMs, 1000);
    for (;;) {
      try {
        if (db.prepare("PRAGMA journal_mode").get().journal_mode !== "wal") db.exec("PRAGMA journal_mode = WAL");
        migration = migrate(db, { file, ...(migrations ? { migrations } : {}) });
        break;
      } catch (e) {
        const busy = [SQLITE_BUSY, SQLITE_LOCKED].includes(typeof e?.errcode === "number" ? e.errcode & 0xff : -1);
        if (!busy || Date.now() > deadline) throw translate(e);
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 40));
      }
    }
  } catch (e) {
    db.close();
    throw e;
  }
  if (!inMemory) secureFile(file); // the file now exists with its schema; the -wal and -shm files inherit its mode

  const bus = createEmitter();
  const prepared = new Map();
  const sql = (text) => {
    let s = prepared.get(text);
    if (!s) prepared.set(text, (s = db.prepare(text)));
    return s;
  };
  const plain = (r) => (r ? { ...r } : null);
  const person = (r) => (r ? (("is_host" in r) ? { ...r, is_host: r.is_host === 1 } : { ...r }) : null);
  const sessionRow = (r) => (r ? { ...r, agent_working: r.agent_working === 1, files_enabled: r.files_enabled === 1 } : null);
  const run = (fn) => {
    try {
      return fn();
    } catch (e) {
      throw translate(e);
    }
  };
  const tx = (fn) =>
    run(() => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // already rolled back by SQLite
        }
        throw e;
      }
    });
  const stamp = () => now().toISOString();
  // What a file looks like outside the store: the name, the newest version's number and size, who wrote it and when.
  const fileMeta = (r) => ({ name: r.name, version: r.version, size: r.size, updated_by: r.author, on_behalf_of: r.on_behalf_of ?? null, updated_at: r.created_at });
  const fileRow = (r) => (r ? { ...fileMeta(r), content: r.content } : null);

  // Watch for writes from another process (an MCP copy, for instance). data_version
  // changes only when a different connection commits, so this costs almost nothing.
  let watcher = null;
  let lastVersion = null;
  const dataVersion = () => db.prepare("PRAGMA data_version").get().data_version;
  const startWatching = () => {
    if (watcher || inMemory || !externalPollMs) return;
    lastVersion = dataVersion();
    watcher = setInterval(() => {
      try {
        const v = dataVersion();
        if (v !== lastVersion) {
          lastVersion = v;
          bus.emit(null);
        }
      } catch {
        // closed or busy; the next tick tries again
      }
    }, externalPollMs);
    watcher.unref?.();
  };
  const stopWatching = () => {
    clearInterval(watcher);
    watcher = null;
  };

  const store = {
    kind: "sqlite",
    local: true,
    notifies: true,
    migration,
    file,
    subscribe(fn) {
      const off = bus.subscribe(fn);
      startWatching();
      return () => {
        off();
        if (!bus.size) stopWatching();
      };
    },

    // ── sessions ───────────────────────────────────────────────────
    async createSession({ title, task, files_enabled = false }) {
      const id = randomUUID();
      const t = stamp();
      // files_enabled is named only when it is set, so a file one schema version behind (the migration tests make some) still accepts a room.
      const row = run(() =>
        files_enabled
          ? sql("INSERT INTO sessions (id, title, task, status, step_count, files_enabled, created_at, updated_at) VALUES (?, ?, ?, 'active', 0, 1, ?, ?) RETURNING *").get(id, title, task, t, t)
          : sql("INSERT INTO sessions (id, title, task, status, step_count, created_at, updated_at) VALUES (?, ?, ?, 'active', 0, ?, ?) RETURNING *").get(id, title, task, t, t)
      );
      bus.emit(id);
      return sessionRow(row);
    },

    async getSession(id) {
      return sessionRow(run(() => sql("SELECT * FROM sessions WHERE id = ?").get(id)));
    },

    async updateSession(id, patch) {
      const keys = Object.keys(patch);
      for (const k of keys) if (!SESSION_PATCH.includes(k)) throw new StoreError("CONSTRAINT", `"${k}" cannot be changed.`);
      if (!keys.length) return;
      if ("title" in patch && (typeof patch.title !== "string" || patch.title.trim() === "" || [...patch.title].length > 120)) throw new StoreError("CONSTRAINT", "A title is 1 to 120 characters.");
      if ("archived_at" in patch && patch.archived_at !== null && typeof patch.archived_at !== "string") throw new StoreError("CONSTRAINT", "archived_at is a time or null.");
      if ("brief" in patch && (typeof patch.brief !== "string" || [...patch.brief].length > 1500)) throw new StoreError("CONSTRAINT", "A brief is text of at most 1500 characters.");
      const values = keys.map((k) => (k === "agent_working" || k === "files_enabled" ? (patch[k] ? 1 : 0) : patch[k]));
      const res = run(() => sql(`UPDATE sessions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...values, id));
      if (res.changes) bus.emit(id);
    },

    async clearAgentWorking() {
      const rows = run(() => sql("UPDATE sessions SET agent_working = 0 WHERE agent_working = 1 RETURNING id").all());
      for (const r of rows) bus.emit(r.id);
    },

    async listSessions({ limit = 1000, offset = 0 } = {}) {
      return run(() => sql("SELECT * FROM sessions ORDER BY created_at, id LIMIT ? OFFSET ?").all(limit, offset)).map(sessionRow);
    },

    async deleteAllSessions() {
      const res = run(() => sql("DELETE FROM sessions").run()); // their events and people go with them
      if (res.changes) bus.emit(null);
      return Number(res.changes);
    },

    /** Rewrites the file without the deleted content and empties the write-ahead log. */
    async compact() {
      if (inMemory) return;
      run(() => {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.exec("VACUUM");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      });
    },

    /** Deletes the copies made before a migration. Returns how many. */
    async removeBackups() {
      if (inMemory) return 0;
      const dir = path.dirname(file);
      const prefix = `${path.basename(file)}.bak-v`;
      const names = fs.readdirSync(dir).filter((f) => f.startsWith(prefix));
      for (const f of names) fs.rmSync(path.join(dir, f), { force: true });
      return names.length;
    },

    async deleteSession(id) {
      const res = run(() => sql("DELETE FROM sessions WHERE id = ?").run(id));
      if (res.changes) bus.emit(id);
    },

    // ── events ─────────────────────────────────────────────────────
    async insertEvent({ session_id, kind, author, content, reply_to = null }) {
      const row = run(() =>
        sql("INSERT INTO session_events (session_id, kind, author, content, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
          .get(session_id, kind, author, content, reply_to, stamp())
      );
      bus.emit(session_id);
      return plain(row);
    },

    async getEvent(id) {
      return plain(run(() => sql("SELECT * FROM session_events WHERE id = ?").get(id)));
    },

    async listEvents(sessionId, { kinds, afterId, uptoId, order = "asc", limit, columns } = {}) {
      const cols = pickColumns(columns, EVENT_COLUMNS);
      const where = ["session_id = ?"];
      const args = [sessionId];
      if (kinds) {
        where.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
        args.push(...kinds);
      }
      if (afterId != null) (where.push("id > ?"), args.push(afterId));
      if (uptoId != null) (where.push("id <= ?"), args.push(uptoId));
      let text = `SELECT ${cols.join(", ")} FROM session_events WHERE ${where.join(" AND ")} ORDER BY id ${order === "desc" ? "DESC" : "ASC"}`;
      if (limit != null) (text += " LIMIT ?", args.push(limit));
      return run(() => sql(text).all(...args)).map(plain);
    },

    // ── participants ───────────────────────────────────────────────
    async listParticipants(sessionId, { columns } = {}) {
      const cols = pickColumns(columns, PARTICIPANT_ALL_COLUMNS, PARTICIPANT_PUBLIC);
      return run(() => sql(`SELECT ${cols.join(", ")} FROM session_participants WHERE session_id = ?`).all(sessionId)).map(person);
    },

    async insertParticipant(row) {
      const { session_id, name, role = "watcher" } = row;
      run(() =>
        sql(
          "INSERT INTO session_participants (session_id, name, name_key, role, last_seen, token_hash, token_expires_at, token_revoked_at, is_host) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(session_id, name, nameKey(name), role, row.last_seen ?? stamp(), row.token_hash ?? null, row.token_expires_at ?? null, row.token_revoked_at ?? null, row.is_host ? 1 : 0)
      );
      bus.emit(session_id);
    },

    async updateParticipant(sessionId, name, patch) {
      const keys = Object.keys(patch);
      for (const k of keys) if (!PARTICIPANT_PATCH.includes(k)) throw new StoreError("CONSTRAINT", `"${k}" cannot be changed.`);
      if (!keys.length) return;
      const sets = keys.map((k) => `${k} = ?`);
      const values = keys.map((k) => (k === "is_host" ? (patch[k] ? 1 : 0) : patch[k]));
      if (keys.includes("name")) (sets.push("name_key = ?"), values.push(nameKey(patch.name)));
      const res = run(() =>
        sql(`UPDATE session_participants SET ${sets.join(", ")} WHERE session_id = ? AND name = ?`).run(...values, sessionId, name)
      );
      if (res.changes) bus.emit(sessionId);
    },

    async deleteParticipant(sessionId, name) {
      const res = run(() => sql("DELETE FROM session_participants WHERE session_id = ? AND name = ?").run(sessionId, name));
      if (res.changes) bus.emit(sessionId);
    },

    async setController(sessionId, name) {
      tx(() => {
        sql("UPDATE session_participants SET role = 'watcher' WHERE session_id = ?").run(sessionId);
        const res = sql("UPDATE session_participants SET role = 'controller' WHERE session_id = ? AND name = ?").run(sessionId, name);
        if (!res.changes) throw new StoreError("NOT_FOUND", `"${name}" is not in this room.`);
      });
      bus.emit(sessionId);
    },

    async touchByToken({ sessionId, tokenHash, lastSeen, now: at }) {
      const row = run(() =>
        sql(
          "UPDATE session_participants SET last_seen = ? WHERE token_hash = ? AND session_id = ? AND token_revoked_at IS NULL AND token_expires_at > ? RETURNING name"
        ).get(lastSeen, tokenHash, sessionId, at)
      );
      if (!row) return null;
      bus.emit(sessionId);
      return row.name;
    },

    async findByTokenHash(hash) {
      return person(
        run(() =>
          sql("SELECT session_id, name, role, last_seen, token_expires_at, token_revoked_at, is_host FROM session_participants WHERE token_hash = ?").get(hash)
        )
      );
    },

    async revokeToken(sessionId, name) {
      const res = run(() =>
        sql("UPDATE session_participants SET token_revoked_at = ? WHERE session_id = ? AND name = ?").run(stamp(), sessionId, name)
      );
      if (res.changes) bus.emit(sessionId);
    },

    // ── files ──────────────────────────────────────────────────────
    supportsFiles: true,

    // `append: true` adds `content` to the end of the file's newest version (or makes the file), inside the one transaction, so two
    // appends at once are both kept. Every rule below applies to the whole file that results, not to the piece.
    async putFile(sessionId, { name, content, author, onBehalfOf = null, append = false, limits }) {
      const n = checkFileName(name);
      if (!n.ok) throw new StoreError("CONSTRAINT", n.message);
      const c = checkFileContent(content);
      if (!c.ok) throw new StoreError("CONSTRAINT", c.message);
      const piece = content;
      if (!append && Buffer.byteLength(content, "utf8") > limits.maxFileBytes) throw new StoreError("FILE_TOO_LARGE", `That file is ${Buffer.byteLength(content, "utf8")} bytes; the limit is ${limits.maxFileBytes}.`);
      const result = tx(() => {
        if (!sql("SELECT 1 FROM sessions WHERE id = ?").get(sessionId)) throw new StoreError("CONSTRAINT", "That room does not exist.");
        const latest = sql("SELECT name, version, content, size, author, on_behalf_of, created_at FROM room_files WHERE session_id = ? AND name_key = ? ORDER BY version DESC LIMIT 1").get(sessionId, n.key);
        if (append) content = (latest?.content ?? "") + piece;
        const size = Buffer.byteLength(content, "utf8");
        if (append && size > limits.maxFileBytes) throw new StoreError("FILE_TOO_LARGE", `That file would be ${size} bytes; the limit is ${limits.maxFileBytes}.`);
        if (latest && latest.content === content) {
          return { file: fileMeta(latest), created: false, unchanged: true };
        }
        if (!latest) {
          const count = sql("SELECT count(DISTINCT name_key) AS n FROM room_files WHERE session_id = ?").get(sessionId).n;
          if (count >= limits.maxFiles) throw new StoreError("TOO_MANY_FILES", `A room can hold ${limits.maxFiles} files.`);
        }
        const version = (latest?.version ?? 0) + 1;
        const stored = latest?.name ?? n.name;
        const t = stamp();
        sql("INSERT INTO room_files (session_id, name_key, version, name, content, size, author, on_behalf_of, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(sessionId, n.key, version, stored, content, size, author, onBehalfOf, t);
        // History: at most `versionsKept` of this file.
        sql("DELETE FROM room_files WHERE session_id = ? AND name_key = ? AND version <= ?").run(sessionId, n.key, version - limits.versionsKept);
        // The room's total: drop the oldest history (never a file's newest version) until it fits, or refuse.
        let total = sql("SELECT coalesce(sum(size), 0) AS b FROM room_files WHERE session_id = ?").get(sessionId).b;
        while (total > limits.maxTotalBytes) {
          const victim = sql(
            "SELECT seq, size FROM room_files f WHERE session_id = ? AND version < (SELECT max(version) FROM room_files WHERE session_id = f.session_id AND name_key = f.name_key) ORDER BY seq LIMIT 1"
          ).get(sessionId);
          if (!victim) throw new StoreError("ROOM_FULL", `A room can hold ${limits.maxTotalBytes} bytes of files.`);
          sql("DELETE FROM room_files WHERE seq = ?").run(victim.seq);
          total -= victim.size;
        }
        return { file: fileMeta({ name: stored, version, size, author, on_behalf_of: onBehalfOf, created_at: t }), created: !latest, unchanged: false };
      });
      if (!result.unchanged) bus.emit(sessionId);
      return result;
    },

    async getFile(sessionId, name) {
      const n = checkFileName(name);
      if (!n.ok) return null;
      return fileRow(sql("SELECT name, version, size, author, on_behalf_of, created_at, content FROM room_files WHERE session_id = ? AND name_key = ? ORDER BY version DESC LIMIT 1").get(sessionId, n.key));
    },

    async listFiles(sessionId) {
      return run(() =>
        sql(
          "SELECT name, version, size, author, on_behalf_of, created_at FROM room_files f WHERE session_id = ? AND version = (SELECT max(version) FROM room_files WHERE session_id = f.session_id AND name_key = f.name_key) ORDER BY name_key"
        ).all(sessionId)
      ).map(fileMeta);
    },

    async listFileVersions(sessionId, name) {
      const n = checkFileName(name);
      if (!n.ok) return [];
      return run(() => sql("SELECT version, size, author, on_behalf_of, created_at FROM room_files WHERE session_id = ? AND name_key = ? ORDER BY version DESC").all(sessionId, n.key)).map((r) => ({ ...r }));
    },

    async getFileVersion(sessionId, name, version) {
      const n = checkFileName(name);
      if (!n.ok) return null;
      return fileRow(sql("SELECT name, version, size, author, on_behalf_of, created_at, content FROM room_files WHERE session_id = ? AND name_key = ? AND version = ?").get(sessionId, n.key, version));
    },

    async deleteFile(sessionId, name) {
      const n = checkFileName(name);
      if (!n.ok) return false;
      const res = run(() => sql("DELETE FROM room_files WHERE session_id = ? AND name_key = ?").run(sessionId, n.key));
      if (res.changes) bus.emit(sessionId);
      return res.changes > 0;
    },

    async fileUsage(sessionId) {
      const r = run(() => sql("SELECT count(DISTINCT name_key) AS files, coalesce(sum(size), 0) AS bytes FROM room_files WHERE session_id = ?").get(sessionId));
      return { files: r.files, bytes: r.bytes };
    },

    // ── usage ──────────────────────────────────────────────────────
    async claimStep(cap) {
      const day = stamp().slice(0, 10);
      return tx(() => {
        sql("INSERT OR IGNORE INTO usage_daily (day, steps) VALUES (?, 0)").run(day);
        const took = sql("UPDATE usage_daily SET steps = steps + 1 WHERE day = ? AND steps < ? RETURNING steps").get(day, cap);
        if (took) return { allowed: true, used: took.steps };
        return { allowed: false, used: sql("SELECT steps FROM usage_daily WHERE day = ?").get(day).steps };
      });
    },

    async budgetStatus() {
      try {
        sql("SELECT day FROM usage_daily LIMIT 1").get();
        return "ok";
      } catch {
        return "unknown";
      }
    },

    async close() {
      stopWatching();
      prepared.clear();
      try {
        db.close();
      } catch {
        // already closed
      }
    },

    // For tests only: the open connection.
    _db: db
  };
  return store;
}

/** Opens the data file in `env`'s data folder (MULTIPLAYER_AI_DATA_DIR or ~/.multiplayer-ai). */
export function createSqliteStoreFromEnv(env = process.env, options = {}) {
  const dir = dataDir(env);
  return createSqliteStore({ file: path.join(dir, DATA_FILE_NAME), ...options });
}
