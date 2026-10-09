import { useEffect, useRef, useState } from "react";
import styles from "./Transcript.module.css";
import { copyText } from "../lib/outputs";

// A quiet Copy on a message: puts the message's own text on the clipboard (for the agent's reply, the Markdown it wrote). It
// never runs or renders anything.
export function CopyMessage({ author, text }) {
  const [state, setState] = useState(null); // "copied" | "failed"
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    setState((await copyText(text)) ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(null), 2000);
  };
  return (
    <>
      <button type="button" className={styles.copy} data-part="copy-message" aria-label={`Copy message from ${author}`} onClick={copy}>
        {state === "copied" ? "Copied" : "Copy"}
      </button>
      <span className={styles.srOnly} role="status">{state === "copied" ? "Copied to the clipboard." : state === "failed" ? "Couldn't copy. Select the text and copy it yourself." : ""}</span>
    </>
  );
}
