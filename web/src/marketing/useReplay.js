import { useEffect, useMemo, useRef, useState } from "react";

// Replays a recorded session at a watchable pace. The recording keeps real
// timestamps; real gaps (an agent reply can take many seconds) are squeezed
// into a range that reads well on a page. While an agent reply is pending the
// room shows the working signal, the same way the live room does.

const GAP_MIN = 900;
const GAP_MAX = 2600;
const WORK_MIN = 1600;
const WORK_MAX = 3200;
const HOLD_END = 7000;
const PRESENCE_REFRESH_MS = 15_000;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// One step per event: how long to wait, whether the agent is "working" while
// waiting, then reveal the event.
function buildSteps(events) {
  return events.map((e, i) => {
    const prev = events[i - 1];
    const gap = prev ? new Date(e.created_at) - new Date(prev.created_at) : 0;
    const pending = e.kind === "agent_message" && prev && prev.kind !== "agent_message";
    return {
      wait: i === 0 ? 700 : pending ? clamp(gap / 3, WORK_MIN, WORK_MAX) : clamp(gap / 8, GAP_MIN, GAP_MAX),
      working: Boolean(pending)
    };
  });
}

// The creator starts as controller; a takeover event moves the role.
function rolesAt(recording, events) {
  const names = [];
  let controller = null;
  for (const e of events) {
    if (e.kind === "join" && !names.includes(e.author)) {
      names.push(e.author);
      if (controller === null) controller = e.author;
    }
    if (e.kind === "takeover") controller = e.author;
  }
  return { names, controller };
}

export function useReplay(recording, { reducedMotion = false } = {}) {
  const all = recording.events;
  const steps = useMemo(() => buildSteps(all), [all]);
  const [shown, setShown] = useState(reducedMotion ? all.length : 0);
  const [working, setWorking] = useState(false);
  const [run, setRun] = useState(0); // bump to restart
  const [tick, setTick] = useState(0);
  const timer = useRef(null);

  useEffect(() => {
    if (reducedMotion) {
      setShown(all.length);
      setWorking(false);
      return;
    }
    let cancelled = false;
    let i = 0;
    setShown(0);
    setWorking(false);

    const next = () => {
      if (cancelled) return;
      if (i >= steps.length) {
        timer.current = setTimeout(() => !cancelled && setRun((r) => r + 1), HOLD_END);
        return;
      }
      const step = steps[i];
      setWorking(step.working);
      timer.current = setTimeout(() => {
        if (cancelled) return;
        i += 1;
        setShown(i);
        setWorking(false);
        next();
      }, step.wait);
    };
    next();
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
    };
  }, [steps, all.length, reducedMotion, run]);

  // Everyone replayed is "here", so presence never drifts to Away mid-loop.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), PRESENCE_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  return useMemo(() => {
    const events = all.slice(0, shown);
    const { names, controller } = rolesAt(recording, events);
    const seen = new Date().toISOString();
    const participants = names.map((name) => ({
      name,
      role: name === controller ? "controller" : "watcher",
      last_seen: seen
    }));
    return {
      events,
      participants,
      working,
      signalState: working ? "working" : "idle",
      session: { ...recording.session, agent_working: working },
      restart: () => setRun((r) => r + 1),
      finished: shown >= all.length
    };
    // tick refreshes last_seen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, shown, working, recording, tick]);
}
