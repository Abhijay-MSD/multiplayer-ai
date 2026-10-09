// The HTTP side of the tools the web app may call: CORS, the body-size limit,
// who is calling (for the per-IP limits) and the error format. server.js adds
// the live stream on top. Kept apart from server.js so tests can build it
// without starting the MCP transport.
import express from "express";
import { ApiError, errorBody } from "./errors.js";
import { intSetting, maxStepsPerSession, trustProxyHops } from "./config.js";
import { createLocalGuard } from "./local-guard.js";
import { mountAdminRoutes } from "./admin-routes.js";
import { escapeForLog } from "./safe-text.js";
import { fileLimits } from "./files/limits.js";

/**
 * `local`, when given, is { allowedHosts() }: the app runs on one person's
 * computer, so requests are checked (local-guard.js) and no CORS headers are sent.
 * Without it the API answers a web app on another origin (PUBLIC_URL), as before.
 * `admin`, when given, adds the settings and data routes (see admin-routes.js).
 */
export function createApi({ handlers, env = process.env, local = null, admin = null }) {
  const app = express();
  app.disable("x-powered-by");
  if (local) app.use(createLocalGuard(local));
  // Who is calling: the address that connected, or with TRUST_PROXY_HOPS the
  // one a trusted proxy forwarded. Used only to rate-limit starting and joining.
  app.set("trust proxy", trustProxyHops(env));

  // CORS: the web app (a different origin/port in dev, e.g. localhost:5173)
  // calls this API from the browser.
  if (!local) app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", env.PUBLIC_URL || "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // After CORS, so even a refused body is one the browser is allowed to read. Attaching a file is the one request that
  // carries a whole file, so it may be as large as a file can be (a file full of characters JSON writes as six, plus a
  // little for the rest); everything else keeps the small limit.
  const small = express.json({ limit: `${intSetting("MAX_BODY_KB", env)}kb` });
  const large = (req, res, next) => express.json({ limit: fileLimits(env).maxFileBytes * 6 + 4096 })(req, res, next);
  app.use((req, res, next) => (req.method === "POST" && req.path === "/api/tools/attach_file" ? large : small)(req, res, next));

  // A body that is too large or isn't JSON gets the same JSON error shape as every other failure.
  app.use((err, req, res, next) => {
    if (err?.type === "entity.too.large") {
      return res.status(413).json(errorBody(new ApiError(413, "BAD_REQUEST", "That request is too large. Shorten what you wrote and try again.")));
    }
    if (err?.type === "entity.parse.failed") {
      return res.status(400).json(errorBody(new ApiError(400, "BAD_REQUEST", "That request wasn't valid.")));
    }
    next(err);
  });

  if (admin) mountAdminRoutes(app, admin);

  // The one setting the browser needs from the server: how many agent replies a
  // room allows, so the room can show how many are left. Nothing else is returned.
  app.get("/api/config", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ max_steps_per_session: maxStepsPerSession(env) });
  });

  app.post("/api/tools/:name", async (req, res) => {
    const handler = Object.hasOwn(handlers, req.params.name) ? handlers[req.params.name] : null;
    if (!handler) return res.status(404).json({ error: `Unknown tool: ${req.params.name}`, code: "UNKNOWN_TOOL" });
    try {
      res.json(await handler(req.body ?? {}, { ip: req.ip, ...(admin?.callerFor ? { caller: admin.callerFor(req) } : {}) }));
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 429 && e.extra?.retry_after) res.set("Retry-After", String(e.extra.retry_after));
        return res.status(e.status).json(errorBody(e));
      }
      console.error(`[multiplayer-ai] ${escapeForLog(req.params.name)} failed: ${escapeForLog(e?.message ?? e)}`);
      res.status(500).json({ error: "Something went wrong on the server. Try again in a moment.", code: "INTERNAL" });
    }
  });

  return app;
}
