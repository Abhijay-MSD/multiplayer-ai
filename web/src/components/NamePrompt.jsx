import { useState } from "react";
import styles from "./NamePrompt.module.css";
import { LiveSignal } from "./LiveSignal";

// The join screen: one field, one button. Shown to anyone who opens a room
// link without access to it. `initialValue` is the name remembered in this
// browser, offered as a suggestion; nothing happens until they confirm.
export function NamePrompt({ onSubmit, initialValue = "", error = null, suggestion = null }) {
  const [value, setValue] = useState(initialValue);

  const submit = (e) => {
    e.preventDefault();
    if (value.trim()) onSubmit(value);
  };

  return (
    <div className={styles.wrap} data-part="name-prompt">
      <form className={styles.card} data-part="name-card" onSubmit={submit}>
        <div className={styles.signal}>
          <LiveSignal state="idle" showLabel={false} />
        </div>
        <h1 className={styles.title}>Enter the room</h1>
        <p className={styles.subtitle}>Your name is shown next to anything you send.</p>
        <input
          className={styles.input}
          data-part="name-field"
          aria-label="Your name"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Your name"
          autoFocus
          maxLength={40}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "name-error" : undefined}
        />
        {error && (
          <p id="name-error" className={styles.error} role="alert">
            {error}
          </p>
        )}
        {suggestion && (
          <button className={styles.suggestion} type="button" onClick={() => onSubmit(suggestion)}>
            Join as &ldquo;{suggestion}&rdquo;
          </button>
        )}
        <button className={styles.button} type="submit" disabled={!value.trim()}>
          Join session
        </button>
      </form>
    </div>
  );
}
