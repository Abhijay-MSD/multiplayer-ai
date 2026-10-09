// The memory store: the whole interface (see store/index.js) over plain arrays.
// For tests, and for anything that needs a throwaway room. It enforces the same
// rules as the SQLite schema, so a behavior test that passes here and on SQLite
// is testing the rule, not the engine.
import { randomUUID } from "node:crypto";
import { StoreError } from "./errors.js";
import { createEmitter } from "./emitter.js";
import { nameKey } from "./names.js";
import {
  EVENT_COLUMNS, PARTICIPANT_ALL_COLUMNS, PARTICIPANT_PUBLIC, pickColumns, project
} from "./columns.js";
import { checkEvent, checkParticipantName, checkRole, checkSession, STATUSES } from "./rules.js";
import { checkFileName, checkFileContent } from "../files/names.js";

const SESSION_PATCH = ["status", "step_count", "agent_working", "summary", "summarized_through_event_id", "invite_version", "guest_step_cap", "control_policy", "files_enabled", "model_calls", "title", "archived_at", "brief"];
const POLICIES = ["locked", "ask", "free"];
const PARTICIPANT_PATCH = ["name", "role", "last_seen", "token_hash", "token_expires_at", "token_revoked_at", "is_host"];
const PARTICIPANT_ALL = PARTICIPANT_ALL_COLUMNS;

