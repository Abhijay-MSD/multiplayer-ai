import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./Files.module.css";
import { copyText, downloadText } from "../lib/outputs";
import { createZip, downloadZip, zipEntryNames } from "../lib/zip";
import { describeBytes } from "../lib/files";
import { formatClock } from "../lib/time";

const who = (f) => (f.updated_by === "agent" && f.on_behalf_of ? `the agent, for ${f.on_behalf_of}` : f.updated_by === "agent" ? "the agent" : f.updated_by === "host" ? "the host" : f.updated_by);

// The room's Files tab: every text file in the room, with its size, version, who changed it and when. A file is shown
// as plain text only (a text node in a <pre>, never markup), and copied or downloaded as plain text. Everyone in the
// room can view and download; only the host sees History, Restore and Delete. `view` comes from SessionRoom (api calls
// and who this is); `changeKey` changes whenever the room does, so the list reloads when a file is written.
export function FilesPanel({ view, changeKey, agentCanUse }) {
  const [list, setList] = useState(null); // { files, usage, limits }
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null); // { name, version, content, size, updated_by, on_behalf_of, updated_at } being viewed
  const [history, setHistory] = useState(null); // { name, versions }
  const [confirm, setConfirm] = useState(null); // the name about to be deleted
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const headingRef = useRef(null);
  const viewRef = useRef(view); // the parent builds `view` anew on every render; the list reloads when the room changes, not then
  viewRef.current = view;

  // Escape closes the history or the viewer, whichever is open on top.
  useEffect(() => {
    if (!open && !history) return undefined;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (open) setOpen(null);
      else setHistory(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, history]);

  const load = useCallback(async () => {
    try {
      setList(await viewRef.current.load());
      setError(null);
    } catch (e) {
      setError(e.message || "Couldn't load the files.");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load, changeKey]);

  const show = async (name, version) => {
    setError(null);
    try {
      setOpen(await view.read(name, version));
    } catch (e) {
      setError(e.message || "Couldn't open that file.");
    }
  };
  const showHistory = async (name) => {
    setError(null);
    try {
      setHistory({ name, versions: await view.versions(name) });
    } catch (e) {
      setError(e.message || "Couldn't load the history.");
    }
  };
  const act = async (fn, done) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setNote(done);
      setHistory(null);
      setConfirm(null);
      setOpen(null);
      await load();
    } catch (e) {
      setError(e.message || "That didn't work.");
    }
    setBusy(false);
  };
  const copy = async (file) => setNote((await copyText(file.content)) ? `Copied ${file.name}.` : "Couldn't copy. Select the text and copy it yourself.");
  const download = (file) => {
    downloadText(file.name, file.content);
    setNote(`Downloaded ${file.name} as plain text.`);
  };

  // Every file in the room, in one zip made here: each file is fetched the usual way (with the person's token, by POST) and the
  // archive is built in the browser. Names inside are cleaned, and nothing in it is run.
  const downloadAll = async () => {
    setBusy(true);
    setError(null);
    try {
      const all = await Promise.all((list?.files ?? []).map((f) => view.read(f.name)));
      const names = zipEntryNames(all.map((f) => f.name));
      const bytes = createZip(all.map((f, i) => ({ name: names[i], data: new TextEncoder().encode(f.content), date: new Date(f.updated_at) })));
      downloadZip(`multiplayer-ai-files-${new Date().toISOString().slice(0, 10)}.zip`, bytes);
      setNote(`Downloaded ${all.length} ${all.length === 1 ? "file" : "files"} as a zip.`);
    } catch (e) {
      setError(e.message || "Couldn't make the zip.");
    }
    setBusy(false);
  };

  const files = list?.files ?? [];
  return (
    <section className={styles.panel} data-part="files" aria-label="Files">
      <h2 className={styles.heading} ref={headingRef} tabIndex={-1}>Files in this room</h2>
      <p className={styles.intro}>
        Text files the agent and the people in this room have saved. They are shown as plain text and are never run.{" "}
        {agentCanUse ? "The agent can read and write them while it answers the person steering." : "The agent is not using files in this room."}
      </p>
      {list && (
        <p className={styles.usage} data-part="files-usage">
          {list.usage.files} of {list.limits.maxFiles} files · {describeBytes(list.usage.bytes)} of {describeBytes(list.limits.maxTotalBytes)}
        </p>
      )}
      {files.length > 0 && (
        <p className={styles.bulk}>
          <button type="button" className={styles.action} disabled={busy} onClick={downloadAll}>Download all as a zip</button>
        </p>
      )}
      <p className={styles.status} role="status" data-part="files-status">{note}</p>
      {error && <p className={styles.error} role="alert">{error}</p>}

      {list && files.length === 0 && (
        <p className={styles.empty} data-part="files-empty">
          No files yet. {view.canAttach ? "Attach a text file from the message box, or ask the agent to write one." : "Files appear here when the agent writes one or the person steering attaches one."}
        </p>
      )}
      {!list && !error && <p className={styles.empty}>Loading the files…</p>}

      <ul className={styles.list}>
        {files.map((f) => (
          <li key={f.name} className={styles.item} data-part="file-item">
            <div className={styles.row}>
              <button type="button" className={styles.name} onClick={() => show(f.name)} aria-label={`Open ${f.name}`}>{f.name}</button>
              <span className={styles.meta}>
                {describeBytes(f.size)} · version {f.version} · changed by {who(f)} at {formatClock(f.updated_at)}
              </span>
            </div>
            {view.isHost && (
              <div className={styles.actions}>
                <button type="button" className={styles.action} onClick={() => showHistory(f.name)} aria-label={`History of ${f.name}`}>History</button>
                {confirm === f.name ? (
                  <span className={styles.confirm} role="group" aria-label={`Delete ${f.name}?`}>
                    <span>Delete {f.name} and its older versions? This can't be undone.</span>
                    <button type="button" className={styles.danger} disabled={busy} onClick={() => act(() => view.remove(f.name), `Deleted ${f.name}.`)}>Delete file</button>
                    <button type="button" className={styles.action} onClick={() => setConfirm(null)}>Keep it</button>
                  </span>
                ) : (
                  <button type="button" className={styles.action} onClick={() => setConfirm(f.name)} aria-label={`Delete ${f.name}`}>Delete</button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {history && (
        <div className={styles.history} role="group" aria-label={`History of ${history.name}`} data-part="file-history">
          <h3 className={styles.sub}>History of {history.name}</h3>
          <ul className={styles.list}>
            {history.versions.map((v) => (
              <li key={v.version} className={styles.row}>
                <span className={styles.meta}>Version {v.version} · {describeBytes(v.size)} · {v.author === "agent" && v.on_behalf_of ? `the agent, for ${v.on_behalf_of}` : v.author} · {formatClock(v.created_at)}</span>
                <span className={styles.actions}>
                  <button type="button" className={styles.action} onClick={() => show(history.name, v.version)} aria-label={`View version ${v.version} of ${history.name}`}>View</button>
                  {v.version !== history.versions[0].version && (
                    <button type="button" className={styles.action} disabled={busy} onClick={() => act(() => view.restore(history.name, v.version), `Restored ${history.name} to version ${v.version}.`)} aria-label={`Restore version ${v.version} of ${history.name}`}>Restore</button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <button type="button" className={styles.action} onClick={() => setHistory(null)}>Close history</button>
        </div>
      )}

      {open && (
        <div className={styles.viewer} role="group" aria-label={`Text of ${open.name}`} data-part="file-viewer">
          <div className={styles.viewerBar}>
            <h3 className={styles.sub}>{open.name} <span className={styles.meta}>version {open.version} · {describeBytes(open.size)}</span></h3>
            <span className={styles.actions}>
              <button type="button" className={styles.action} onClick={() => copy(open)} aria-label={`Copy ${open.name}`}>Copy</button>
              <button type="button" className={styles.action} onClick={() => download(open)} aria-label={`Download ${open.name}`}>Download</button>
              <button type="button" className={styles.action} onClick={() => setOpen(null)}>Close</button>
            </span>
          </div>
          <pre className={styles.text} tabIndex={0} aria-label={`Contents of ${open.name}`}>{open.content}</pre>
        </div>
      )}
    </section>
  );
}
