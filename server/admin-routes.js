// The routes behind Setup and Settings. All but /api/status sit behind the admin gate
// (admin.js). Nothing here ever returns a key: the settings view carries the last 4
// characters, and an error carries a category, not the provider's words.
import { ApiError, errorBody } from "./errors.js";
import { SettingsError } from "./settings.js";
import { redact } from "./secrets.js";
import { testKey } from "./key-test.js";
import { parseCompatBaseUrl } from "./providers/compat-url.js";
import { exportFileName, streamExport } from "./data-export.js";
import { stepsInProgress } from "./tools/step_agent.js";
import { mountHostRoutes } from "./host-routes.js";
import { escapeForLog } from "./safe-text.js";

export const CONFIRM_DELETE_KEY = "delete key";
export const CONFIRM_DELETE_ROOMS = "delete all rooms";

export function mountAdminRoutes(app, { settings, store, gate, exchange, dataDir = null, callerFor = () => ({ host: false, sharing: false }), sharing, control, invite = null, localUrl = () => "", env = process.env }) {
  app.use(exchange);

  // The one thing anyone may ask: is a model key set up. (A yes or no, nothing else.)
  app.get("/api/status", (req, res) => {
    res.set("Cache-Control", "no-store");
    const caller = callerFor(req);
    res.json({ configured: settings.configured(), sharing: Boolean(caller.sharing), host: Boolean(caller.host) });
  });

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof SettingsError) return res.status(400).json(errorBody(new ApiError(400, e.code, e.message)));
      if (e instanceof ApiError) return res.status(e.status).json(errorBody(e));
      console.error(`[multiplayer-ai] ${req.method} ${req.path} failed: ${escapeForLog(redact(e?.message ?? e))}`);
      res.status(500).json({ error: "Something went wrong on this computer. The details are in the terminal.", code: "INTERNAL" });
    }
  };

  const view = () => ({
    ...settings.publicView(),
    storage: { kind: store.kind, file: store.file ?? null, folder: dataDir }
  });

  app.use(["/api/settings", "/api/data", "/api/host"], gate);

  mountHostRoutes(app, { store, sharing, control, invite, localUrl, wrap, env });

  app.get("/api/settings", wrap((req, res) => res.json(view())));

  app.put("/api/settings", wrap((req, res) => {
    const { provider, model, base_url: baseUrl } = req.body ?? {};
    settings.save({ provider, model, baseUrl });
    res.json(view());
  }));

  app.put("/api/settings/key", wrap((req, res) => {
    const { provider, key } = req.body ?? {};
    settings.saveKey(provider, key);
    res.json(view());
  }));

  app.delete("/api/settings/key", wrap((req, res) => {
    const { provider, confirm } = req.body ?? {};
    if (confirm !== CONFIRM_DELETE_KEY) throw new ApiError(400, "CONFIRM_MISMATCH", `Type "${CONFIRM_DELETE_KEY}" to confirm.`);
    const removed = settings.deleteKey(provider);
    res.json({ ...view(), removed });
  }));

  app.post("/api/settings/key/test", wrap(async (req, res) => {
    const { provider, key, base_url: baseUrl, model } = req.body ?? {};
    res.json(await testKey({ provider, key, baseUrl, model }, { settings }));
  }));

  // What the key would be sent to, for the form to show as the person types the address.
  app.post("/api/settings/base-url/check", wrap((req, res) => {
    const url = parseCompatBaseUrl(req.body?.base_url);
    res.json(url.ok ? { ok: true, display: url.display, host: url.host, local: url.local } : { ok: false, message: url.message });
  }));

  app.post("/api/data/export", wrap(async (req, res) => {
    res.set({
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFileName()}"`,
      "Cache-Control": "no-store"
    });
    await streamExport(store, res);
  }));

  app.post("/api/data/delete-rooms", wrap(async (req, res) => {
    if (req.body?.confirm !== CONFIRM_DELETE_ROOMS) throw new ApiError(400, "CONFIRM_MISMATCH", `Type "${CONFIRM_DELETE_ROOMS}" to confirm.`);
    const working = stepsInProgress() || (await store.listSessions({ limit: 100000 })).some((s) => s.agent_working);
    if (working) throw new ApiError(409, "AGENT_WORKING", "An agent is replying right now. Wait for it to finish, then try again.");
    const rooms = await store.deleteAllSessions();
    const backups = await store.removeBackups();
    await store.compact();
    invite?.rotate(); // every earlier share link dies with the rooms it opened
    res.json({ deleted_rooms: rooms, removed_backups: backups });
  }));
}
