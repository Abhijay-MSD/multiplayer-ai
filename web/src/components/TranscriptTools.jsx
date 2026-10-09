import { useEffect, useRef, useState } from "react";
import styles from "./TranscriptTools.module.css";
import { transcriptFileName, transcriptMarkdown } from "../lib/exportMarkdown";
import { downloadText } from "../lib/outputs";

// The small row above the conversation: search it, and save it as a Markdown file. Search runs in this page on what it holds;
// the query is only ever compared with the text, never shown as markup. The file is made here in the browser from what is on
// screen; nothing is sent anywhere. (lib/exportMarkdown.js says how the text is made safe.)
export function TranscriptTools({ session, events, query, onQuery, matches }) {
  const [note, setNote] = useState("");
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const save = () => {
    const name = downloadText(transcriptFileName(session), transcriptMarkdown({ session, events }));
    setNote(`Saved ${name} in your downloads.`);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(""), 4000);
  };

  return (
    <div className={styles.tools} data-part="transcript-tools">
      <div className={styles.search} role="search">
        <label className={styles.label} htmlFor="transcript-search">Search the conversation</label>
        <input
          id="transcript-search"
          className={styles.field}
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && query && (e.preventDefault(), onQuery(""))}
          placeholder="Search the conversation"
          autoComplete="off"
          spellCheck={false}
          maxLength={200}
        />
        {query && (
          <button type="button" className={styles.button} onClick={() => onQuery("")}>
            Clear search
          </button>
        )}
      </div>
      <button type="button" className={styles.button} onClick={save}>
        Save conversation as Markdown
      </button>
      <span className={styles.note} role="status">
        {query ? (matches === 0 ? "No messages match." : `${matches} of ${events.length} ${events.length === 1 ? "message matches" : "messages match"}.`) : note}
      </span>
    </div>
  );
}
