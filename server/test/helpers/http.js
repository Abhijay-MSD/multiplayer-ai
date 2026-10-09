// Raw HTTP requests and a booted local server, for tests that need to send any Host or
// Origin header, or connect from an address other than 127.0.0.1.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startHttp, LOCAL_HOST } from "../../http.js";
import { createSettings, setSettings } from "../../settings.js";
import { setDefaultStore } from "../../store/index.js";
import { createLimits, useLimits } from "../../limits.js";
import { makers, tempDir } from "./stores.js";

export function request(app, { method = "GET", path: p = "/", headers = {}, body, host = LOCAL_HOST, port = app.port } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path: p, headers: { Host: `${LOCAL_HOST}:${app.port}`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    if (body !== undefined) {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      req.setHeader("Content-Type", "application/json");
      req.setHeader("Content-Length", Buffer.byteLength(payload));
      req.write(payload);
    }
    req.end();
  });
}

/** An IPv4 address of this computer that is not loopback, or null (a machine with no network). */
export function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) return i.address;
  }
  return null;
}

/**
 * A running local server on a fresh store, with settings kept in a real folder.
 * Returns { app, store, settings, dir, cookie() } where cookie() signs in the way the
 * terminal's link does and returns the Cookie header value.
 */
export async function boot({ kind = "sqlite", env = {}, host, extraHosts = [], webDir, container = false, adminAuth, ...more } = {}) {
  const store = await makers[kind]();
  setDefaultStore(store);
  useLimits(createLimits({ env: {}, local: true }));
  const dir = path.join(tempDir("multiplayer-ai-settings-"), "data");
  const settings = createSettings({ dir, env });
  setSettings(settings);
  const app = await startHttp({ store, profile: "local", env, port: 0, host, extraHosts, settings, dataDir: dir, webDir, container, ...(adminAuth ? { adminAuth } : {}), log: () => {}, ...more });
  const cookie = async () => {
    const link = new URL(app.admin.link());
    const res = await request(app, { path: link.pathname + link.search });
    const set = res.headers["set-cookie"]?.[0];
    return set ? set.split(";")[0] : null;
  };
  return { app, store, settings, dir, cookie };
}

export const resetSettings = () => setSettings(createSettings({ dir: null }));
