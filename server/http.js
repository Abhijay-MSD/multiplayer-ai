// Starts the HTTP side: the API the web app calls, the live stream, and (on a
// person's own computer) the built web app itself, all from one server on one port.
//
//   profile "local"   listens on 127.0.0.1 only, serves web/dist, checks Host and
//                     Origin, sends no CORS headers. Port MULTIPLAYER_AI_PORT or 3737; if
//                     it is busy, a free one is used and the real address is returned.
//   profile "public"  what the server did before the storage layer: listens on PORT
//                     (all interfaces), CORS for PUBLIC_URL, no web files. For a
//                     deployment where the web app is served elsewhere.
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import express from "express";
import { ApiError } from "./errors.js";
import { lanCandidates, parseShareName } from "./sharing.js";
import { createApi } from "./api.js";
import { createHub, setHub } from "./hub.js";
import { streamRoute } from "./stream.js";
import { webHandlers } from "./handlers.js";
import { resetWorkingFlags } from "./tools/step_agent.js";
import { setRuntimeUrl } from "./config.js";
import { createAdminAuth, createAdminGate, createExchange } from "./admin.js";
import { createInvite, setInvite } from "./invite.js";
import { createControlRequests, setControl } from "./control.js";
import { sweepControl } from "./host-actions.js";
import { getSettings } from "./settings.js";
import { containerMode } from "./container.js";

export const DEFAULT_PORT = 3737;
export const LOCAL_HOST = "127.0.0.1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WEB_DIR = path.resolve(HERE, "../web/dist");

/** Which address to listen on: what was asked for; else every interface in a container (Docker's port publishing needs it); else this computer only (a local copy); else the system default. */
export const listenHostFor = ({ host, container, local }) => host ?? (container ? "0.0.0.0" : local ? LOCAL_HOST : undefined);

/** Every route registered on `app`, as { method, path }. For tests that every route is covered. */
function listRoutes(app) {
  const out = [];
  for (const layer of app._router?.stack ?? []) {
    if (layer.route) for (const method of Object.keys(layer.route.methods)) out.push({ method, path: layer.route.path });
  }
  return out;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(e);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(server.address().port);
    });
  });
}

/**
 * Starts the server. Resolves to { url, port, host, hub, close() }.
 * Throws if the port cannot be used and the profile does not pick another.
 */
