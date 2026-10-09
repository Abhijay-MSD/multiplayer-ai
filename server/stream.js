// GET /api/stream/:session_id?after=<event id>
//
// A Server-Sent Events response that the browser reads with fetch(), so the
// participant token travels in an Authorization header and never in a URL
// (URLs end up in logs, history and referrers). The hub (hub.js) decides what
// to send; this file authenticates, frames the messages and keeps the
// connection alive.
import { authenticate, hashToken } from "./auth.js";
import { ApiError, errorBody } from "./errors.js";
import { escapeForLog } from "./safe-text.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Proxies and load balancers drop idle connections after a while. A comment line
// every 15 to 25 seconds keeps this one open.
const DEFAULT_PING_MS = 20_000;
export const pingInterval = (value = process.env.STREAM_PING_MS) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(25_000, Math.max(15_000, n)) : DEFAULT_PING_MS;
};

export function streamRoute({ db, hub, pingMs = pingInterval() }) {
  return async function stream(req, res) {
    const { session_id } = req.params;
    try {
      if (!UUID.test(session_id)) throw new ApiError(404, "ROOM_NOT_FOUND", "That room doesn't exist.");
      const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
      const token = bearer?.[1];
      await authenticate(db, { session_id, token });

      const after = Math.max(0, parseInt(req.query.after ?? req.headers["last-event-id"] ?? "0", 10) || 0);

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no" // keep a reverse proxy from holding messages back
      });
      res.write("retry: 3000\n\n");

      let closed = false;
      const sub = {
        tokenHash: hashToken(token),
        send: (type, data) => {
          if (closed) return;
          const id = type === "event" ? `id: ${data.id}\n` : "";
          res.write(`${id}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        },
        end: () => {
          closed = true;
          clearInterval(ping);
          res.end();
        }
      };
      const ping = setInterval(() => !closed && res.write(": ping\n\n"), pingMs);
      ping.unref?.();
      req.on("close", () => {
        closed = true;
        clearInterval(ping);
        hub.close(session_id, sub);
      });

      await hub.open(session_id, sub, after).catch((e) => {
        console.error(`[multiplayer-ai] stream for ${escapeForLog(session_id)} failed: ${escapeForLog(e.message)}`);
        sub.send("resync", {});
        sub.end();
      });
    } catch (e) {
      if (res.headersSent) return res.end();
      const status = e instanceof ApiError ? e.status : 500;
      res.status(status).json(errorBody(e instanceof ApiError ? e : new Error("Something went wrong on the server.")));
    }
  };
}
