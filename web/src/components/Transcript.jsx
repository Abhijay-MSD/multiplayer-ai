import { useEffect, useRef } from "react";
import styles from "./Transcript.module.css";
import { TranscriptEntry } from "./TranscriptEntry";

const NEAR_BOTTOM_PX = 120;

// PRD 21: the center region, "the stage." Auto-scrolls for new events,
// but only when the reader is already near the bottom, so scrolling back
// through history isn't interrupted by live updates.
// `continueFor` is the id of the status line that gets a Continue button, and `onContinue` what the button does; both are null for
// everyone but the controller.
export function Transcript({ events, lookup = events, identityMap, roleByName, working, searching = false, continueFor = null, onContinue = null }) {
  const containerRef = useRef(null);
  const wasNearBottom = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (el && wasNearBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [events.length, working]);

  // When the stage changes size (a theme switch, a font arriving, the window
  // resizing) a reader who was at the end stays at the end.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (wasNearBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [events.length === 0]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    wasNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };

  const byId = new Map(lookup.map((e) => [e.id, e]));

  if (events.length === 0 && searching) {
    return (
      <div className={styles.transcript} data-part="transcript" role="region" aria-label="Transcript">
        <div className={styles.inner} data-part="transcript-inner">
          <p className={styles.empty} data-part="empty">
            <span className={styles.emptyTitle} data-part="empty-title">No messages match.</span>{" "}
            <span>Try other words, or clear the search.</span>
          </p>
        </div>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className={styles.transcript} data-part="transcript" role="region" aria-label="Transcript">
        <div className={styles.inner} data-part="transcript-inner">
          <p className={styles.empty} data-part="empty">
            <span className={styles.emptyTitle} data-part="empty-title">Nothing here yet.</span>{" "}
            <span>The controller can message the agent below; everyone can comment.</span>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={styles.transcript}
      data-part="transcript"
      ref={containerRef}
      onScroll={handleScroll}
      tabIndex={0}
      role="region"
      aria-label="Transcript"
    >
      <div className={styles.inner} data-part="transcript-inner">
        {events.map((event) => (
          <TranscriptEntry
            key={event.id}
            event={event}
            identityColor={identityMap[event.author]}
            role={roleByName[event.author]}
            replyTarget={event.reply_to ? byId.get(event.reply_to) : undefined}
            onContinue={onContinue && event.id === continueFor ? onContinue : null}
          />
        ))}
        {working && <div className={styles.working} data-part="working-line">Agent is working…</div>}
      </div>
    </div>
  );
}
