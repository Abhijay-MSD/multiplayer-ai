// Calls to the routes behind Setup and Settings (server/admin-routes.js). They are
// answered only for the person who opened Multiplayer AI from the terminal's link; anyone else
// gets ADMIN_LINK_NEEDED or ADMIN_LOCAL_ONLY. A key goes out in a request body, never in an
// address, and nothing here stores one: not in localStorage, not in sessionStorage.
import { API_BASE, ApiError } from "../api";

async function call(method, route, body) {
  let res;
  try {
    res = await fetch(`${API_BASE}${route}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store"
    });
  } catch {
    throw new ApiError("Can't reach Multiplayer AI. Is it still running in the terminal?", { code: "NETWORK" });
  }
  return res;
}

async function json(method, route, body) {
  const res = await call(method, route, body);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data.error || `That didn't work (${res.status}).`, { code: data.code ?? (res.status >= 500 ? "SERVER_DOWN" : "UNKNOWN"), status: res.status });
  }
  return data;
}

/** Is a model key set up, is the app shared, and is this the host? Anyone may ask. Anything other than a clear answer within 2 seconds is null. */
export async function getStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/status`, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.configured === "boolean" ? { configured: data.configured, sharing: data.sharing === true, host: data.host === true } : null;
  } catch {
    return null;
  }
}

export const getSettings = () => json("GET", "/api/settings");
export const saveSettings = (args) => json("PUT", "/api/settings", args);
export const saveKey = (provider, key) => json("PUT", "/api/settings/key", { provider, key });
export const deleteKey = (provider, confirm) => json("DELETE", "/api/settings/key", { provider, confirm });
export const testKey = (args) => json("POST", "/api/settings/key/test", args);
export const checkBaseUrl = (baseUrl) => json("POST", "/api/settings/base-url/check", { base_url: baseUrl });
// The host's sharing controls (server/host-routes.js). Answered only to the host, on this computer.
export const getSharing = () => json("GET", "/api/host/sharing");
export const setSharing = (args) => json("PUT", "/api/host/sharing", args);
export const getRoomPanel = (id) => json("GET", `/api/host/rooms/${id}`);
export const setRoomPolicy = (id, policy) => json("PUT", `/api/host/rooms/${id}/policy`, { policy });
export const setGuestCap = (id, cap) => json("PUT", `/api/host/rooms/${id}/guest-cap`, { cap });
export const listRooms = () => json("GET", "/api/host/rooms");
export const renameRoom = (id, title) => json("PUT", `/api/host/rooms/${id}/title`, { title });
export const archiveRoom = (id, archived) => json("POST", `/api/host/rooms/${id}/archive`, { archived });
export const deleteRoom = (id, confirm) => json("POST", `/api/host/rooms/${id}/delete`, { confirm });
export const setRoomBrief = (id, brief) => json("PUT", `/api/host/rooms/${id}/brief`, { brief });
export const setRoomFiles = (id, enabled) => json("PUT", `/api/host/rooms/${id}/files`, { enabled });
export const deleteRoomFile = (id, name) => json("POST", `/api/host/rooms/${id}/files/delete`, { name });
export const restoreRoomFile = (id, name, version) => json("POST", `/api/host/rooms/${id}/files/restore`, { name, version });
export const makeNewLink = (id) => json("POST", `/api/host/rooms/${id}/rotate-link`);
export const decideControl = (id, requestId, decision) => json("POST", `/api/host/rooms/${id}/control/${encodeURIComponent(requestId)}`, { decision });
export const removePerson = (id, name) => json("POST", `/api/host/rooms/${id}/remove`, { name });
export const deleteRooms = (confirm) => json("POST", "/api/data/delete-rooms", { confirm });

/** Asks for the export and hands it to the browser as a file download. Returns the file name. */
export async function exportData() {
  const res = await call("POST", "/api/data/export");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error || "The export didn't work.", { code: data.code ?? "UNKNOWN", status: res.status });
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "multiplayer-ai-export.json";
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}
