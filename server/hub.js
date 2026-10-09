// Live updates for the web app, delivered by the server instead of by the
// browser reading the database (so the browser holds no database credentials).
//
// How it works: while at least one person is connected to a room, the hub reads
// that room's rows (the session, its participants, and any events newer than
// the last one it saw) and pushes what changed to every connected subscriber.
// It reads on a timer, and immediately after any tool in this server writes to
// the room (nudge), so changes made through this server arrive after about one
// database round trip. The timer is the safety net: it also catches writes made
// by another process, such as an MCP client running its own copy of this server.
//
// A store that reports its own writes (SQLite, memory) makes the nudge automatic,
// and one that also notices another process's writes (SQLite) makes the timer a
// rare safety net (SAFETY_POLL_MS). The Supabase store reports nothing, so the
// timer keeps its short interval (POLL_MS).
//
// Messages pushed to a subscriber (type: data):
//   state        { session, participants }     once, right after connecting
//   event        a session_events row           in id order, never repeated
//   participant  a participant row (no secrets)
//   session      the session row
//   resync       the gap was too large: reload the room and reconnect
//   revoked      this subscriber's token stopped being valid: the stream ends
//   deleted      the room itself is gone (all rooms were deleted): the stream ends
import { tokenIsLive } from "./auth.js";
import { asStore, participantRoomFor } from "./store/index.js";
import { escapeForLog } from "./safe-text.js";

const POLL_MS = 3000;
const SAFETY_POLL_MS = 30_000;
const BACKFILL_LIMIT = 1000; // most events replayed to a reconnecting client
const POLL_EVENT_LIMIT = 500; // most new events read per tick

const SERVER_ONLY = ["token_hash", "token_expires_at", "token_revoked_at"];
const publicParticipant = (row) => {
  const out = { ...row };
  for (const k of SERVER_ONLY) delete out[k];
  return out;
};

