// The Supabase store: today's behavior, the same queries the tools made before
// the storage layer existed, moved into one file. Optional and frozen. It is
// the hosted path; the default is SQLite.
//
// UNVERIFIED against a real project: it is tested only against the in-memory
// stand-in in test/fakeSupabase.js. See docs/supabase.md for how to check it.
// The client library is installed separately, in server/supabase-lib.
//
// `client` is a supabase-js client (or that stand-in). Rows come back exactly as
// the database returns them. This store never emits change events (`notifies` is
// false), so the hub keeps polling at its normal pace.
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StoreError } from "./errors.js";
import {
  EVENT_COLUMNS, PARTICIPANT_ALL_COLUMNS, PARTICIPANT_AUTH, PARTICIPANT_PUBLIC, pickColumns
} from "./columns.js";
import { createEmitter } from "./emitter.js";

// Postgres error classes: 23505 a unique rule; 23502, 23503, 23514 a not-null, foreign-key or check rule.
const fail = (error) => {
  if (error?.code === "23505") throw new StoreError("CONFLICT", error.message);
  if (["23502", "23503", "23514"].includes(error?.code)) throw new StoreError("CONSTRAINT", error.message);
  throw new Error(error.message);
};
const check = ({ data, error }) => {
  if (error) fail(error);
  return data;
};

const noFiles = async () => {
  throw new StoreError("UNSUPPORTED", "Files aren't available with Supabase storage. They need the local data file.");
};

export function createSupabaseStore(client) {
  const bus = createEmitter();
  const from = (table) => client.from(table);

  return {
    kind: "supabase",
    local: false,
    notifies: false,
    subscribe: bus.subscribe,
    client,

    // ── sessions ───────────────────────────────────────────────────
    async createSession({ title, task }) {
      return check(await from("sessions").insert({ title, task, status: "active", step_count: 0 }).select().single());
    },

    async getSession(id) {
      return check(await from("sessions").select().eq("id", id).maybeSingle()) ?? null;
    },

    async updateSession(id, patch) {
      check(await from("sessions").update(patch).eq("id", id));
    },

    async clearAgentWorking() {
      check(await from("sessions").update({ agent_working: false }).eq("agent_working", true));
    },

    async listSessions({ limit = 1000, offset = 0 } = {}) {
      return check(await from("sessions").select().order("created_at", { ascending: true }).range(offset, offset + limit - 1)) ?? [];
    },

    async deleteAllSessions() {
      const rows = check(await from("sessions").select("id")) ?? [];
      if (rows.length) check(await from("sessions").delete().in("id", rows.map((r) => r.id)));
      return rows.length;
    },

    async compact() {},

    async removeBackups() {
      return 0;
    },

    async deleteSession(id) {
      check(await from("sessions").delete().eq("id", id));
    },

    // ── events ─────────────────────────────────────────────────────
    async insertEvent(row) {
      return check(await from("session_events").insert(row).select().single());
    },

    async getEvent(id) {
      return check(await from("session_events").select().eq("id", id).maybeSingle()) ?? null;
    },

    async listEvents(sessionId, { kinds, afterId, uptoId, order = "asc", limit, columns } = {}) {
      const cols = columns == null ? null : pickColumns(columns, EVENT_COLUMNS).join(", ");
      let q = cols ? from("session_events").select(cols) : from("session_events").select();
      q = q.eq("session_id", sessionId);
      if (kinds) q = q.in("kind", kinds);
      if (afterId != null) q = q.gt("id", afterId);
      if (uptoId != null) q = q.lte("id", uptoId);
      q = q.order("id", { ascending: order !== "desc" });
      if (limit != null) q = q.limit(limit);
      return check(await q) ?? [];
    },

    // ── participants ───────────────────────────────────────────────
    async listParticipants(sessionId, { columns } = {}) {
      const cols = pickColumns(columns, PARTICIPANT_ALL_COLUMNS, PARTICIPANT_PUBLIC).join(", ");
      return check(await from("session_participants").select(cols).eq("session_id", sessionId)) ?? [];
    },

    async insertParticipant(row) {
      check(await from("session_participants").insert(row));
    },

    async updateParticipant(sessionId, name, patch) {
      check(await from("session_participants").update(patch).eq("session_id", sessionId).eq("name", name));
    },

    async deleteParticipant(sessionId, name) {
      check(await from("session_participants").delete().eq("session_id", sessionId).eq("name", name));
    },

    async setController(sessionId, name) {
      // Two statements, as before. (The SQLite store does both in one transaction.)
      check(await from("session_participants").update({ role: "watcher" }).eq("session_id", sessionId));
      check(await from("session_participants").update({ role: "controller" }).eq("session_id", sessionId).eq("name", name));
    },

    async touchByToken({ sessionId, tokenHash, lastSeen, now }) {
      const data = check(
        await from("session_participants")
          .update({ last_seen: lastSeen })
          .eq("token_hash", tokenHash)
          .eq("session_id", sessionId)
          .is("token_revoked_at", null)
          .gt("token_expires_at", now)
          .select("name")
      );
      return data?.length ? data[0].name : null;
    },

    async findByTokenHash(hash) {
      return check(await from("session_participants").select(PARTICIPANT_AUTH.join(", ")).eq("token_hash", hash).maybeSingle()) ?? null;
    },

    async revokeToken(sessionId, name) {
      check(
        await from("session_participants")
          .update({ token_revoked_at: new Date().toISOString() })
          .eq("session_id", sessionId)
          .eq("name", name)
      );
    },

    // ── usage ──────────────────────────────────────────────────────
    async claimStep(cap) {
      const { data, error } = await client.rpc("claim_step", { p_cap: cap });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row) throw new Error(error?.message ?? "no result");
      return { allowed: Boolean(row.allowed), used: row.used };
    },

    async budgetStatus() {
      const { error } = await client.from("usage_daily").select("day").limit(1);
      if (!error) return "ok";
      const missing = error.code === "42P01" || error.code === "PGRST205" || /usage_daily/.test(error.message ?? "");
      return missing ? "missing" : "unknown";
    },

    // ── files: not available here ───────────────────────────────────
    // Room files need the local data file. A caller checks `supportsFiles` first; these refuse in plain words if it didn't.
    supportsFiles: false,
    putFile: noFiles,
    getFile: noFiles,
    listFiles: noFiles,
    listFileVersions: noFiles,
    getFileVersion: noFiles,
    deleteFile: noFiles,
    fileUsage: noFiles,

    async close() {}
  };
}

