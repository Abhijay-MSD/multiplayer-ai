import styles from "./StatusScreen.module.css";

// Full-screen status: entering the room, or a session that cannot be reached.
// Says what happened and what to do next.
export function StatusScreen({ title, children, tone = "neutral" }) {
  return (
    <div className={styles.screen} data-part="status-screen" data-tone={tone}>
      <div role={tone === "error" ? "alert" : "status"}>
        {title && <div className={styles.title}>{title}</div>}
        {children}
      </div>
    </div>
  );
}
