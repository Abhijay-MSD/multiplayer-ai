import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, joinSession, heartbeat as heartbeatTool, leaveSession } from "../api";
import { openRoomStream } from "../lib/stream";
import { clearToken, getRememberedName, getToken, rememberName, saveToken } from "../lib/credentials";

const byId = (a, b) => a.id - b.id;

// The share link carries the room's invite secret after a "#", so it is never sent in a request line, a log or a
// Referer. It is read once here, sent in the body of the join request, and removed from the address bar afterwards.
const INVITE = /^#k=([A-Za-z0-9_-]{16,100})$/;
const readInvite = () => {
  try {
    return INVITE.exec(window.location.hash)?.[1] ?? null;
  } catch {
    return null;
  }
};
const forgetInvite = () => {
  try {
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  } catch {
    // an address bar that can't be changed keeps the link; nothing else depends on it
  }
};

export function useSession(sessionId) {
  // The name stored in this browser is only a suggestion that prefills the
  // prompt. Nobody joins a room under it until they confirm it for that room
  // (`joinName`). A token for the room is what lets someone resume without asking.
  const [suggestedName, setSuggestedName] = useState(getRememberedName);
  const [joinName, setJoinName] = useState(null);
  const [token, setToken] = useState(() => getToken(sessionId));
  const [you, setYou] = useState(null); // who the server says we are: { name, role }
  const [session, setSession] = useState(null);
  const [events, setEvents] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null); // the failed call: an ApiError with a code, or null
  const [room, setRoom] = useState({ state: "open" }); // open | ended | archived, from the server
  const [nameError, setNameError] = useState(null); // { message, suggestion } when the name is taken
  const [reload, setReload] = useState(0); // bumped to join again (stream fell too far behind, or access was revoked)
  const [joinSeq, setJoinSeq] = useState(0); // bumped when a join completes, so the stream reopens from the new event id
  const [live, setLive] = useState(false);
  const lastEventId = useRef(0);
  const inviteRef = useRef(readInvite());

  const setName = useCallback((value) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    rememberName(trimmed);
    setSuggestedName(trimmed);
    setNameError(null);
    setJoinName(trimmed);
  }, []);

  // Without a token for this room, the person confirms a name first.
  const needsName = !token && !joinName;

  // Join (or come back) on load. This is also the initial fetch of the full
  // transcript, per join_session's contract (PRD §11). The token, when we have
  // one, is what identifies us; a confirmed name is only used to join as someone new.
  useEffect(() => {
    if (needsName) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setError(null);

    joinSession({ session_id: sessionId, name: joinName ?? undefined, token: getToken(sessionId) ?? undefined, invite: inviteRef.current ?? undefined })
      .then((res) => {
        if (cancelled) return;
        if (inviteRef.current) {
          inviteRef.current = null;
          forgetInvite();
        }
        if (res.token) {
          saveToken(sessionId, res.token);
          setToken(res.token);
        }
        setYou(res.you);
        setRoom(res.room ?? { state: "open" });
        setSession(res.session);
        setParticipants(res.participants ?? []);
        const sorted = (res.events ?? []).slice().sort(byId);
        lastEventId.current = sorted.at(-1)?.id ?? 0;
        setEvents(sorted);
        setNameError(null);
        setLoading(false);
        setJoinSeq((n) => n + 1);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.code === "NAME_TAKEN") {
          // Someone in the room already has this name. Ask for another.
          clearToken(sessionId);
          setToken(null);
          setJoinName(null);
          setNameError({ message: err.message, suggestion: err.suggestion });
        } else if (err.code === "INVALID_NAME" && !joinName) {
          // A stored token that no longer works, and no name to join with: ask.
          clearToken(sessionId);
          setToken(null);
          setNameError({ message: "Your access to this room has ended. Confirm your name to join again." });
        } else {
          setError(err);
        }
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, joinName, needsName, reload]);

  // Try the join again after a failure (the server was down, or rate limiting has passed).
  const retry = useCallback(() => {
    setError(null);
    setLoading(true);
    setReload((n) => n + 1);
  }, []);

  // Live sync: the server pushes changes over a stream authenticated by the
  // token. It resumes from the newest event we have, so a dropped connection
  // loses nothing.
  const joined = Boolean(you && token);
  useEffect(() => {
    if (!joined) return;
    const stream = openRoomStream({
      sessionId,
      token,
      after: lastEventId.current,
      onStatus: (s) => setLive(s === "live"),
      onMessage: ({ type, data }) => {
        if (type === "state") {
          setSession(data.session);
          setParticipants(data.participants ?? []);
        } else if (type === "event") {
          lastEventId.current = Math.max(lastEventId.current, data.id);
          setEvents((prev) => (prev.some((e) => e.id === data.id) ? prev : [...prev, data].sort(byId)));
        } else if (type === "participant") {
          setParticipants((prev) => [...prev.filter((p) => p.name !== data.name), data]);
        } else if (type === "session") {
          setSession(data);
        }
      },
      // Too far behind to replay: load the room again from scratch.
      onResync: () => setReload((n) => n + 1),
      // Every room was deleted from the host's computer: say so, plainly, and keep nothing.
      onDeleted: () => {
        clearToken(sessionId); // forget it in this browser; the token state stays so the name prompt is not shown instead
        setYou(null); // stops the stream and the heartbeat
        setError(new ApiError("The rooms were deleted.", { code: "ROOM_DELETED" }));
      },
      // The token stopped working (revoked or expired): forget it and ask who
      // they are again. Nobody is rejoined without confirming.
      onDenied: () => {
        clearToken(sessionId);
        setToken(null);
        setYou(null);
        setJoinName(null);
        setNameError({ message: "Your access to this room ended. Confirm your name to join again." });
      }
    });
    return () => {
      stream.close();
      setLive(false);
    };
  }, [sessionId, joined, token, joinSeq]);

  // Presence heartbeat — PRD §12: every ~20 seconds while the tab is visible.
  // A hidden tab just stops heartbeating and drifts to "Away" through the normal
  // 60s timeout. Only pagehide (tab close / navigation) sends an explicit leave.
  // On becoming visible again: immediate heartbeat (useNow recomputes presence
  // on the same visibilitychange).
  useEffect(() => {
    if (!joined) return;
    const beat = () => heartbeatTool({ session_id: sessionId, token }).catch(() => {});

    let id = null;
    const start = () => {
      if (id === null) id = setInterval(beat, 20_000);
    };
    const stop = () => {
      clearInterval(id);
      id = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        beat();
        start();
      }
    };
    const onPageHide = () => {
      stop();
      leaveSession({ session_id: sessionId, token });
    };

    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [sessionId, joined, token]);

  return {
    name: you?.name ?? joinName ?? "",
    suggestedName,
    sharing: Boolean(room?.sharing),
    token,
    setName,
    needsName,
    nameError,
    session,
    events,
    participants,
    room,
    loading,
    error,
    retry,
    live
  };
}
