import { useEffect, useRef, useState } from "react";
import { SessionRoomView } from "./SessionRoomView";
import { StatusScreen } from "./StatusScreen";
import { FailureScreen } from "./FailureScreen";
import { SharePanel } from "./SharePanel";
import { describeFailure } from "../lib/failures";
import { NamePrompt } from "./NamePrompt";
import { useSession } from "../hooks/useSession";
import { sendDirective, sendComment, takeControl, stopAgent, retryLast, getConfig, listRoomFiles, getRoomFile, fileVersions, attachFile } from "../api";
import { getRoomPanel, getStatus, deleteRoomFile, restoreRoomFile } from "../lib/adminApi";
import { HostPanel, HostPrompt } from "./HostPanel";

// Used until the server says what its cap is (and if it never does).
const DEFAULT_MAX_STEPS = Number(import.meta.env.VITE_MAX_STEPS_PER_SESSION) || 50;
// A reply can land in well under a second; keep the working state visible
// long enough to be seen (PRD 20.7).
const MIN_WORKING_MS = 800;

// The server owns "agent is working" (sessions.agent_working, via Realtime).
// "error" is read off the status event the server writes when a step fails.
function computeSignalState(session, events, working, maxSteps) {
  if (!session) return "idle";
  if (session.step_count >= maxSteps) return "limit";
  if (working) return "working";
  // Room chat shouldn't clear or set the agent's state.
  const last = [...events].reverse().find((e) => e.kind !== "comment");
  if (last?.kind === "status" && /^Agent (could not reply|stopped)/.test(last.content)) return "error";
  return "idle";
}

// true stays true for at least `minMs` after it first turned on.
function useMinHold(value, minMs) {
  const [held, setHeld] = useState(value);
  const since = useRef(value ? Date.now() : 0);
  useEffect(() => {
    if (value) {
      since.current = since.current || Date.now();
      setHeld(true);
      return;
    }
    const remaining = since.current ? minMs - (Date.now() - since.current) : 0;
    if (remaining <= 0) {
      since.current = 0;
      setHeld(false);
      return;
    }
    const id = setTimeout(() => {
      since.current = 0;
      setHeld(false);
    }, remaining);
    return () => clearTimeout(id);
  }, [value, minMs]);
  return held;
}

