import { StatusScreen } from "./StatusScreen";
import styles from "./FailureScreen.module.css";

// A call failed and the person needs to know what happened and what to do next.
// `failure` comes from describeFailure() in lib/failures.js.
export function FailureScreen({ failure, onRetry }) {
  return (
    <StatusScreen tone="error" title={failure.title}>
      <p className={styles.body}>{failure.body}</p>
      <div className={styles.actions}>
        {failure.action === "retry" && (
          <button type="button" className={styles.primary} onClick={onRetry}>
            Try again
          </button>
        )}
        {failure.action === "setup" && (
          <a className={styles.primary} href="/setup?next=/new">
            Set up a key
          </a>
        )}
        {failure.action === "start" && (
          <a className={styles.primary} href="/new">
            Start a room
          </a>
        )}
        <a className={styles.quiet} href="/">
          About Multiplayer AI
        </a>
      </div>
    </StatusScreen>
  );
}
