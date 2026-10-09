// Who may change settings, read or replace the key, export data, or delete it.
//
// Only the person at this computer, and only from a browser Multiplayer AI opened for them.
// Every one of these must hold, or the request is refused:
//
//   1. the connection comes from this computer (the socket's own remote address, not a
//      header anyone can write);
//   2. the Host header is exactly localhost or 127.0.0.1 with our port, even if other hosts
//      are allowed for rooms (a shared link on the Wi-Fi, a tunnel);
//   3. no proxy or tunnel header is present;
//   4. an Origin header, if there is one, is our own, and every request that changes
//      something carries one (a browser always sends it; a request without one did not
//      come from a page of ours);
//   5. the browser does not mark the request as coming from another site or another port
//      (Sec-Fetch-Site must be same-origin, or none for a link typed or clicked outside the browser);
//   6. a valid admin cookie.
//
// The cookie is what separates the person who started Multiplayer AI from a tunnel: a tunnel
// connects from this computer and can rewrite Host, but it cannot have the cookie. The
// cookie is handed over by a one-time code in the link the terminal prints (and the
// launcher opens). The code lasts a few minutes, works once, is compared in constant time,
// and is removed from the address bar at once.
//
// Cookie scope: the cookie is HttpOnly and SameSite=Strict, but browsers do not keep cookies
// apart by port, so a page served from another port on the same host (http://localhost:5173,
// say) has its requests to us sent with the cookie. Checks 4 and 5 are what stop that page
// from using it: its requests carry its own Origin, and the browser marks them same-site, not
// same-origin. A program that is not a browser and has been handed the cookie value could still
// build a request with our Origin header; that is a program already running as you on this
// computer. The cookie also lives in this process: restarting Multiplayer AI ends it.
import crypto from "node:crypto";
import { ApiError, errorBody } from "./errors.js";
import { hasProxyHeader } from "./local-guard.js";

export const COOKIE_NAME = "multiplayer_ai_admin";
export const CODE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;

const sha = (text) => crypto.createHash("sha256").update(String(text)).digest();
const random = () => crypto.randomBytes(32).toString("base64url");

