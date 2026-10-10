import { useEffect, useId, useRef, useState } from "react";
import styles from "./Transcript.module.css";
import { secondsLeft } from "../lib/continue";

// "Continue", on the line that says a reply reached its length limit or that the provider is limiting the key. Only the controller is
// given `onContinue`. It sends a message like any other, so if the server refuses (the controller changed, a limit was reached) its
// own words are shown.
//
// With `waitSeconds` (the provider's own wait, counted from `writtenAt`) the button waits it out. While it waits it is aria-disabled,
// not disabled, so the keyboard can still reach it and a screen reader can say why; the seconds on screen are hidden from a screen
// reader, which is told the wait once, in words, and told again when it is over, so it never reads out every second.
export function ContinueButton({ onContinue, waitSeconds = null, writtenAt = null }) {
  const describedBy = useId();
  const [now, setNow] = useState(() => Date.now());
  const left = secondsLeft(waitSeconds, writtenAt, now);
  const waiting = left > 0;
  const [firstWait] = useState(left); // what the description says, so it does not change as the seconds do
  const waited = useRef(false);
  const [told, setTold] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!waiting) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [waiting]);

  useEffect(() => {
    if (waiting) waited.current = true;
    else if (waited.current) setTold("You can continue now.");
  }, [waiting]);

  const press = async () => {
    if (waiting || sending) return;
    setSending(true);
    setError(null);
    try {
      await onContinue();
    } catch (err) {
      setError(err.message || "Couldn't send that.");
    }
    setSending(false);
  };

  return (
    <>
      <button
        type="button"
        className={`${styles.continueButton} ${waiting ? styles.continueWaiting : ""}`}
        data-part="continue"
        aria-disabled={waiting || sending ? "true" : undefined}
        aria-describedby={waiting ? describedBy : undefined}
        onClick={press}
        title="Sends “Continue from where you stopped” to the agent, as a message."
      >
        {sending ? "Sending…" : "Continue"}
      </button>
      {waiting && (
        <>
          <span className={styles.continueCountdown} data-part="continue-countdown" aria-hidden="true">{left}</span>
          <span className={styles.continueBar} data-part="continue-bar" aria-hidden="true">
            <span style={{ width: `${Math.min(100, (left / Math.max(1, waitSeconds)) * 100)}%` }} />
          </span>
        </>
      )}
      <span id={describedBy} className={styles.srOnly}>{waiting ? `Available in about ${firstWait} ${firstWait === 1 ? "second" : "seconds"}.` : ""}</span>
      <span className={styles.srOnly} aria-live="polite">{told}</span>
      {error && <span className={styles.continueError} role="alert">{error}</span>}
    </>
  );
}