export function SessionRoom({ sessionId }) {
  const { name, suggestedName, token, setName, needsName, nameError, session, events, participants, room, loading, error, retry, sharing } = useSession(sessionId);
  const [busy, setBusy] = useState(false);
  const [filesLimits, setFilesLimits] = useState(null);
  const [handoffError, setHandoffError] = useState(null);
  const working = useMinHold(Boolean(session?.agent_working), MIN_WORKING_MS);
  const [maxSteps, setMaxSteps] = useState(DEFAULT_MAX_STEPS);
  useEffect(() => {
    let live = true;
    getConfig().then((config) => live && config && setMaxSteps(config.max_steps_per_session));
    return () => {
      live = false;
    };
  }, []);

  // Whether this browser is the host's (the sign-in cookie, on this computer's own address). Then the room's
  // host panel is available, and a request for control shows up as a prompt.
  const [isHost, setIsHost] = useState(false);
  useEffect(() => {
    let live = true;
    getStatus().then((s) => live && setIsHost(s?.host === true));
    return () => {
      live = false;
    };
  }, []);
  const [panel, setPanel] = useState(null);
  const [hostOpen, setHostOpen] = useState(false);
  const joined = !needsName && !loading && !error;
  useEffect(() => {
    if (!isHost || !joined) return undefined;
    let live = true;
    const load = () => document.visibilityState !== "hidden" && getRoomPanel(sessionId).then((p) => live && setPanel(p)).catch(() => {});
    load();
    const id = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [isHost, joined, sessionId]);

  // A guest who asked the host for control waits until they have it, are told no, or the request runs out.
  const [asked, setAsked] = useState(null);
  const me = participants.find((p) => p.name === name);
  const waiting = Boolean(asked) && me?.role !== "controller" && !events.some((e) => e.kind === "status" && e.id > asked.afterEvent && (e.content.includes(`said no to ${name}`) || e.content.includes(`${name}'s request`)));

  // Right after a room is created the person lands here with ?new=1: show the
  // share panel once, and drop the marker so a reload doesn't show it again.
  const [showShare, setShowShare] = useState(() => new URLSearchParams(window.location.search).get("new") === "1");
  useEffect(() => {
    if (showShare && window.location.search) window.history.replaceState(null, "", window.location.pathname);
  }, [showShare]);

  if (needsName) {
    return (
      <NamePrompt
        onSubmit={setName}
        initialValue={suggestedName}
        error={nameError?.message}
        suggestion={nameError?.suggestion}
      />
    );
  }

  if (loading) {
    return <StatusScreen>Entering the room…</StatusScreen>;
  }

  if (error) {
    return <FailureScreen failure={describeFailure(error)} onRetry={retry} />;
  }

  // Rejections (e.g. control changed a moment ago) throw from the server and
  // surface in the composer, which keeps the text.
  // Who is sending is decided by the token, not by a name in the request.
  const handleSendDirective = (content) => sendDirective({ session_id: sessionId, token, content });
  const handleSendComment = (content) => sendComment({ session_id: sessionId, token, content });

  const handleTakeControl = async (targetName) => {
    setBusy(true);
    setHandoffError(null);
    try {
      // Your own name means "take it for myself"; anyone else's is a handoff to them.
      const res = await takeControl({ session_id: sessionId, token, ...(targetName !== name ? { target: targetName } : {}) });
      if (res?.pending) setAsked({ afterEvent: events.reduce((m, e) => Math.max(m, e.id), 0) });
    } catch (err) {
      setHandoffError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // An ended or archived room can be read but not posted to. The server refuses
  // every write (410); this says so up front instead of offering a composer.
  const readOnly = room.state !== "open";
  const notice =
    room.state === "archived" && room.archived_by_host
      ? "The host archived this room. You can read it, but nothing new can be posted."
      : room.state === "archived"
      ? `This room was archived after ${room.archive_after_days} days without activity. You can read it, but nothing new can be posted.`
      : room.state === "ended"
        ? "This room has ended. You can read it, but nothing new can be posted."
        : null;

  // The room's files, when this copy has them (the local data file; the server leaves files_enabled off the room with Supabase storage).
  const hasFiles = typeof session?.files_enabled === "boolean";
  const filesView = hasFiles
    ? {
        isHost,
        canAttach: !readOnly && (me?.role === "controller" || Boolean(me?.is_host) || isHost),
        limits: filesLimits,
        load: async () => {
          const data = await listRoomFiles({ session_id: sessionId, token });
          setFilesLimits(data.limits);
          return data;
        },
        read: async (fileName, version) => (await getRoomFile({ session_id: sessionId, token, name: fileName, ...(version ? { version } : {}) })).file,
        versions: async (fileName) => (await fileVersions({ session_id: sessionId, token, name: fileName })).versions,
        attach: (fileName, content) => attachFile({ session_id: sessionId, token, name: fileName, content }),
        remove: (fileName) => deleteRoomFile(sessionId, fileName),
        restore: (fileName, version) => restoreRoomFile(sessionId, fileName, version)
      }
    : null;

  return (
    <>
      <SessionRoomView
        sessionId={sessionId}
        name={name}
        session={session}
        events={events}
        participants={participants}
        signalState={computeSignalState(session, events, working, maxSteps)}
        working={working}
        busy={busy}
        handoffError={handoffError}
        onSendDirective={handleSendDirective}
        onSendComment={handleSendComment}
        onTakeControl={handleTakeControl}
        readOnly={readOnly}
        notice={notice}
        control={{ shared: sharing, policy: session?.control_policy, iAmHost: Boolean(me?.is_host) || isHost, waiting }}
        shareLink={isHost ? panel?.share.link : sharing ? null : undefined}
        hostControls={isHost && panel ? { onOpen: () => setHostOpen(true), pending: panel.pending.length || undefined } : null}
        filesView={filesView}
        onRetry={!readOnly && me?.role === "controller" ? () => retryLast({ session_id: sessionId, token }) : null}
        onStop={!readOnly && (me?.role === "controller" || Boolean(me?.is_host) || isHost) ? () => stopAgent({ session_id: sessionId, token }) : null}
      />
      {showShare && !readOnly && (
        <SharePanel url={`${window.location.origin}/s/${sessionId}`} share={isHost ? panel?.share : null} onClose={() => setShowShare(false)} />
      )}
      {isHost && panel && hostOpen && <HostPanel sessionId={sessionId} panel={panel} onChange={setPanel} onClose={() => setHostOpen(false)} />}
      {isHost && panel && !hostOpen && <HostPrompt sessionId={sessionId} pending={panel.pending} onChange={setPanel} onOpen={() => setHostOpen(true)} />}
    </>
  );
}
