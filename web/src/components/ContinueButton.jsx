import { useState } from "react";
import styles from "./Transcript.module.css";

// "Continue", on the line that says a reply reached its length limit. Only the controller is given `onContinue`. It sends a
// message like any other, so if the server refuses (the controller changed, a limit was reached) its own words are shown.
export function ContinueButton({ onContinue }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const press = async () => {
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
      <button type="button" className={styles.continueButton} data-part="continue" onClick={press} disabled={sending} title="Sends “Continue from where you stopped” to the agent, as a message.">
        {sending ? "Sending…" : "Continue"}
      </button>
      {error && <span className={styles.continueError} role="alert">{error}</span>}
    </>
  );
}
