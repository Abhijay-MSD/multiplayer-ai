import { useId, useState } from "react";
import styles from "./RoomBrief.module.css";

const LONG = 160;

// The host's brief for the room, shown to everyone in it above the conversation: it is never tucked away. A long one is
// cut to a few lines, and "Show all" opens the rest. It is text only (a text node), whatever it says.
export function RoomBrief({ brief }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const text = String(brief ?? "").trim();
  if (!text) return null;
  const long = text.length > LONG || text.split("\n").length > 2;
  return (
    <section className={styles.brief} data-part="room-brief" aria-label="Brief from the host">
      <h2 className={styles.heading}>Brief from the host</h2>
      <p id={id} className={`${styles.text} ${long && !open ? styles.clamped : ""}`}>{text}</p>
      {long && (
        <button type="button" className={styles.toggle} aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </section>
  );
}
