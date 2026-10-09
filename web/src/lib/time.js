import { useEffect, useState } from "react";

// Forces a re-render every `intervalMs` so time-relative UI (presence
// away-state, relative timestamps) stays accurate without a Realtime event.
// Also refreshes the moment the tab becomes visible: browsers throttle timers
// in hidden tabs, so without this a returning viewer sees stale presence.
export function useNow(intervalMs = 10_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);
  return now;
}

// PRD §12: away if not seen in ~60 seconds. Keep in sync with
// server/presence.js (the server enforces the same threshold on handoff).
export const AWAY_AFTER_MS = 60_000;
// Participants unseen this long are hidden from the rail (never deleted).
export const HIDE_AFTER_MS = 10 * 60_000;

export function isAway(lastSeen, now) {
  if (!lastSeen) return true;
  return now - new Date(lastSeen).getTime() > AWAY_AFTER_MS;
}

export function isStale(lastSeen, now) {
  if (!lastSeen) return true;
  return now - new Date(lastSeen).getTime() > HIDE_AFTER_MS;
}

export function formatClock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