class Room {
  constructor(hub, sessionId) {
    this.hub = hub;
    this.sessionId = sessionId;
    this.subs = new Set();
    this.lastEventId = null; // newest event id seen; null until the first read
    this.session = null; // JSON string of the last session row
    this.participants = new Map(); // name -> JSON string of the public row
    this.sessionRow = null; // the session row itself
    this.publicRows = new Map(); // name -> public participant row
    this.running = null;
    this.again = false;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.tick().catch(() => {}), this.hub.pollMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Reads the room once and pushes what changed. Calls made while a read is running collapse into one follow-up read. */
  tick() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.poll();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async poll() {
    const store = this.hub.store;
    const first = this.lastEventId === null;
    let sessionRow, rows, events;
    try {
      [sessionRow, rows, events] = await Promise.all([
        store.getSession(this.sessionId),
        store.listParticipants(this.sessionId, { columns: participantRoomFor(store) }),
        first
          ? store.listEvents(this.sessionId, { columns: "id", order: "desc", limit: 1 })
          : store.listEvents(this.sessionId, { afterId: this.lastEventId, order: "asc", limit: POLL_EVENT_LIMIT })
      ]);
    } catch (e) {
      console.error(`[multiplayer-ai] hub read failed for ${escapeForLog(this.sessionId)}: ${escapeForLog(e.message)}`);
      return;
    }

    // The room was there and now is not: every room was deleted. Tell the tabs, then let go of the room.
    if (!sessionRow && this.session !== null) {
      for (const sub of [...this.subs]) {
        sub.send("deleted", {});
        this.hub.close(this.sessionId, sub);
        sub.end?.();
      }
      return;
    }

    // The session row. (The first read only records what is there.)
    if (sessionRow) {
      const json = JSON.stringify(sessionRow);
      if (json !== this.session) {
        this.session = json;
        this.sessionRow = sessionRow;
        if (!first) this.broadcast("session", sessionRow);
      }
    }

    // Participants: push the rows that changed.
    for (const row of rows) {
      const pub = publicParticipant(row);
      const json = JSON.stringify(pub);
      if (this.participants.get(row.name) !== json) {
        this.participants.set(row.name, json);
        this.publicRows.set(row.name, pub);
        if (!first) this.broadcast("participant", pub);
      }
    }

    // Events.
    if (first) {
      this.lastEventId = events[0]?.id ?? 0;
    } else {
      for (const e of events) {
        this.lastEventId = e.id;
        this.broadcast("event", e);
      }
      if (events.length === POLL_EVENT_LIMIT) this.again = true;
    }

    // Anyone whose token stopped working is cut off now, not at the next reconnect.
    for (const sub of [...this.subs]) {
      const mine = rows.find((r) => r.token_hash === sub.tokenHash);
      if (!mine || !tokenIsLive(mine)) {
        sub.send("revoked", {});
        this.hub.close(this.sessionId, sub);
        sub.end?.();
      }
    }
  }

  broadcast(type, data) {
    for (const sub of this.subs) this.deliver(sub, type, data);
  }

  // One subscriber never sees an event twice or out of order, even when it
  // connected in the middle of a read.
  deliver(sub, type, data) {
    if (!sub.ready) {
      sub.queue.push([type, data]);
      return;
    }
    if (type === "event") {
      if (data.id <= sub.sentThrough) return;
      sub.sentThrough = data.id;
    }
    sub.send(type, data);
  }
}

export function createHub({ db, pollMs } = {}) {
  const store = asStore(db);
  pollMs ??= store.notifies ? SAFETY_POLL_MS : POLL_MS;
  const rooms = new Map();
  // The store reports writes (its own, and another process's when it can tell):
  // read the room now. A null room means "something changed, I can't say where".
  const unsubscribe = store.notifies
    ? store.subscribe(({ sessionId }) => {
        if (sessionId) rooms.get(sessionId)?.tick().catch(() => {});
        else for (const room of rooms.values()) room.tick().catch(() => {});
      })
    : null;
  const hub = {
    db,
    store,
    pollMs,
    dispose: () => unsubscribe?.(),

    /**
     * Connects a subscriber: { tokenHash, send(type, data), end() }.
     * `after` is the newest event id the client already has.
     */
    async open(sessionId, sub, after = 0) {
      let room = rooms.get(sessionId);
      if (!room) {
        room = new Room(hub, sessionId);
        rooms.set(sessionId, room);
        room.start();
      }
      sub.ready = false;
      sub.queue = [];
      sub.sentThrough = after;
      room.subs.add(sub);
      try {
        await room.tick(); // bring the room up to date before replaying anything
        if (!room.subs.has(sub)) return; // revoked or closed while connecting

        const data = await store.listEvents(sessionId, {
          afterId: after,
          uptoId: room.lastEventId,
          order: "asc",
          limit: BACKFILL_LIMIT
        });

        sub.send("state", { session: room.sessionRow, participants: [...room.publicRows.values()] });
        const replay = data;
        if (replay.length === BACKFILL_LIMIT) {
          sub.send("resync", {}); // too far behind to replay: the client reloads the room
        } else {
          for (const e of replay) {
            if (e.id > sub.sentThrough) {
              sub.sentThrough = e.id;
              sub.send("event", e);
            }
          }
        }
        // Whatever the room pushed while this was connecting, minus what the replay already covered.
        sub.ready = true;
        for (const [type, payload] of sub.queue.splice(0)) room.deliver(sub, type, payload);
      } catch (e) {
        hub.close(sessionId, sub);
        throw e;
      }
    },

    close(sessionId, sub) {
      const room = rooms.get(sessionId);
      if (!room) return;
      room.subs.delete(sub);
      if (room.subs.size === 0) {
        room.stop();
        rooms.delete(sessionId);
      }
    },

    /** A tool in this server just wrote to the room: read it now instead of waiting for the timer. */
    nudge(sessionId) {
      rooms.get(sessionId)?.tick().catch(() => {});
    },

    stats: () => ({ rooms: rooms.size, subscribers: [...rooms.values()].reduce((n, r) => n + r.subs.size, 0) })
  };
  return hub;
}

// The server entry point installs the real hub; tests and tools that run
// without one get a harmless no-op.
let current = null;
export const setHub = (hub) => {
  current = hub;
};
export const nudge = (sessionId) => current?.nudge(sessionId);

