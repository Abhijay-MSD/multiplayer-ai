import { useLayoutEffect, useRef, useState } from "react";
import styles from "./SharePanel.module.css";

// Anything that is open on top of the room and answers Escape itself: another dialog (the host controls, the appearance popup), the
// file viewer and its history, the people drawer on a phone. While one is open, Escape is for it and this panel stays.
const OWN_ESCAPE = '[role="dialog"]:not([data-part="share-panel"]), [data-part="file-viewer"], [data-part="file-history"], [data-part="scrim"]';

// True when this Escape is not for the share panel: a text composition being cancelled, a search box with words in it (Escape clears
// them), or one of the layers above. Looked at as the key goes down, before any of them has reacted and left the page.
function escapeIsForSomethingElse(e) {
  if (e.isComposing || e.keyCode === 229) return true;
  if (e.target instanceof HTMLInputElement && e.target.type === "search" && e.target.value) return true;
  return Boolean(document.querySelector(OWN_ESCAPE));
}

// Shown once, right after a room is created: the link, with a copy button.
// It floats over the room so nothing in the room moves, and it closes with
// "Done" or Escape. The header's Copy link button stays after this is gone.
//
// Escape works wherever the focus is: the listener is on the window, in the capture phase, and it never stops the key, so the
// field or dialog that wants Escape still gets it. It is attached before the panel is first drawn (a layout effect), so a panel
// that can be seen can be closed, and the focus moves to Copy link in the same step. That happens once: the parent builds
// onClose anew on every render, so it is read through a ref, or each render would pull the focus back from wherever the person put it.
export function SharePanel({ url, onClose, share = null }) {
  const [copied, setCopied] = useState(false);
  const copyRef = useRef(null);
  const fieldRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    copyRef.current?.focus();
    const onKey = (e) => {
      if (e.key !== "Escape" || escapeIsForSomethingElse(e)) return;
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

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