export function createAdminAuth({ now = Date.now, codeTtlMs = CODE_TTL_MS, sessionTtlMs = SESSION_TTL_MS } = {}) {
  const codes = new Map(); // sha256(code) as hex -> expiry
  const sessions = new Map(); // sha256(cookie value) as hex -> expiry

  const prune = (map) => {
    const t = now();
    for (const [k, exp] of map) if (exp <= t) map.delete(k);
  };

  /** Finds `value` among stored hashes, comparing every entry in constant time. Returns its key or null. */
  const find = (map, value) => {
    prune(map);
    const given = sha(value);
    let hit = null;
    for (const key of map.keys()) {
      if (crypto.timingSafeEqual(given, Buffer.from(key, "hex"))) hit = key; // no early exit
    }
    return hit;
  };

  return {
    /** A new one-time code, good for a few minutes. */
    issueCode() {
      const code = random();
      prune(codes);
      codes.set(sha(code).toString("hex"), now() + codeTtlMs);
      return code;
    },
    /** Spends a code. Returns the cookie value to set, or null if the code is wrong, expired or used. */
    exchange(code) {
      if (typeof code !== "string" || code.length < 16 || code.length > 200) return null;
      const hit = find(codes, code);
      if (!hit) return null;
      codes.delete(hit);
      const cookie = random();
      sessions.set(sha(cookie).toString("hex"), now() + sessionTtlMs);
      return cookie;
    },
    isValidSession(cookie) {
      return typeof cookie === "string" && cookie.length > 0 && cookie.length <= 200 && find(sessions, cookie) !== null;
    },
    revokeAll() {
      codes.clear();
      sessions.clear();
    }
  };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export const adminCookie = (value) => `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;

const isLoopback = (address) => {
  const a = String(address ?? "").replace(/^::ffff:/, "");
  return a === "::1" || a.startsWith("127.");
};


const SAFE = new Set(["GET", "HEAD"]);
const FOREIGN = "That request didn't come from the Multiplayer AI page in this browser, so it was refused.";
const LOCAL_ONLY = "This can only be done from the computer Multiplayer AI is running on, in the browser it opened.";
const LINK_NEEDED = "Open Multiplayer AI from the link in the terminal where you started it. That link signs this browser in.";

/**
 * `loopbackHosts()` returns the only Host values accepted here ("localhost:3737", "127.0.0.1:3737").
 *
 * `requireLoopbackSocket` is true everywhere except inside a container, where a browser on the
 * host arrives from Docker's network and the socket can't say "this computer". Turning that one
 * check off makes the sign-in code and cookie the whole of the proof: nothing here passes a
 * request that lacks a valid cookie, and a cookie only comes from spending a code. If no code
 * was ever issued, or it expired, or was used, no cookie exists and every route fails closed.
 *
 * Returns { checkLocal(req) -> null | ApiError, gate(req, res, next) }.
 */
export function createAdminGate({ auth, loopbackHosts, requireLoopbackSocket = true }) {
  const origins = () => loopbackHosts().map((h) => `http://${h}`.toLowerCase());

  function checkLocal(req) {
    if (requireLoopbackSocket && !isLoopback(req.socket?.remoteAddress)) return new ApiError(403, "ADMIN_LOCAL_ONLY", LOCAL_ONLY);
    if (!loopbackHosts().map((h) => h.toLowerCase()).includes(String(req.headers.host ?? "").toLowerCase())) {
      return new ApiError(403, "ADMIN_LOCAL_ONLY", LOCAL_ONLY);
    }
    if (hasProxyHeader(req.headers)) return new ApiError(403, "ADMIN_LOCAL_ONLY", LOCAL_ONLY);
    const origin = req.headers.origin;
    if (origin !== undefined && !origins().includes(String(origin).toLowerCase())) return new ApiError(403, "BAD_ORIGIN", LOCAL_ONLY);
    return null;
  }

  /**
   * Is this request from the host: this computer, the right Host, no proxy headers, a valid sign-in cookie,
   * the browser saying it is our own page, and (for anything that changes something) an Origin? Used to
   * decide who may start a room or join without an invite; it never answers for Settings (that is the gate).
   */
  function isHost(req) {
    if (checkLocal(req) !== null) return false;
    if (!auth.isValidSession(parseCookies(req.headers.cookie)[COOKIE_NAME])) return false;
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") return false;
    if (!SAFE.has(req.method) && req.headers.origin === undefined) return false;
    return true;
  }

  function gate(req, res, next) {
    res.set("Cache-Control", "no-store");
    const refused = checkLocal(req);
    if (refused) return res.status(refused.status).json(errorBody(refused));
    if (!auth.isValidSession(parseCookies(req.headers.cookie)[COOKIE_NAME])) {
      const e = new ApiError(401, "ADMIN_LINK_NEEDED", LINK_NEEDED);
      return res.status(401).json(errorBody(e));
    }
    // With a valid cookie: where did the request come from?
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      return res.status(403).json(errorBody(new ApiError(403, "BAD_ORIGIN", FOREIGN)));
    }
    if (!SAFE.has(req.method) && req.headers.origin === undefined) {
      return res.status(403).json(errorBody(new ApiError(403, "BAD_ORIGIN", FOREIGN)));
    }
    next();
  }

  return { checkLocal, gate, isHost };
}

/**
 * Middleware for the sign-in link (/?admin=<code>): spends the code, sets the cookie,
 * and redirects to the same address without the code. A wrong code only costs the person
 * the cookie; they are sent on to the page either way.
 */
export function createExchange({ auth, gate }) {
  return function exchange(req, res, next) {
    if (req.method !== "GET") return next();
    const url = new URL(req.originalUrl, "http://local.invalid");
    if (!url.searchParams.has("admin")) return next();
    const code = url.searchParams.get("admin");
    url.searchParams.delete("admin");
    res.set("Cache-Control", "no-store");
    const cookie = gate.checkLocal(req) === null ? auth.exchange(code) : null;
    if (cookie) res.append("Set-Cookie", adminCookie(cookie));
    else {
      console.error(
        "[multiplayer-ai] a sign-in link was refused: it had expired, been used already, or was opened from somewhere other than this computer. " +
        (process.stdin.isTTY
          ? "Press Enter here for a new link."
          : "To get a new link, restart Multiplayer AI, or send this process the signal SIGUSR2 (with Docker: docker kill -s USR2 <container name>).")
      );
      return res.redirect(303, "/signin-expired");
    }
    res.redirect(303, url.pathname + url.search);
  };
}
