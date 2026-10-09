import { useEffect, useRef, useState } from "react";
import styles from "./SharePanel.module.css";

// Shown once, right after a room is created: the link, with a copy button.
// It floats over the room so nothing in the room moves, and it closes with
// "Done" or Escape. The header's Copy link button stays after this is gone.
export function SharePanel({ url, onClose, share = null }) {
  const [copied, setCopied] = useState(false);
  const copyRef = useRef(null);
  const fieldRef = useRef(null);

  useEffect(() => {
    copyRef.current?.focus();
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(share?.link ?? url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard access: select the link so it can be copied by hand.
      fieldRef.current?.select();
    }
  };

  return (
    <section className={styles.panel} role="dialog" aria-modal="false" aria-labelledby="share-title" data-part="share-panel">
      <h2 id="share-title" className={styles.title}>
        Share this link
      </h2>
      <p className={styles.text}>
        {share?.sharing
          ? "Send it to the people you want in this room. They open it, type a name and join. They can read and comment; to steer the agent they ask you, and you approve."
          : "Send it to the people you want in this room. They open it, type a name and join. Anyone who has the link can join."}
      </p>
      <div className={styles.row}>
        <input
          ref={fieldRef}
          className={styles.field}
          value={share?.link ?? url}
          readOnly
          aria-label="Room link"
          onFocus={(e) => e.target.select()}
        />
        <button ref={copyRef} type="button" className={styles.copy} onClick={copy}>
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      {share?.qr_svg && (
        <img
          src={`data:image/svg+xml;utf8,${encodeURIComponent(share.qr_svg)}`}
          alt="QR code for the link. A phone camera can scan it."
          style={{ alignSelf: "flex-start", width: "min(200px, 100%)", height: "auto", background: "#ffffff", border: "1px solid var(--border)" }}
        />
      )}
      {share && <p className={styles.text}>{share.note}</p>}
      {share?.warning && <p className={styles.text}>{share.warning}</p>}
      <button type="button" className={styles.done} onClick={onClose}>
        Done
      </button>
    </section>
  );
}
