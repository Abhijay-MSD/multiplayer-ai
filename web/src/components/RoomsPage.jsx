import { useEffect, useId, useRef, useState } from "react";
import styles from "./Admin.module.css";
import rooms from "./Rooms.module.css";
import { LiveSignal } from "./LiveSignal";
import { FailureScreen } from "./FailureScreen";
import { describeFailure } from "../lib/failures";
import { archiveRoom, deleteRoom, listRooms, renameRoom } from "../lib/adminApi";

const STATE_TEXT = { open: "Open", ended: "Ended", archived: "Archived" };
const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const DELETE_PHRASE = "delete room";

// One room in the list: its title as a link, what is known about it, and the things the host can do to it.
function RoomRow({ room, onChange, setNote }) {
  const [mode, setMode] = useState(null); // null | "rename" | "delete"
  const [title, setTitle] = useState(room.title);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const id = useId();
  const firstField = useRef(null);
  useEffect(() => {
    if (!mode) return undefined;
    firstField.current?.focus();
    const onKey = (e) => e.key === "Escape" && setMode(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  const run = async (fn, done) => {
    setBusy(true);
    setError(null);
    try {
      onChange((await fn()).rooms);
      setNote(done);
      setMode(null);
      setTyped("");
    } catch (err) {
      setError(err.message || "That didn't work.");
    }
    setBusy(false);
  };

  return (
    <li className={rooms.item} data-part="room-item" data-state={room.state}>
      <div className={rooms.head}>
        <a className={rooms.title} href={`/s/${room.id}`}>{room.title}</a>
        <span className={rooms.state} data-state={room.state}>{STATE_TEXT[room.state]}{room.archived_by_host ? " by you" : ""}</span>
      </div>
      <p className={rooms.meta}>
        Last activity {when(room.last_activity)} · {room.people} {room.people === 1 ? "person" : "people"}
        {room.agent_working ? " · the agent is replying" : ""}
      </p>
      <div className={rooms.actions}>
        <a className={rooms.action} href={`/s/${room.id}`} aria-label={`Open ${room.title}`}>Open</a>
        <button type="button" className={rooms.action} onClick={() => (setTitle(room.title), setError(null), setMode(mode === "rename" ? null : "rename"))} aria-label={`Rename ${room.title}`} aria-expanded={mode === "rename"}>Rename</button>
        <button type="button" className={rooms.action} disabled={busy} onClick={() => run(() => archiveRoom(room.id, room.state !== "archived"), room.state === "archived" ? `Unarchived ${room.title}.` : `Archived ${room.title}.`)} aria-label={`${room.state === "archived" ? "Unarchive" : "Archive"} ${room.title}`}>
          {room.state === "archived" ? "Unarchive" : "Archive"}
        </button>
        <button type="button" className={rooms.danger} onClick={() => (setTyped(""), setError(null), setMode(mode === "delete" ? null : "delete"))} aria-label={`Delete ${room.title}`} aria-expanded={mode === "delete"}>Delete</button>
      </div>

      {mode === "rename" && (
        <form className={rooms.form} onSubmit={(e) => (e.preventDefault(), run(() => renameRoom(room.id, title), `Renamed to ${title.trim()}.`))}>
          <label className={styles.label} htmlFor={`${id}-title`}>New title for {room.title}</label>
          <input ref={firstField} id={`${id}-title`} className={styles.field} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={400} autoComplete="off" />
          <div className={styles.actions}>
            <button type="submit" className={styles.button} disabled={busy || !title.trim()}>Save title</button>
            <button type="button" className={styles.buttonQuiet} onClick={() => setMode(null)}>Cancel</button>
          </div>
        </form>
      )}

      {mode === "delete" && (
        <form className={rooms.form} onSubmit={(e) => (e.preventDefault(), typed === DELETE_PHRASE && run(() => deleteRoom(room.id, typed), `Deleted ${room.title}.`))}>
          <p className={styles.text}>Deletes {room.title} with everything in it: its messages, the people in it, and its files. It can't be undone, and its share link stops working.</p>
          <label className={styles.label} htmlFor={`${id}-confirm`}>Type “{DELETE_PHRASE}” to confirm</label>
          <input ref={firstField} id={`${id}-confirm`} className={styles.field} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
          <div className={styles.actions}>
            <button type="submit" className={styles.buttonDanger} disabled={busy || typed !== DELETE_PHRASE}>Delete this room</button>
            <button type="button" className={styles.buttonQuiet} onClick={() => setMode(null)}>Keep it</button>
          </div>
        </form>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </li>
  );
}

// /rooms: the host's list of rooms on this computer. Answered only to the signed-in host on this computer's own address.
export default function RoomsPage() {
  const [list, setList] = useState(null);
  const [failure, setFailure] = useState(null);

  useEffect(() => {
    listRooms()
      .then((r) => setList(r.rooms))
      .catch((err) => setFailure(describeFailure(err)));
  }, []);

  if (failure) return <FailureScreen failure={failure} onRetry={() => window.location.reload()} />;
  if (!list) return null;
  return <RoomsView initial={list} />;
}

/** The page itself, given the rooms to start from (the QA pages give it a made-up list). */
export function RoomsView({ initial }) {
  const [list, setList] = useState(initial);
  const [note, setNote] = useState("");

  return (
    <div className={styles.wrap} data-part="rooms">
      <div className={styles.card}>
        <div className={styles.signal}>
          <LiveSignal state="idle" showLabel={false} />
        </div>
        <h1 className={styles.title}>Your rooms</h1>
        <p className={styles.subtitle}>
          Every room on this computer, the one with the latest activity first. Only you see this page. <a href="/new">Start a room</a> · <a href="/settings">Settings</a>
        </p>
        <div aria-live="polite">{note && <p className={styles.result} role="status">{note}</p>}</div>
        {list.length === 0 ? (
          <p className={styles.text} data-part="rooms-empty">No rooms yet. When you start one it will be listed here. <a href="/new">Start a room</a></p>
        ) : (
          <ul className={rooms.list}>
            {list.map((r) => (
              <RoomRow key={r.id} room={r} onChange={setList} setNote={setNote} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
