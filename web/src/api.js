// Thin REST wrapper around the orchestrator's MCP tools (PRD §11).
// server/server.js exposes POST /api/tools/:name when PORT is set. Every call
// that acts for a participant carries the room token the server issued.
// Where the API lives. Empty means same origin (the dev proxy, or a deploy that
// serves both from one host); set VITE_API_URL at build time otherwise.
export const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

// A failed call, with the server's stable `code` (NAME_TAKEN, INVALID_TOKEN,
// CONTROL_HELD, ...), its HTTP status, and any extra fields such as `suggestion`.
export class ApiError extends Error {
  // retryAfter: seconds to wait, when the server says (rate limiting).
  constructor(message, { code = "UNKNOWN", status = 0, ...extra } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

async function callTool(name, args) {
  let res;
  try {
    res = await fetch(`${API_BASE}/api/tools/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args)
    });
  } catch {
    throw new ApiError("Can't reach the server. Check your connection and try again.", { code: "NETWORK" });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const { error, code, retry_after, ...extra } = data;
    // A gateway answering for a server that isn't there (no JSON body from us).
    const down = !code && [502, 503, 504].includes(res.status);
    throw new ApiError(error || `${name} failed (${res.status})`, {
      code: code ?? (down ? "SERVER_DOWN" : undefined),
      status: res.status,
      retryAfter: (retry_after ?? Number(res.headers.get("retry-after"))) || undefined,
      ...extra
    });
  }
  return data;
}

// The one setting the server shares with the page: how many agent replies a
// room allows. Asked once; if the server doesn't answer, the page uses its own
// default. Never throws.
let configRequest = null;
export function getConfig() {
  configRequest ??= fetch(`${API_BASE}/api/config`)
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => (Number.isInteger(data?.max_steps_per_session) && data.max_steps_per_session > 0 ? data : null))
    .catch(() => null);
  return configRequest;
}

export const createSession = (args) => callTool("create_session", args);
export const joinSession = (args) => callTool("join_session", args);
export const sendDirective = (args) => callTool("send_directive", args);
export const sendComment = (args) => callTool("send_comment", args);
export const retryLast = (args) => callTool("retry_last", args);
export const stopAgent = (args) => callTool("stop_agent", args);
export const takeControl = (args) => callTool("take_control", args);
export const heartbeat = (args) => callTool("heartbeat", args);
// The room's files (server/tools/files.js). Everyone in the room may list and read; the controller or the host may attach.
export const listRoomFiles = (args) => callTool("list_room_files", args);
export const getRoomFile = (args) => callTool("get_room_file", args);
export const fileVersions = (args) => callTool("file_versions", args);
export const attachFile = (args) => callTool("attach_file", args);

// Best-effort "I'm leaving" for pagehide/visibilitychange. sendBeacon survives
// the page being torn down; fetch with keepalive is the fallback. Failures are
// ignored on purpose.
export function leaveSession(args) {
  const url = `${API_BASE}/api/tools/leave_session`;
  const body = JSON.stringify(args);
  try {
    if (navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) return;
  } catch {
    /* fall through to fetch */
  }
  try {
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  } catch {
    /* nothing more to try */
  }
}
