import styles from "./Outputs.module.css";
import { OutputActions, TOO_LARGE } from "./CodeBlock";
import { describeSize } from "../lib/outputs";
import { formatClock } from "../lib/time";

// The room's Outputs tab: every fenced block the agent wrote, newest first, as a short preview with Copy and Download.
// `outputs` is { items, total, shown } from extractOutputs; only the newest ones are listed.
export function OutputsPanel({ outputs }) {
  return (
    <section className={styles.panel} data-part="outputs" aria-label="Outputs">
      <p className={styles.intro}>The code and files the agent has written in this room, newest first. Copying or downloading one never runs it.</p>
      {outputs.total > outputs.shown && (
        <p className={styles.intro} data-part="outputs-note">
          Showing the newest {outputs.shown} of {outputs.total}.
        </p>
      )}
      <ul className={styles.list}>
        {outputs.items.map((o) => (
          <li key={o.key} className={styles.item} data-part="output-item">
            <div className={styles.toolbar}>
              <span className={styles.codeName}>{o.fileName}</span>
              <OutputActions fileName={o.fileName} text={o.text} tooLarge={o.tooLarge} />
            </div>
            <p className={styles.meta}>
              From {o.author} at {formatClock(o.createdAt)} · {describeSize(o.lines, o.chars)}
            </p>
            {o.tooLarge && <p className={styles.limit}>{TOO_LARGE}</p>}
            <pre className={styles.preview} tabIndex={0} aria-label={`Preview of ${o.fileName}`}>
              <code>{o.preview}</code>
            </pre>
          </li>
        ))}
      </ul>
    </section>
  );
}
