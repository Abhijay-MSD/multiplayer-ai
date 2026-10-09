import { useLayoutEffect, useRef, useState } from "react";
import styles from "./Composer.module.css";
import { controlView } from "../lib/control";
import { NAME_RULE, readTextFile, suggestFileName } from "../lib/files";

const PLACEHOLDERS = {
  agent: "Message the agent…",
  comment: "Comment to the room. The agent won't see this."
};

const MAX_FIELD_PX = 200;

function SendIcon() {
  return (
    <svg className={styles.sendIcon} data-part="send-icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M10 16V4M4.5 9.5 10 4l5.5 5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// PRD 13 / FR-5 / FR-5b: a single steering seat. The controller chooses
// between messaging the agent (default) and commenting; a watcher can only
// comment. The accent color belongs to agent mode alone, so the look of the
// bar says where the text is going. Themes lay the same parts out differently
// (data-part hooks); the behavior here does not change.
// `attach`, when given, is { attach(name, content), limits? }: the controller or the host may attach text files (a button, or
// drop them on the bar). What is attached can be read by the agent, which is why a guest cannot.
// `onRetry`, when given (the controller), shows "Send my last message again" (off while the agent is working).
// `onStop`, when given (the controller or the host, while the agent is working), shows a Stop button that ends the step that is running.
export function Composer({ isController, controllerName, controllerHere = false, onSendDirective, onSendComment, onTakeControl, busy, control = {}, attach = null, onStop = null, onRetry = null, working = false }) {
  const view = controlView({ control, controllerName, controllerHere });
  const [pickedMode, setPickedMode] = useState("agent");
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const fieldRef = useRef(null);
  const pickerRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    setError(null);
    try {
      await onRetry();
    } catch (err) {
      setError(err.message);
    }
    setRetrying(false);
  };
  const [stopNote, setStopNote] = useState("");
  const [stopping, setStopping] = useState(false);
  const stopAgent = async () => {
    setStopping(true);
    setStopNote("");
    try {
      const out = await onStop();
      setStopNote(out?.stopped ? "Stopping the agent." : "The agent isn't working right now.");
    } catch (err) {
      setStopNote(err.message || "Couldn't stop the agent.");
    }
    setStopping(false);
  };
  const [attached, setAttached] = useState([]); // [{ ok, text }] what the last attach did, one line each
  const [renames, setRenames] = useState([]); // files whose name wasn't allowed: { id, original, name, text, error }

  const attachFiles = async (files) => {
    const lines = [];
    const needRename = [];
    for (const file of files) {
      const read = await readTextFile(file, attach.limits?.maxFileBytes);
      if (!read.ok) {
        lines.push({ ok: false, text: read.message });
        continue;
      }
      try {
        await attach.attach(file.name, read.text);
        lines.push({ ok: true, text: `Attached ${file.name}.` });
      } catch (err) {
        if (err.code === "BAD_FILE_NAME") needRename.push({ id: `${Date.now()}-${file.name}`, original: file.name, name: suggestFileName(file.name) || "file.txt", text: read.text, error: err.message });
        else lines.push({ ok: false, text: `${file.name}: ${err.message}` });
      }
    }
    setAttached(lines);
    setRenames((r) => [...r, ...needRename]);
  };
  const renameAttach = async (r) => {
    try {
      await attach.attach(r.name, r.text);
      setAttached([{ ok: true, text: `Attached ${r.name}.` }]);
      setRenames((all) => all.filter((x) => x.id !== r.id));
    } catch (err) {
      setRenames((all) => all.map((x) => (x.id === r.id ? { ...x, error: err.message } : x)));
    }
  };
  const onDrop = (e) => {
    if (!attach) return;
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer?.files?.length) attachFiles([...e.dataTransfer.files]);
  };

  // Losing control flips the composer to comment-only; the text stays put.
  const mode = isController ? pickedMode : "comment";
  const agent = mode === "agent";

  // Grow with the text, up to a cap, then scroll.
  useLayoutEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.style.height = "auto";
    const borders = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + borders, MAX_FIELD_PX)}px`;
    el.style.overflowY = el.scrollHeight + borders > MAX_FIELD_PX ? "auto" : "hidden";
  }, [value]);

  const submit = async (e) => {
    e?.preventDefault();
    const content = value.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    try {
      await (agent ? onSendDirective(content) : onSendComment(content));
      setValue("");
    } catch (err) {
      setError(err.message); // keep the text so nothing is lost
    } finally {
      setSending(false);
    }
  };

  // Enter sends, and so does Ctrl+Enter or Cmd+Enter; Shift+Enter adds a line. Ignored while an IME is composing.
  const onKeyDown = (e) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if ((e.metaKey || e.ctrlKey) || !e.shiftKey) submit(e);
  };

  const sendLabel = agent ? "Send to agent" : isController ? "Comment" : "Send";

  return (
    <form
      className={`${styles.bar} ${agent ? styles.barAgent : styles.barComment}`}
      data-part="composer"
      data-target={agent ? "agent" : "comment"}
      data-role={isController ? "controller" : "watcher"}
      data-dragging={dragging ? "true" : undefined}
      onSubmit={submit}
      onDragOver={attach ? (e) => (e.preventDefault(), setDragging(true)) : undefined}
      onDragLeave={attach ? () => setDragging(false) : undefined}
      onDrop={attach ? onDrop : undefined}
    >
      {isController ? (
        <div className={styles.modes} data-part="composer-modes" role="radiogroup" aria-label="Where this message goes">
          {[
            ["agent", "Message the agent"],
            ["comment", "Comment"]
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={mode === key}
              data-choice={key}
              className={`${styles.mode} ${mode === key ? (key === "agent" ? styles.modeAgentOn : styles.modeCommentOn) : ""}`}
              onClick={() => setPickedMode(key)}
            >
              {label}
            </button>
          ))}
          <span className={styles.modeHint} data-part="composer-mode-hint">
            {agent ? "The agent will reply to this." : "Only people in the room see this."}
          </span>
          {onRetry && (
            <button type="button" className={styles.retry} disabled={working || retrying || sending} onClick={retry} title={working ? "Wait for the agent to finish, or stop it." : "Sends your last message to the agent again."}>
              Send my last message again
            </button>
          )}
        </div>
      ) : (
        <div className={styles.hint} data-part="composer-hint">
          {controllerName
            ? controllerHere && !view.asking
              ? `Only the controller can message the agent. ${controllerName} is here and steering.`
              : "Only the controller can message the agent. Take control to steer it."
            : "Nobody is controller. Take control to message the agent."}{" "}
          <button type="button" className={styles.takeLink} disabled={busy || view.blocked} onClick={onTakeControl}>
            {view.label}
          </button>
          {view.reason && !controllerHere && <span> {view.reason}.</span>}
        </div>
      )}
      <div className={styles.row} data-part="composer-field">
        <textarea
          ref={fieldRef}
          rows={1}
          className={`${styles.input} ${agent ? styles.inputAgent : ""}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={PLACEHOLDERS[mode]}
          aria-label={PLACEHOLDERS[mode]}
          maxLength={4000}
        />
        <button
          className={`${styles.send} ${agent ? styles.sendAgent : styles.sendComment}`}
          data-part="send"
          type="submit"
          title="Send (Enter, or Ctrl or Cmd+Enter). Shift+Enter adds a line."
          disabled={!value.trim() || sending}
        >
          <SendIcon />
          <span className={styles.sendLabel} data-part="send-label">{sending ? "Sending…" : sendLabel}</span>
        </button>
      </div>
      {(onStop || stopNote) && (
        <div className={styles.stopRow} data-part="composer-stop">
          {onStop && (
            <button type="button" className={styles.stopButton} onClick={stopAgent} disabled={stopping}>
              Stop the agent
            </button>
          )}
          <span className={styles.attachHint} role="status">{stopNote}</span>
        </div>
      )}
      {attach && (
        <div className={styles.attach} data-part="composer-attach">
          <input ref={pickerRef} type="file" multiple hidden onChange={(e) => (attachFiles([...e.target.files]), (e.target.value = ""))} />
          <button type="button" className={styles.attachButton} onClick={() => pickerRef.current?.click()}>
            Attach text files
          </button>
          <span className={styles.attachHint}>or drop them here. The agent can read what you attach.</span>
          <div className={styles.attachResult} role="status">
            {attached.map((a, i) => (
              <div key={i} className={a.ok ? undefined : styles.attachProblem}>{a.text}</div>
            ))}
          </div>
          {renames.map((r) => (
            <div key={r.id} className={styles.rename} role="group" aria-label={`Rename ${r.original}`}>
              <label htmlFor={`rename-${r.id}`}>{r.original} can't be attached under that name. {NAME_RULE} New name:</label>
              <div className={styles.renameRow}>
                <input id={`rename-${r.id}`} className={styles.renameField} value={r.name} maxLength={64} onChange={(e) => setRenames((all) => all.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)))} />
                <button type="button" className={styles.attachButton} onClick={() => renameAttach(r)}>Attach</button>
                <button type="button" className={styles.attachButton} onClick={() => setRenames((all) => all.filter((x) => x.id !== r.id))}>Skip</button>
              </div>
              {r.error && <div className={styles.attachProblem}>{r.error}</div>}
            </div>
          ))}
        </div>
      )}
      {error && <div className={styles.error} role="alert">{error}</div>}
    </form>
  );
}