// The library is not part of the default install. It lives in its own small package,
// server/supabase-lib, which only people using Supabase install (see docs/supabase.md).
export const LIBRARY_DIR = fileURLToPath(new URL("../supabase-lib/", import.meta.url));

export const missingLibraryMessage = (dir = LIBRARY_DIR) =>
  "MULTIPLAYER_AI_STORE=supabase needs the Supabase library, which is not installed by default. Install it with:\n" +
  `  cd "${dir.replace(/[\\/]$/, "")}" && npm ci`;

/**
 * Finds createClient: first in the supabase-lib folder, then (an older setup) in
 * the server's own node_modules. Throws the install instructions when neither has it.
 */
export async function loadSupabaseLibrary({ dir = LIBRARY_DIR } = {}) {
  try {
    const require = createRequire(pathToFileURL(path.join(dir, "package.json")));
    const mod = await import(pathToFileURL(require.resolve("@supabase/supabase-js")).href);
    const createClient = mod.createClient ?? mod.default?.createClient;
    if (createClient) return createClient;
  } catch (e) {
    if (e?.code !== "MODULE_NOT_FOUND") throw e;
  }
  try {
    return (await import("@supabase/supabase-js")).createClient;
  } catch (e) {
    if (e?.code !== "ERR_MODULE_NOT_FOUND") throw e;
  }
  throw new Error(missingLibraryMessage(dir));
}

/** Builds the real client from SUPABASE_URL and SUPABASE_SERVICE_KEY. The library is loaded only here. */
export async function createSupabaseStoreFromEnv(env = process.env, { dir } = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    throw new Error("MULTIPLAYER_AI_STORE=supabase needs SUPABASE_URL and SUPABASE_SERVICE_KEY to be set.");
  }
  const createClient = await loadSupabaseLibrary(dir ? { dir } : {});
  // The service_role key bypasses RLS so the orchestrator can do everything it
  // needs. It stays on the server and never reaches the browser.
  return createSupabaseStore(createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } }));
}
