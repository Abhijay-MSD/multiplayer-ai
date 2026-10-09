import styles from "./Marketing.module.css";
import recording from "./recorded-session.json";
import { useReplay } from "./useReplay";
import { SessionRoomView } from "../components/SessionRoomView";
import { useMediaQuery } from "../hooks/useMediaQuery";

const recorded = recording.source === "recorded";

// The hero: the real room component, read-only, replaying a session that was
// recorded from the app (scripts/export-session.mjs). If the file is not a
// recording, the caption says so instead of claiming it is.
export function ReplayRoom() {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const r = useReplay(recording, { reducedMotion: reduced });

  return (
    <figure className={styles.replay}>
      <div className={styles.frame} role="region" aria-label="A recorded session, replayed. Read only.">
        <SessionRoomView
          readOnly
          embedded
          sessionId="recorded"
          name=""
          session={r.session}
          events={r.events}
          participants={r.participants}
          signalState={r.signalState}
          working={r.working}
        />
      </div>
      <figcaption className={styles.caption}>
        <span>
          {recorded
            ? "A real session, recorded from the app and replayed here. Read only."
            : "Placeholder transcript. It has not been recorded from the app yet."}
        </span>
        {!reduced && (
          <button type="button" className={styles.textButton} onClick={r.restart}>
            Replay
          </button>
        )}
      </figcaption>
    </figure>
  );
}