export function createMemoryStore({ now = () => new Date() } = {}) {
  const sessions = new Map();
  let events = [];
  let files = []; // one row per saved version of a file: { seq, session_id, name_key, version, name, content, size, author, on_behalf_of, created_at }
  let nextFileSeq = 1;
  let participants = []; // rows carry name_key, which never leaves the store
  const usage = new Map(); // UTC day -> steps
  let nextEventId = 1;
  const bus = createEmitter();
  const stamp = () => now().toISOString();
  const fileMeta = (r) => ({ name: r.name, version: r.version, size: r.size, updated_by: r.author, on_behalf_of: r.on_behalf_of ?? null, updated_at: r.created_at });

  const copy = (row) => (row ? { ...row } : row);
  const publicParticipant = (p, columns) => {
    const { name_key, ...rest } = p;
    return project(rest, columns);
  };
  const needSession = (id) => {
    if (!sessions.has(id)) throw new StoreError("CONSTRAINT", "That room does not exist.");
  };
  const checkPatch = (patch, allowed) => {
    for (const k of Object.keys(patch)) {
      if (!allowed.includes(k)) throw new StoreError("CONSTRAINT", `"${k}" cannot be changed.`);
    }
  };

  const store = {
    kind: "memory",
    local: true,
    notifies: true,
    subscribe: bus.subscribe,

    // ── sessions ───────────────────────────────────────────────────
    async createSession({ title, task, files_enabled = false }) {
      checkSession({ title, task, status: "active" });
      const t = stamp();
      const row = {
        id: randomUUID(), title, task, status: "active", step_count: 0, agent_working: false,
        summary: null, summarized_through_event_id: null, invite_version: 1, guest_step_cap: null, control_policy: "ask",
        files_enabled: Boolean(files_enabled), model_calls: 0, archived_at: null, brief: "",
        created_at: t, updated_at: t
      };
      sessions.set(row.id, row);
      bus.emit(row.id);
      return copy(row);
    },

    async getSession(id) {
      return copy(sessions.get(id)) ?? null;
    },

    async updateSession(id, patch) {
      checkPatch(patch, SESSION_PATCH);
      const row = sessions.get(id);
      if (!row) return;
      if ("status" in patch && !STATUSES.includes(patch.status)) throw new StoreError("CONSTRAINT", "That status is not allowed.");
      if ("step_count" in patch && !(Number.isInteger(patch.step_count) && patch.step_count >= 0)) {
        throw new StoreError("CONSTRAINT", "step_count must be a whole number, 0 or more.");
      }
      if ("control_policy" in patch && !POLICIES.includes(patch.control_policy)) throw new StoreError("CONSTRAINT", "That control policy is not allowed.");
      if ("invite_version" in patch && !(Number.isInteger(patch.invite_version) && patch.invite_version >= 1)) throw new StoreError("CONSTRAINT", "invite_version must be a whole number, 1 or more.");
      if ("guest_step_cap" in patch && patch.guest_step_cap !== null && !(Number.isInteger(patch.guest_step_cap) && patch.guest_step_cap >= 0)) {
        throw new StoreError("CONSTRAINT", "guest_step_cap must be a whole number, 0 or more, or null.");
      }
      if ("title" in patch && (typeof patch.title !== "string" || patch.title.trim() === "" || [...patch.title].length > 120)) throw new StoreError("CONSTRAINT", "A title is 1 to 120 characters.");
      if ("brief" in patch && (typeof patch.brief !== "string" || [...patch.brief].length > 1500)) throw new StoreError("CONSTRAINT", "A brief is text of at most 1500 characters.");
      if ("archived_at" in patch && patch.archived_at !== null && typeof patch.archived_at !== "string") throw new StoreError("CONSTRAINT", "archived_at is a time or null.");
      if ("model_calls" in patch && !(Number.isInteger(patch.model_calls) && patch.model_calls >= 0)) throw new StoreError("CONSTRAINT", "model_calls must be a whole number, 0 or more.");
      Object.assign(row, patch);
      if ("agent_working" in patch) row.agent_working = Boolean(patch.agent_working);
      if ("files_enabled" in patch) row.files_enabled = Boolean(patch.files_enabled);
      bus.emit(id);
    },

    async clearAgentWorking() {
      for (const row of sessions.values()) {
        if (row.agent_working) {
          row.agent_working = false;
          bus.emit(row.id);
        }
      }
    },

    async listSessions({ limit = 1000, offset = 0 } = {}) {
      return [...sessions.values()].slice(offset, offset + limit).map(copy);
    },

    async deleteAllSessions() {
      const n = sessions.size;
      sessions.clear();
      events = [];
      files = [];
      participants = [];
      if (n) bus.emit(null);
      return n;
    },

    async compact() {},

    async removeBackups() {
      return 0;
    },

    async deleteSession(id) {
      if (!sessions.delete(id)) return;
      events = events.filter((e) => e.session_id !== id);
      participants = participants.filter((p) => p.session_id !== id);
      files = files.filter((f) => f.session_id !== id);
      bus.emit(id);
    },

    // ── events ─────────────────────────────────────────────────────
    async insertEvent({ session_id, kind, author, content, reply_to = null }) {
      checkEvent({ kind, author, content });
      needSession(session_id);
      if (reply_to != null && !events.some((e) => e.id === reply_to)) {
        throw new StoreError("CONSTRAINT", "reply_to points at an event that does not exist.");
      }
      const t = stamp();
      const row = { id: nextEventId++, session_id, kind, author, content, reply_to, created_at: t };
      events.push(row);
      sessions.get(session_id).updated_at = t; // what the Postgres trigger and the SQLite trigger do
      bus.emit(session_id);
      return copy(row);
    },

    async getEvent(id) {
      return copy(events.find((e) => e.id === id)) ?? null;
    },

    async listEvents(sessionId, { kinds, afterId, uptoId, order = "asc", limit, columns } = {}) {
      const cols = pickColumns(columns, EVENT_COLUMNS);
      let out = events.filter(
        (e) =>
          e.session_id === sessionId &&
          (!kinds || kinds.includes(e.kind)) &&
          (afterId == null || e.id > afterId) &&
          (uptoId == null || e.id <= uptoId)
      );
      if (order === "desc") out = [...out].reverse();
      if (limit != null) out = out.slice(0, limit);
      return out.map((e) => project(e, cols));
    },

    // ── participants ───────────────────────────────────────────────
    async listParticipants(sessionId, { columns } = {}) {
      const cols = pickColumns(columns, PARTICIPANT_ALL, PARTICIPANT_PUBLIC);
      return participants.filter((p) => p.session_id === sessionId).map((p) => publicParticipant(p, cols));
    },

    async insertParticipant(row) {
      const { session_id, name, role = "watcher" } = row;
      checkParticipantName(name);
      checkRole(role);
      needSession(session_id);
      const key = nameKey(name);
      if (participants.some((p) => p.session_id === session_id && p.name_key === key)) {
        throw new StoreError("CONFLICT", "That name is already used in this room.");
      }
      if (row.token_hash && participants.some((p) => p.token_hash === row.token_hash)) {
        throw new StoreError("CONFLICT", "That token is already in use.");
      }
      participants.push({
        session_id, name, name_key: key, role, last_seen: row.last_seen ?? stamp(), is_host: Boolean(row.is_host),
        token_hash: row.token_hash ?? null, token_expires_at: row.token_expires_at ?? null,
        token_revoked_at: row.token_revoked_at ?? null
      });
      bus.emit(session_id);
    },

    async updateParticipant(sessionId, name, patch) {
      checkPatch(patch, PARTICIPANT_PATCH);
      const row = participants.find((p) => p.session_id === sessionId && p.name === name);
      if (!row) return;
      if ("role" in patch) checkRole(patch.role);
      if ("name" in patch) {
        checkParticipantName(patch.name);
        const key = nameKey(patch.name);
        if (participants.some((p) => p !== row && p.session_id === sessionId && p.name_key === key)) {
          throw new StoreError("CONFLICT", "That name is already used in this room.");
        }
        row.name_key = key;
      }
      if (patch.token_hash && participants.some((p) => p !== row && p.token_hash === patch.token_hash)) {
        throw new StoreError("CONFLICT", "That token is already in use.");
      }
      Object.assign(row, patch);
      bus.emit(sessionId);
    },

    async deleteParticipant(sessionId, name) {
      const before = participants.length;
      participants = participants.filter((p) => !(p.session_id === sessionId && p.name === name));
      if (participants.length !== before) bus.emit(sessionId);
    },

    async setController(sessionId, name) {
      const target = participants.find((p) => p.session_id === sessionId && p.name === name);
      if (!target) throw new StoreError("NOT_FOUND", `"${name}" is not in this room.`);
      for (const p of participants) if (p.session_id === sessionId) p.role = "watcher";
      target.role = "controller";
      bus.emit(sessionId);
    },

    async touchByToken({ sessionId, tokenHash, lastSeen, now: at }) {
      const row = participants.find(
        (p) =>
          p.token_hash === tokenHash && p.session_id === sessionId && !p.token_revoked_at &&
          p.token_expires_at && Date.parse(p.token_expires_at) > Date.parse(at)
      );
      if (!row) return null;
      row.last_seen = lastSeen;
      bus.emit(sessionId);
      return row.name;
    },

    async findByTokenHash(hash) {
      const row = participants.find((p) => p.token_hash === hash);
      return row ? publicParticipant(row, ["session_id", "name", "role", "last_seen", "token_expires_at", "token_revoked_at", "is_host"]) : null;
    },

    async revokeToken(sessionId, name) {
      const row = participants.find((p) => p.session_id === sessionId && p.name === name);
      if (!row) return;
      row.token_revoked_at = stamp();
      bus.emit(sessionId);
    },

    // ── files ──────────────────────────────────────────────────────
    supportsFiles: true,

    async putFile(sessionId, { name, content, author, onBehalfOf = null, limits }) {
      const n = checkFileName(name);
      if (!n.ok) throw new StoreError("CONSTRAINT", n.message);
      const c = checkFileContent(content);
      if (!c.ok) throw new StoreError("CONSTRAINT", c.message);
      const size = Buffer.byteLength(content, "utf8");
      if (size > limits.maxFileBytes) throw new StoreError("FILE_TOO_LARGE", `That file is ${size} bytes; the limit is ${limits.maxFileBytes}.`);
      needSession(sessionId);
      const mine = files.filter((f) => f.session_id === sessionId);
      const latest = mine.filter((f) => f.name_key === n.key).sort((a, b) => b.version - a.version)[0];
      if (latest && latest.content === content) return { file: fileMeta(latest), created: false, unchanged: true };
      if (!latest && new Set(mine.map((f) => f.name_key)).size >= limits.maxFiles) throw new StoreError("TOO_MANY_FILES", `A room can hold ${limits.maxFiles} files.`);
      const version = (latest?.version ?? 0) + 1;
      const t = stamp();
      const row = { seq: nextFileSeq, session_id: sessionId, name_key: n.key, version, name: latest?.name ?? n.name, content, size, author, on_behalf_of: onBehalfOf, created_at: t };
      // Work on a copy, so a refusal leaves the room exactly as it was.
      let next = [...files, row].filter((f) => !(f.session_id === sessionId && f.name_key === n.key && f.version <= version - limits.versionsKept));
      const isLatest = (f) => !next.some((g) => g.session_id === f.session_id && g.name_key === f.name_key && g.version > f.version);
      let total = next.filter((f) => f.session_id === sessionId).reduce((sum, f) => sum + f.size, 0);
      while (total > limits.maxTotalBytes) {
        const victim = next.filter((f) => f.session_id === sessionId && !isLatest(f)).sort((a, b) => a.seq - b.seq)[0];
        if (!victim) throw new StoreError("ROOM_FULL", `A room can hold ${limits.maxTotalBytes} bytes of files.`);
        next = next.filter((f) => f !== victim);
        total -= victim.size;
      }
      nextFileSeq++;
      files = next;
      sessions.get(sessionId).updated_at = t;
      bus.emit(sessionId);
      return { file: fileMeta(row), created: !latest, unchanged: false };
    },

    async getFile(sessionId, name) {
      const n = checkFileName(name);
      if (!n.ok) return null;
      const latest = files.filter((f) => f.session_id === sessionId && f.name_key === n.key).sort((a, b) => b.version - a.version)[0];
      return latest ? { ...fileMeta(latest), content: latest.content } : null;
    },

    async listFiles(sessionId) {
      const mine = files.filter((f) => f.session_id === sessionId);
      const newest = new Map();
      for (const f of mine) if (!newest.has(f.name_key) || newest.get(f.name_key).version < f.version) newest.set(f.name_key, f);
      return [...newest.values()].sort((a, b) => (a.name_key < b.name_key ? -1 : a.name_key > b.name_key ? 1 : 0)).map(fileMeta);
    },

    async listFileVersions(sessionId, name) {
      const n = checkFileName(name);
      if (!n.ok) return [];
      return files
        .filter((f) => f.session_id === sessionId && f.name_key === n.key)
        .sort((a, b) => b.version - a.version)
        .map((f) => ({ version: f.version, size: f.size, author: f.author, on_behalf_of: f.on_behalf_of ?? null, created_at: f.created_at }));
    },

    async getFileVersion(sessionId, name, version) {
      const n = checkFileName(name);
      if (!n.ok) return null;
      const row = files.find((f) => f.session_id === sessionId && f.name_key === n.key && f.version === version);
      return row ? { ...fileMeta(row), content: row.content } : null;
    },

    async deleteFile(sessionId, name) {
      const n = checkFileName(name);
      if (!n.ok) return false;
      const before = files.length;
      files = files.filter((f) => !(f.session_id === sessionId && f.name_key === n.key));
      if (files.length === before) return false;
      bus.emit(sessionId);
      return true;
    },

    async fileUsage(sessionId) {
      const mine = files.filter((f) => f.session_id === sessionId);
      return { files: new Set(mine.map((f) => f.name_key)).size, bytes: mine.reduce((sum, f) => sum + f.size, 0) };
    },

    // ── usage ──────────────────────────────────────────────────────
    async claimStep(cap) {
      const day = stamp().slice(0, 10);
      const used = usage.get(day) ?? 0;
      if (used >= cap) return { allowed: false, used };
      usage.set(day, used + 1);
      return { allowed: true, used: used + 1 };
    },

    async budgetStatus() {
      return "ok";
    },

    async close() {},

    // For tests only: the raw arrays.
    _tables: { sessions, get events() { return events; }, get participants() { return participants; }, usage }
  };
  return store;
}
