// Live room updates from the server (server/stream.js), read with fetch so the
// token goes in an Authorization header, not in a URL. It reconnects on its own
// and resumes from the newest event id it has seen, so nothing is missed or
// shown twice. If the server goes quiet it assumes the connection died.
import { API_BASE } from "../api";

const WATCHDOG_MS = 45_000; // the server pings every 15 to 25 seconds
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

/** Splits an event-stream body into { type, data, id } messages. Exported for tests. */
export function createParser(onMessage) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let type = "message";
      let id = null;
      const data = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":") || line === "") continue; // comments and pings
        const i = line.indexOf(":");
        const field = i === -1 ? line : line.slice(0, i);
        const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
        if (field === "event") type = value;
        else if (field === "data") data.push(value);
        else if (field === "id") id = value;
      }
      if (data.length) {
        try {
          onMessage({ type, id, data: JSON.parse(data.join("\n")) });
        } catch {
          /* a malformed message is skipped, not fatal */
        }
      }
    }
  };
}

/**
 * Opens the stream for one room and keeps it open.
 *   onMessage({ type, data })   state | event | participant | session
 *   onResync()                  too far behind: reload the room, then reconnect
 *   onDenied()                  the token no longer works: stop
 *   onDeleted()                 the room itself is gone (every room was deleted): stop
 *   onStatus("live" | "reconnecting")
 * Returns { close }.
 */
export function openRoomStream({ sessionId, token, after = 0, onMessage, onResync, onDenied, onDeleted, onStatus }) {
  let stopped = false;
  let lastId = after;
  let controller = null;

  const run = async () => {
    let attempt = 0;
    while (!stopped) {
      controller = new AbortController();
      let watchdog;
      const arm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => controller.abort(), WATCHDOG_MS);
      };
      try {
        arm();
        const res = await fetch(`${API_BASE}/api/stream/${sessionId}?after=${lastId}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
          cache: "no-store",
          signal: controller.signal
        });
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          if (!stopped) onDenied?.();
          return;
        }
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);

        attempt = 0;
        onStatus?.("live");
        let resync = false;
        const parse = createParser((m) => {
          if (m.type === "revoked") {
            stopped = true;
            onDenied?.();
          } else if (m.type === "deleted") {
            stopped = true;
            onDeleted?.();
          } else if (m.type === "resync") {
            resync = true;
          } else {
            if (m.type === "event") lastId = Math.max(lastId, m.data.id);
            onMessage?.(m);
          }
        });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          arm();
          parse(decoder.decode(value, { stream: true }));
          if (stopped || resync) break;
        }
        await reader.cancel().catch(() => {});
        if (resync && !stopped) {
          stopped = true;
          onResync?.();
          return;
        }
      } catch {
        /* dropped, aborted by the watchdog, or the server is down: retry below */
      } finally {
        clearTimeout(watchdog);
      }
      if (stopped) return;
      onStatus?.("reconnecting");
      const base = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)];
      await new Promise((r) => setTimeout(r, base * (0.75 + Math.random() * 0.5)));
    }
  };
  run();

  return {
    close() {
      stopped = true;
      controller?.abort();
    }
  };
}
