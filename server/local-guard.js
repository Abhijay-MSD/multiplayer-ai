// Request hardening for the app that runs on one person's computer.
//
// The app listens on 127.0.0.1 (and, only when the host turns sharing on, on one chosen
// address of their network), but a web page the person visits can still make their
// browser send requests to it. These stop that:
//
//   * Host check. Only "localhost:<our port>" and "127.0.0.1:<our port>" are
//     served. A page that points its own domain at 127.0.0.1 (DNS rebinding)
//     sends that domain in the Host header, and is refused.
//   * Origin check. A state-changing request (POST and the like) that carries an
//     Origin from anywhere else is refused, and so is one the browser marks as
//     cross-site. Requests with no Origin come from programs, not web pages.
//   * Which Host is accepted depends on the listener that took the connection (see http.js), so
//     a client on the network address cannot pass itself off as localhost.
//   * A request that carries proxy or tunnel headers is refused on every route: Multiplayer AI does not
//     support tunnels or reverse proxies yet, and those headers are how a request that did not come
//     from this computer's own browser looks when it arrives through one.
//   * No CORS headers at all, so a page on another origin cannot read a response
//     even for a request that got through. A preflight is answered 405.
//
// `allowedHosts(req)` returns the host:port strings to accept for the listener that took the
// request, read per request because the real port is only known after the server has started.
import { ApiError, errorBody } from "./errors.js";

const SAFE = new Set(["GET", "HEAD"]);

const PROXY_HEADERS = ["forwarded", "via", "x-real-ip", "true-client-ip", "x-original-host", "x-forwarded-server"];
/** Does the request carry a header that a proxy or a tunnel adds? */
export const hasProxyHeader = (headers) =>
  PROXY_HEADERS.some((h) => h in headers) || Object.keys(headers).some((h) => h.startsWith("x-forwarded-") || h.startsWith("cf-"));

// Routes that exist only for the person at this computer.
const HOST_ONLY_PATH = /^(\/api\/(settings|data|host)|\/rooms)(\/|$)/;
const isHostOnlyRequest = (req) => {
  const url = new URL(req.originalUrl, "http://local.invalid");
  return HOST_ONLY_PATH.test(url.pathname) || url.searchParams.has("admin");
};

/**
 * `allowedHosts(req)` returns the Host values accepted on the listener that took `req`.
 * `hostOnlyHere(req)` says whether the host-only routes exist on that listener at all: on a
 * listener open to the network they do not, whatever the headers and cookies say.
 */
export function createLocalGuard({ allowedHosts, hostOnlyHere = () => true }) {
  const refuse = (res, status, code, message) => res.status(status).json(errorBody(new ApiError(status, code, message)));

  return function guard(req, res, next) {
    // Always: stop the browser from guessing types, framing the app, or leaking the address.
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer"
    });

    if (hasProxyHeader(req.headers)) {
      return refuse(res, 403, "PROXY_NOT_SUPPORTED", "This request came through a proxy or tunnel, which Multiplayer AI doesn't support yet, so it was refused.");
    }

    const hosts = new Set(allowedHosts(req).map((h) => h.toLowerCase()));
    const host = String(req.headers.host ?? "").toLowerCase();
    if (!hosts.has(host)) {
      return refuse(res, 403, "BAD_HOST", "This address isn't one this app answers to. Open it from the link it printed when it started.");
    }

    if (!hostOnlyHere(req) && isHostOnlyRequest(req)) {
      return refuse(res, 404, "NOT_FOUND", "Not found.");
    }

    if (!SAFE.has(req.method)) {
      const origins = new Set([...hosts].map((h) => `http://${h}`));
      const origin = req.headers.origin;
      if (origin !== undefined && !origins.has(String(origin).toLowerCase())) {
        return refuse(res, 403, "BAD_ORIGIN", "That request came from another website, so it was refused.");
      }
      const site = req.headers["sec-fetch-site"];
      if (site !== undefined && site !== "same-origin" && site !== "none") {
        return refuse(res, 403, "BAD_ORIGIN", "That request came from another website, so it was refused.");
      }
      if (req.method === "OPTIONS") return res.sendStatus(405); // no preflight is ever approved
    }
    next();
  };
}
