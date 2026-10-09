import styles from "./RoomDetails.module.css";

// The room's title and task, shown in the side rail by themes whose header is
// slim. Themes that keep the title in the header hide this block.
export function RoomDetails({ session }) {
  return (
    <section className={styles.details} data-part="room-details" aria-label="Room details">
      <div className={styles.heading}>This room</div>
      <div className={styles.title}>{session?.title}</div>
      <p className={styles.task}>{session?.task}</p>
    </section>
  );
}
