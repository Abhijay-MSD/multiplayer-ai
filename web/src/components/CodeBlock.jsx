import { useEffect, useRef, useState } from "react";
import styles from "./Outputs.module.css";
import { copyText, describeBlock, downloadText } from "../lib/outputs";

export const TOO_LARGE = "Too large to copy or download here (over 1,000,000 characters).";

/** The Copy and Download buttons for one piece of text. Nothing here opens, shows or runs the text. */
export function OutputActions({ fileName, text, tooLarge }) {
  const [state, setState] = useState(null); // "copied" | "failed"
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    setState((await copyText(text)) ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(null), 2000);
  };

  return (
    <span className={styles.actions} data-part="output-actions">
      <button type="button" className={styles.action} disabled={tooLarge} aria-label={state === "copied" ? "Copied" : `Copy ${fileName}`} onClick={copy}>
        {state === "copied" ? "Copied" : "Copy"}
      </button>
      <button type="button" className={styles.action} disabled={tooLarge} aria-label={`Download ${fileName}`} onClick={() => downloadText(fileName, text)}>
        Download
      </button>
      <span className={styles.status} role="status">
        {state === "copied" ? "Copied to the clipboard." : state === "failed" ? "Couldn't copy. Select the text and copy it yourself." : ""}
      </span>
    </span>
  );
}

// A fenced block in an agent reply, with its name and the buttons above it. `eventId` and `index` (this is the Nth
// fenced block of that reply) make the name the same one the Outputs tab shows.
export function CodeBlock({ text, info, eventId, index }) {
  const { fileName, tooLarge } = describeBlock(eventId, info, index, text);
  return (
    <div className={styles.codeBlock} data-part="code-block">
      <div className={styles.toolbar}>
        <span className={styles.codeName} data-part="code-name">{fileName}</span>
        {text.trim() !== "" && <OutputActions fileName={fileName} text={text} tooLarge={tooLarge} />}
      </div>
      {tooLarge && <p className={styles.limit} data-part="code-limit">{TOO_LARGE}</p>}
      <pre tabIndex={0}>
        <code>{text}</code>
      </pre>
    </div>
  );
}