export async function startHttp({
  store,
  profile = "local",
  env = process.env,
  port,
  host,
  webDir = DEFAULT_WEB_DIR,
  settings = getSettings(),
  dataDir = null,
  extraHosts = [], // more Host values the rooms answer to (tests, and a later sharing mode); never the settings routes
  container = containerMode(env).on, // inside a container: listen on every interface, and let the sign-in cookie alone prove the owner
  adminAuth = createAdminAuth(), // a stand-in with its own clock, for tests
  interfaces = () => os.networkInterfaces(), // this computer's network addresses (a stand-in in tests)
  watchMs = 5000, // how often a shared address is checked to still be there
  log = (line) => console.error(line)
} = {}) {
  const local = profile === "local";
  let actualPort = null;
  // In a container the host reaches us on a port Docker published; that is the port the browser's Host header carries.
  const publicPort = () => (container && Number(env.MULTIPLAYER_AI_PUBLIC_PORT)) || actualPort;

  const loopbackHosts = () => [`localhost:${publicPort()}`, `${LOCAL_HOST}:${publicPort()}`];
  const auth = adminAuth;
  const gate = createAdminGate({ auth, loopbackHosts, requireLoopbackSocket: !container });

  // ── Sharing: a second listener on ONE chosen address ───────────────
  // Never on every interface. If the address goes away the listener is closed, not widened.
  const lan = { server: null, address: null, notice: null, timer: null };
  let shareName = null; // in a container: the address the host says other people use
  const sharingActive = () => container || lan.server !== null;
  const normalizeIp = (a) => String(a ?? "").replace(/^::ffff:/, "");
  const onLanListener = (req) => lan.server !== null && normalizeIp(req.socket?.localAddress) === lan.address;

  // Which Host values a connection may use depends on the listener that took it, not on a header it chose.
  const hostsFor = (req) => {
    if (container) return [...loopbackHosts(), ...(shareName ? [`${shareName}:${publicPort()}`] : []), ...extraHosts];
    if (onLanListener(req)) return [`${lan.address}:${actualPort}`];
    return [...loopbackHosts(), ...extraHosts];
  };
  // The host-only routes exist on this computer's own listener (and, in a container, on the one listener, behind the cookie).
  const hostOnlyHere = (req) => container || !onLanListener(req);

  const unavailable = () => {
    if (!store.local) return new ApiError(409, "SHARING_UNAVAILABLE", "Sharing needs the local data file. It isn't available with Supabase storage.");
    if (container) return new ApiError(409, "SHARING_IN_CONTAINER", "Inside a container Multiplayer AI can't see your network. Enter the address people will use instead.");
    return null;
  };

  async function disableSharing(notice = null) {
    clearInterval(lan.timer);
    const server = lan.server;
    lan.server = null;
    lan.address = null;
    lan.timer = null;
    lan.notice = notice;
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  }

  async function enableSharing(address, { acknowledgeUnusual = false } = {}) {
    const refused = unavailable();
    if (refused) throw refused;
    if (lan.server) throw new ApiError(409, "ALREADY_SHARING", "Sharing is already on. Turn it off first to share on a different address.");
    const chosen = typeof address === "string" ? lanCandidates(interfaces()).find((c) => c.address === address) : null;
    if (!chosen) throw new ApiError(400, "BAD_ADDRESS", "That isn't one of this computer's network addresses.");
    if (chosen.kind !== "private" && !acknowledgeUnusual) throw new ApiError(409, "ADDRESS_UNUSUAL", `${chosen.warning} Choose it only if you are sure.`);

    const server = createServer(app);
    try {
      await listen(server, actualPort, chosen.address); // this address only: never "0.0.0.0", never "::"
    } catch (e) {
      if (e?.code === "EADDRINUSE") throw new ApiError(409, "PORT_BUSY_ON_ADDRESS", `Port ${actualPort} is already in use on that address, so Multiplayer AI can't share there.`);
      if (e?.code === "EADDRNOTAVAIL" || e?.code === "EINVAL") throw new ApiError(409, "ADDRESS_GONE", "That address is no longer available on this computer. Pick the address again.");
      throw e;
    }
    lan.server = server;
    lan.address = chosen.address;
    lan.notice = null;
    lan.timer = setInterval(() => {
      if (lanCandidates(interfaces()).some((c) => c.address === lan.address)) return;
      const gone = lan.address;
      log(`[multiplayer-ai] the network address ${gone} went away, so sharing was turned off. Turn it on again from Settings.`);
      disableSharing(`The network address ${gone} went away (the network changed or disconnected), so sharing was turned off. Turn sharing on again to choose an address.`);
    }, watchMs);
    lan.timer.unref?.();
  }

  const sharing = {
    get listener() {
      return lan.server;
    },
    /** Is the app reachable beyond this computer? Always, in a container (it can't know how the port is published). */
    active: sharingActive,
    enable: enableSharing,
    disable: () => disableSharing(null),
    /** In a container: the address other people use to reach this computer. Only exactly this Host is then accepted besides localhost. */
    setShareName(text) {
      if (!container) throw new ApiError(409, "NOT_IN_CONTAINER", "This is only for Multiplayer AI running in a container.");
      if (text === null || text === "") {
        shareName = null;
        return null;
      }
      const parsed = parseShareName(text);
      if (!parsed.ok) throw new ApiError(400, "BAD_ADDRESS", parsed.message);
      shareName = parsed.host;
      return shareName;
    },
    status() {
      const unavailableNow = unavailable();
      const base = container ? `http://${shareName ?? "<your address>"}:${publicPort()}` : lan.server ? `http://${lan.address}:${actualPort}` : null;
      return {
        available: !(unavailableNow && unavailableNow.code === "SHARING_UNAVAILABLE"),
        container,
        active: sharingActive(),
        address: lan.address,
        shareName,
        port: container ? publicPort() : actualPort,
        url: container ? (shareName ? base : null) : lan.server ? base : null,
        notice: lan.notice,
        candidates: container ? [] : lanCandidates(interfaces())
      };
    }
  };

  const callerFor = (req) => ({ host: gate.isHost(req), sharing: sharingActive() });

  // Sharing needs the local data file (that is where the invite version and the host mark live) and a data folder for the instance key.
  if (container && !store.local) {
    throw new Error("Container mode needs the local data file; it can't be used with Supabase storage, because every shared room needs the host controls.");
  }
  const invite = store.local && dataDir ? createInvite({ dir: dataDir }) : null;
  if (invite) setInvite(invite);
  const control = createControlRequests();
  setControl(control);
  const sweeper = setInterval(() => sweepControl({ store, control }).catch(() => {}), 15_000);
  sweeper.unref?.();

  const app = createApi({
    handlers: webHandlers,
    env,
    local: local ? { allowedHosts: hostsFor, hostOnlyHere } : null,
    admin: local ? { settings, store, gate: gate.gate, exchange: createExchange({ auth, gate }), dataDir, callerFor, sharing, control, invite, env, localUrl: () => url } : null
  });

  // Live updates: the browser reads this instead of the database.
  const hub = createHub({ db: store });
  setHub(hub);
  app.get("/api/stream/:session_id", streamRoute({ db: store, hub }));

  if (local) {
    // Anything under /api that isn't a route above is a 404 in the API's own format, not index.html.
    app.use("/api", (req, res) => res.status(404).json({ error: "Not found.", code: "NOT_FOUND" }));
    // "Your rooms" is the host's page. For anyone who isn't the host (no sign-in cookie, a wrong Host, another listener) it is a plain
    // 404 with no page in it; on the network address the guard has already answered 404 before this runs.
    const hostPage = (req, res, next) => {
      res.set("Cache-Control", "no-store");
      if (!gate.isHost(req)) return res.status(404).type("text/plain").send("Not found.");
      next();
    };
    app.get("/rooms", hostPage);
    app.get("/rooms/*", hostPage);
    if (fs.existsSync(path.join(webDir, "index.html"))) {
      app.use(express.static(webDir, { index: false }));
      // A link like /s/<room>/join is a page of the web app; it loads index.html and the app reads the path.
      app.get("*", (req, res) => res.sendFile(path.join(webDir, "index.html")));
    } else {
      log(`[multiplayer-ai] the web app has not been built (no ${path.join(webDir, "index.html")}); only the API is served.`);
    }
  }

  // A crash mid-step would leave rooms stuck on "working".
  resetWorkingFlags();

  const server = createServer(app);
  const listenHost = listenHostFor({ host, container, local });
  const wanted = port ?? (local ? Number(env.MULTIPLAYER_AI_PORT) || DEFAULT_PORT : Number(env.PORT));
  try {
    actualPort = await listen(server, wanted, listenHost);
  } catch (e) {
    if (e?.code !== "EADDRINUSE" || !local) throw e;
    actualPort = await listen(server, 0, listenHost); // let the system pick a free one
    log(
      `[multiplayer-ai] port ${wanted} is busy${env.MULTIPLAYER_AI_PORT ? " (it is the one set in MULTIPLAYER_AI_PORT)" : ""}. ` +
      `Another copy of Multiplayer AI or another program is using it, so this copy is using ${actualPort} instead. ` +
      "If Multiplayer AI is already running there, close one of the two."
    );
  }

  const shownHost = local ? LOCAL_HOST : "localhost";
  const url = `http://${shownHost}:${publicPort()}`;
  if (local) setRuntimeUrl(url);
  return {
    url,
    port: actualPort,
    host: listenHost,
    container,
    sharing,
    routes: () => listRoutes(app),
    hub,
    server,
    admin: {
      auth,
      /** A one-time sign-in link for this copy's owner: opens Setup and Settings in their browser. */
      link: (target = "/") => {
        const link = new URL(target, url);
        link.searchParams.set("admin", auth.issueCode());
        return link.href;
      }
    },
    close: async () => {
      clearInterval(sweeper);
      await disableSharing(null);
      await new Promise((resolve) => {
        hub.dispose();
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    }
  };
}
