// Requests to take control, waiting for the host. Kept in memory: a request lives 5 minutes, and a
// restart simply drops the ones waiting (the people asking can ask again).
import crypto from "node:crypto";

export const REQUEST_TTL_MS = 5 * 60_000;

export function createControlRequests({ now = Date.now, ttlMs = REQUEST_TTL_MS } = {}) {
  const requests = new Map(); // id -> { id, sessionId, kind, name, to, createdAt, expiresAt }

  const alive = (r) => r.expiresAt > now();

  return {
    /**
     * Adds a request, or returns the one already waiting for the same thing.
     * kind "take": `name` wants control. kind "handoff": `name`, who has it, wants to give it to `to`.
     */
    add({ sessionId, kind, name, to = null }) {
      for (const r of requests.values()) {
        if (r.sessionId === sessionId && r.kind === kind && r.name === name && r.to === to && alive(r)) return { ...r, created: false };
      }
      const request = { id: crypto.randomBytes(9).toString("base64url"), sessionId, kind, name, to, createdAt: now(), expiresAt: now() + ttlMs };
      requests.set(request.id, request);
      return { ...request, created: true };
    },

    /** The requests still waiting in a room, oldest first. */
    list(sessionId) {
      return [...requests.values()].filter((r) => r.sessionId === sessionId && alive(r)).sort((a, b) => a.createdAt - b.createdAt).map((r) => ({ ...r }));
    },

    /** Removes and returns a waiting request, or null if it is gone, expired or belongs to another room. */
    take(sessionId, id) {
      const r = requests.get(id);
      if (!r || r.sessionId !== sessionId || !alive(r)) return null;
      requests.delete(id);
      return { ...r };
    },

    /** Removes every request made by, or naming, a person. */
    dropFor(sessionId, name) {
      for (const r of [...requests.values()]) if (r.sessionId === sessionId && (r.name === name || r.to === name)) requests.delete(r.id);
    },

    /** Removes and returns the requests that have run out of time. */
    expire() {
      const gone = [];
      for (const r of [...requests.values()]) {
        if (!alive(r)) {
          requests.delete(r.id);
          gone.push({ ...r });
        }
      }
      return gone;
    },

    clear() {
      requests.clear();
    }
  };
}

let current = null;
export const setControl = (control) => {
  current = control;
};
export const getControl = () => (current ??= createControlRequests());
