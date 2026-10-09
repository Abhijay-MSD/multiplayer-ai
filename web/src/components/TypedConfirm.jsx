import { useId, useState } from "react";
import styles from "./Admin.module.css";

// An action that can't be undone, behind a phrase the person types. The button stays off
// until the phrase matches exactly; the server checks it again.
export function TypedConfirm({ phrase, title, description, buttonLabel, onConfirm, disabledReason = null }) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { ok, message }

  const run = async (e) => {
    e.preventDefault();
    if (typed !== phrase || busy || disabledReason) return;
    setBusy(true);
    setResult(null);
    try {
      const message = await onConfirm(phrase);
      setResult({ ok: true, message });
      setTyped("");
    } catch (err) {
      setResult({ ok: false, message: err.message || "That didn't work." });
    }
    setBusy(false);
  };

  return (
    <form onSubmit={run} noValidate>
      <h3 className={styles.sectionTitle}>{title}</h3>
      <p className={styles.text}>{description}</p>
      <label className={styles.label} htmlFor={id}>
        Type “{phrase}” to confirm
      </label>
      <input id={id} className={styles.field} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} disabled={Boolean(disabledReason)} />
      {disabledReason && <p className={styles.text}>{disabledReason}</p>}
      <div className={styles.actions}>
        <button type="submit" className={styles.buttonDanger} disabled={typed !== phrase || busy || Boolean(disabledReason)}>
          {busy ? "Working…" : buttonLabel}
        </button>
      </div>
      <div aria-live="polite">
        {result && (
          <p className={result.ok ? styles.result : styles.error} role={result.ok ? "status" : "alert"} data-ok={result.ok}>
            {result.message}
          </p>
        )}
      </div>
    </form>
  );
}
