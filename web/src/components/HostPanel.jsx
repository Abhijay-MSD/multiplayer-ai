import { useEffect, useRef, useState } from "react";
import styles from "./HostPanel.module.css";
import { decideControl, makeNewLink, removePerson, setGuestCap, setRoomBrief, setRoomFiles, setRoomPolicy } from "../lib/adminApi";
import { describeBytes } from "../lib/files";

const POLICIES = [
  { id: "locked", label: "Locked", hint: "Only you change who is steering." },
  { id: "ask", label: "Ask me", hint: "A guest's request waits for you to approve it." },
  { id: "free", label: "Allow freely", hint: "The usual rules: take control if nobody holds it or the controller is away." }
];

const requestText = (r) => (r.kind === "handoff" ? `${r.name} wants to hand control to ${r.to}` : `${r.name} wants control`);

// The host's controls for one room: the share link and QR code, who is waiting for control, the control policy,
// the limit on guests' messages, and who is in the room. `panel` comes from the server (host-routes.js) and every
// action returns the updated panel. It is shown only to the host, who stays on this computer's own address.
export function HostPanel({ sessionId, panel, onChange, onClose }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);
  const [cap, setCap] = useState(String(panel.counters.guest_cap));
  const [busy, setBusy] = useState(false);
  const [brief, setBrief] = useState(panel.brief ?? "");
  const closeRef = useRef(null);
  const fieldRef = useRef(null);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true }); // keyboard focus moves in, but the panel stays at its top
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => setCap(String(panel.counters.guest_cap)), [panel.counters.guest_cap]);
  useEffect(() => setBrief(panel.brief ?? ""), [panel.brief]);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await fn());
    } catch (err) {
      setError(err.message || "That didn't work.");
    }
    setBusy(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(panel.share.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      fieldRef.current?.select();
    }
  };

  const { share, counters, pending, people } = panel;
  const capNumber = cap.trim() === "" ? NaN : Number(cap);
  const capOk = Number.isInteger(capNumber) && capNumber >= 0 && capNumber <= 100000;
  const qr = share.qr_svg ? `data:image/svg+xml;utf8,${encodeURIComponent(share.qr_svg)}` : null;

  return (
    <section className={styles.panel} role="dialog" aria-modal="false" aria-labelledby="host-title" data-part="host-panel">
      <h2 id="host-title" className={styles.title}>
        Host controls
      </h2>
      <p className={styles.text}>
        You have these controls because you opened Multiplayer AI on this computer's own address. Keep using it for them; your guests use the network link.
      </p>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Link for guests</h3>
        <div className={styles.row}>
          <input ref={fieldRef} className={styles.field} value={share.link} readOnly aria-label="Link for guests" onFocus={(e) => e.target.select()} />
          <button type="button" className={styles.button} onClick={copy}>
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
        {qr && <img className={styles.qr} src={qr} alt="QR code for the link for guests. A phone camera can scan it." />}
        <p className={styles.text}>{share.note}</p>
        {share.warning && <p className={styles.warning}>{share.warning}</p>}
        <div className={styles.row}>
          <button type="button" className={styles.quiet} disabled={busy} onClick={() => run(() => makeNewLink(sessionId))}>
            Make a new link
          </button>
          <span className={styles.text}>The old link stops working for new people. Everyone already in the room keeps their place.</span>
        </div>
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Who can take control</h3>
        <fieldset className={styles.choices}>
          <legend className={styles.legend}>When someone other than you asks for control</legend>
          {POLICIES.map((p) => (
            <label key={p.id} className={styles.choice} title={p.hint}>
              <input type="radio" name="control-policy" value={p.id} checked={panel.policy === p.id} disabled={busy} onChange={() => run(() => setRoomPolicy(sessionId, p.id))} />
              {p.label}
            </label>
          ))}
        </fieldset>
        <p className={styles.text}>{POLICIES.find((p) => p.id === panel.policy)?.hint}</p>
        {pending.length > 0 ? (
          <ul className={styles.list} aria-label="Waiting for your answer">
            {pending.map((r) => (
              <li key={r.id} className={styles.item}>
                <span>{requestText(r)}</span>
                <span className={styles.row}>
                  <button type="button" className={styles.button} disabled={busy} onClick={() => run(() => decideControl(sessionId, r.id, "approve"))}>
                    Approve
                  </button>
                  <button type="button" className={styles.quiet} disabled={busy} onClick={() => run(() => decideControl(sessionId, r.id, "deny"))}>
                    Deny
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.text}>Nobody is waiting for control.</p>
        )}
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>What your key is paying for</h3>
        <p className={styles.counters} role="status">
          Guests: {counters.guest_messages} of {counters.guest_cap} · Room: {counters.room_steps} of {counters.room_cap}
          {counters.model_calls !== undefined && ` · Model calls: ${counters.model_calls} of ${counters.model_call_cap}`}
        </p>
        <p className={styles.text}>Guests can send only so many messages to the agent in this room. Your own messages are not counted against that limit.</p>
        <div className={styles.row}>
          <label htmlFor="guest-cap" className={styles.text}>
            Messages guests may send
          </label>
          <input id="guest-cap" className={`${styles.field} ${styles.number}`} type="number" min="0" max="100000" step="1" value={cap} onChange={(e) => setCap(e.target.value)} />
          <button type="button" className={styles.quiet} disabled={busy || !capOk} onClick={() => run(() => setGuestCap(sessionId, capNumber))}>
            Save limit
          </button>
        </div>
      </div>

      {panel.brief !== undefined && (
        <div className={styles.section} data-part="host-brief">
          <h3 className={styles.sectionTitle}>Room brief</h3>
          <p className={styles.text}>A short note for this room. Everyone in the room can read it, and the agent is given it as your instructions. Every change is noted in the room.</p>
          <label htmlFor="room-brief" className={styles.text}>Brief (up to 1500 characters)</label>
          <textarea id="room-brief" className={styles.field} rows={4} maxLength={1500} value={brief} onChange={(e) => setBrief(e.target.value)} />
          <p className={styles.counters} aria-live="polite">{[...brief].length} of 1500</p>
          <div className={styles.row}>
            <button type="button" className={styles.button} disabled={busy || brief.trim() === (panel.brief ?? "")} onClick={() => run(() => setRoomBrief(sessionId, brief))}>
              Save brief
            </button>
            <button type="button" className={styles.quiet} disabled={busy || (panel.brief ?? "") === ""} onClick={() => run(() => setRoomBrief(sessionId, ""))}>
              Clear brief
            </button>
          </div>
        </div>
      )}

      {panel.files?.available && (
        <div className={styles.section} data-part="host-files">
          <h3 className={styles.sectionTitle}>The agent and files</h3>
          <label className={styles.choice}>
            <input type="checkbox" checked={panel.files.enabled} disabled={busy} onChange={(e) => run(() => setRoomFiles(sessionId, e.target.checked))} />
            Agent can use files
          </label>
          <p className={styles.text}>
            When this is on, the agent can list, read and write the text files in this room while it answers the person steering. It can't delete files, make folders, run code or reach the internet. Only the controller's messages start it. A file's text is passed to the agent as data, not as instructions, but a model can still be misled by text it reads. Attach only files you trust.
          </p>
          <p className={styles.counters}>
            Files: {panel.files.count} of {panel.files.limits.maxFiles} · {describeBytes(panel.files.bytes)} of {describeBytes(panel.files.limits.maxTotalBytes)}
          </p>
        </div>
      )}

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>People in this room</h3>
        <ul className={styles.list}>
          {people.map((p) => (
            <li key={p.name} className={styles.item}>
              <span>
                {p.name}
                {p.is_host ? " (you)" : p.role === "controller" ? " · steering" : ""}
              </span>
              {!p.is_host && (
                <button type="button" className={styles.danger} disabled={busy} aria-label={`Remove ${p.name}`} onClick={() => run(() => removePerson(sessionId, p.name))}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        <p className={styles.text}>Removing someone ends their connection and frees their name. They can come back with the link unless you make a new one.</p>
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <button ref={closeRef} type="button" className={styles.close} onClick={onClose}>
        Close
      </button>
    </section>
  );
}

// Shown when someone asks for control and the panel is closed, so the host does not have to go looking.
export function HostPrompt({ sessionId, pending, onChange, onOpen }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!pending.length) return null;
  const decide = async (id, decision) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await decideControl(sessionId, id, decision));
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };
  return (
    <div className={styles.prompt} role="alert" data-part="host-prompt">
      {pending.map((r) => (
        <div key={r.id} className={styles.item}>
          <span>{requestText(r)}</span>
          <span className={styles.row}>
            <button type="button" className={styles.button} disabled={busy} onClick={() => decide(r.id, "approve")}>
              Approve
            </button>
            <button type="button" className={styles.quiet} disabled={busy} onClick={() => decide(r.id, "deny")}>
              Deny
            </button>
          </span>
        </div>
      ))}
      {error && <p className={styles.error}>{error}</p>}
      <button type="button" className={styles.close} onClick={onOpen}>
        Open host controls
      </button>
    </div>
  );
}
