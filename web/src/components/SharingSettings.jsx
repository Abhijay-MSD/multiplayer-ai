import { useEffect, useState } from "react";
import styles from "./Admin.module.css";
import { getSharing, setSharing } from "../lib/adminApi";

const kindNote = (c) => (c.kind === "private" ? "" : c.kind === "link-local" ? " (unusual: link-local)" : " (unusual: shared range)");

// Settings > Sharing: who can reach Multiplayer AI. By default only this computer. The host can let people on the same Wi-Fi
// in for this run only (it is never remembered), and says which of the computer's addresses to use. In a container the
// host types the address people use instead, because the container can't see the network.
export function SharingSettings() {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState("local");
  const [address, setAddress] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);
  const [shareAddress, setShareAddress] = useState("");
  const [busy, setBusy] = useState(false);

  const adopt = (v) => {
    setView(v);
    setMode(v.active && !v.container ? "wifi" : "local");
    setAddress(v.address ?? v.candidates?.[0]?.address ?? "");
    setShareAddress(v.shareName ?? "");
  };

  useEffect(() => {
    getSharing().then(adopt).catch((e) => setError(e.message));
  }, []);

  if (error && !view) {
    return (
      <p className={styles.error} role="alert">
        {error}
      </p>
    );
  }
  if (!view) return null;

  const chosen = view.candidates.find((c) => c.address === address);
  const unusual = chosen && chosen.kind !== "private";

  const apply = async (body) => {
    setBusy(true);
    setError(null);
    try {
      adopt(await setSharing(body));
      setAcknowledge(false);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };

  if (!view.available) {
    return <p className={styles.text}>{view.unavailable_reason}</p>;
  }

  return (
    <div data-part="sharing-settings">
      <p className={styles.text}>
        By default only this computer can reach Multiplayer AI. You can let people on the same Wi-Fi in. That lasts until Multiplayer AI stops: it is never remembered, so every start begins with this computer only. Sharing over the internet isn't supported yet.
      </p>
      {view.notice && (
        <p className={styles.error} role="alert">
          {view.notice}
        </p>
      )}

      {view.container ? (
        <>
          <p className={styles.text}>
            Multiplayer AI is running in a container, so it counts as shared and cannot see your network. Enter the address people will use to reach this computer, such as 192.168.1.20 or a name ending in .local. Only that address (and this computer's own) is accepted.
          </p>
          <label className={styles.label} htmlFor="share-address">
            Address people will use
          </label>
          <input id="share-address" className={`${styles.field} ${styles.fieldMono}`} value={shareAddress} onChange={(e) => setShareAddress(e.target.value)} placeholder="192.168.1.20" autoComplete="off" spellCheck={false} />
          <div className={styles.actions}>
            <button type="button" className={styles.button} disabled={busy} onClick={() => apply({ share_address: shareAddress })}>
              Save address
            </button>
          </div>
          {view.shareName && <p className={styles.text}>Guests open http://{view.shareName}:{view.port}. Open a room on this computer's own address to get its link and QR code.</p>}
        </>
      ) : (
        <>
          <fieldset className={styles.choices}>
            <legend className={styles.legend}>Who can reach Multiplayer AI</legend>
            <label className={styles.choice}>
              <input type="radio" name="sharing-mode" value="local" checked={mode === "local"} disabled={busy} onChange={() => setMode("local")} />
              This computer only
            </label>
            <label className={styles.choice}>
              <input type="radio" name="sharing-mode" value="wifi" checked={mode === "wifi"} disabled={busy || view.active} onChange={() => setMode("wifi")} />
              Same Wi-Fi
            </label>
          </fieldset>

          {mode === "wifi" && !view.active && (
            <>
              {view.candidates.length ? (
                <>
                  <label className={styles.label} htmlFor="share-network">
                    Network address to share on
                  </label>
                  <select id="share-network" className={styles.field} value={address} onChange={(e) => setAddress(e.target.value)}>
                    {view.candidates.map((c) => (
                      <option key={c.address} value={c.address}>
                        {c.address} · {c.interface}
                        {c.virtual ? " (virtual)" : ""}
                        {kindNote(c)}
                      </option>
                    ))}
                  </select>
                  {unusual && (
                    <>
                      <p className={styles.notice}>{chosen.warning}</p>
                      <label className={styles.choice}>
                        <input type="checkbox" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} />
                        I understand, and I want to share on this address
                      </label>
                    </>
                  )}
                </>
              ) : (
                <p className={styles.notice}>This computer has no network address it could share on. Connect to your Wi-Fi, then reload this page.</p>
              )}
            </>
          )}

          {(mode === "wifi" || view.active) && <p className={styles.notice}>{view.warning}</p>}

          <div className={styles.actions}>
            {view.active ? (
              <button type="button" className={styles.buttonQuiet} disabled={busy} onClick={() => apply({ mode: "local" })}>
                Turn sharing off
              </button>
            ) : (
              <button
                type="button"
                className={styles.button}
                disabled={busy || mode !== "wifi" || !address || (unusual && !acknowledge)}
                onClick={() => apply({ mode: "wifi", address, ...(unusual ? { acknowledge: true } : {}) })}
              >
                Turn sharing on
              </button>
            )}
          </div>
          {view.active && (
            <p className={styles.text}>
              Sharing is on at {view.url}. Open a room on this computer's own address (127.0.0.1 or localhost) to get its link and QR code; the Copy link button there copies the link for guests.
            </p>
          )}
        </>
      )}

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <p className={styles.text}>
        What Multiplayer AI can tell about the network: this computer's addresses, and whether the one you pick is an ordinary home-network kind. What it can't: whether this is a café, hotel, school or office network, who else is on it, or whether a firewall or router stops other devices reaching it.
      </p>
      <p className={styles.text}>
        On a Mac, the first time you turn sharing on, macOS may ask whether to allow incoming connections for node. Choose Allow, or other devices won't be able to reach it.
      </p>
    </div>
  );
}
