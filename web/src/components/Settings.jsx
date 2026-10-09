import { useEffect, useState } from "react";
import styles from "./Admin.module.css";
import { LiveSignal } from "./LiveSignal";
import { FailureScreen } from "./FailureScreen";
import { ProviderKeyForm } from "./ProviderKeyForm";
import { TypedConfirm } from "./TypedConfirm";
import { SharingSettings } from "./SharingSettings";
import { describeFailure } from "../lib/failures";
import { EXPERIMENTAL_NOTE, providerById } from "../lib/providers";
import { deleteKey, deleteRooms, exportData, getSettings } from "../lib/adminApi";

// /settings: change the provider or key, delete the saved key, export everything, delete every room.
export default function Settings() {
  const [view, setView] = useState(null);
  const [failure, setFailure] = useState(null);
  const [saved, setSaved] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState(null);
  const [keyNote, setKeyNote] = useState(null); // what the last key deletion did, kept after its form is gone

  useEffect(() => {
    getSettings()
      .then(setView)
      .catch((err) => setFailure(describeFailure(err)));
  }, []);

  if (failure) return <FailureScreen failure={failure} onRetry={() => window.location.reload()} />;
  if (!view) return null;

  const withSavedKey = view.providers.filter((p) => p.key.saved);

  const doExport = async () => {
    setExporting(true);
    setExportResult(null);
    try {
      const name = await exportData();
      setExportResult({ ok: true, message: `Saved as ${name} in your downloads.` });
    } catch (err) {
      setExportResult({ ok: false, message: err.message });
    }
    setExporting(false);
  };

  return (
    <div className={styles.wrap} data-part="settings">
      <div className={styles.card}>
        <div className={styles.signal}>
          <LiveSignal state="idle" showLabel={false} />
        </div>
        <h1 className={styles.title}>Settings</h1>
        <p className={styles.subtitle}>
          {view.configured ? `Replies come from ${providerById(view.provider).label}.` : "No model key is set up yet, so an agent can't reply."} <a href="/new">Start a room</a>
        </p>
        {providerById(view.provider).experimental && <p className={styles.notice}>{EXPERIMENTAL_NOTE}</p>}
        {view.problem && <p className={styles.error} role="alert">{view.problem}</p>}

        <section className={styles.section} aria-labelledby="s-provider">
          <h2 className={styles.sectionTitle} id="s-provider">Provider and key</h2>
          <ProviderKeyForm
            key={JSON.stringify(view.providers.map((p) => [p.key, p.model]))}
            view={view}
            onSaved={(next) => {
              setView(next);
              setSaved(true);
            }}
          />
          <div aria-live="polite">{saved && <p className={styles.result} role="status">Saved.</p>}</div>
        </section>

        <section className={styles.section} aria-labelledby="s-sharing">
          <h2 className={styles.sectionTitle} id="s-sharing">Sharing</h2>
          <SharingSettings />
        </section>

        <section className={styles.section} aria-labelledby="s-where">
          <h2 className={styles.sectionTitle} id="s-where">Where your key and data are kept</h2>
          <dl className={styles.facts}>
            <dt>Data folder</dt>
            <dd className={styles.mono}>{view.storage.folder ?? "—"}</dd>
            <dt>Settings file</dt>
            <dd className={styles.mono}>{view.file ?? "—"}</dd>
            <dt>Rooms</dt>
            <dd className={styles.mono}>{view.storage.file ?? view.storage.kind}</dd>
          </dl>
          <p className={styles.text}>
            Your key is saved as plain text in the settings file, which only your account on this computer can read. That keeps other accounts on this computer out. It does not protect against anyone who can use your account, or against a backup or sync tool that copies this folder. (On Windows the file permission does nothing.)
          </p>
          <p className={styles.text}>
            Your rooms and settings are stored on this computer only. The only thing that leaves it is what Multiplayer AI sends to the provider you chose: when an agent replies or you test a key, that provider receives your key and, for a reply, the room's task and recent messages. The page loads its fonts and everything else from Multiplayer AI itself, and nothing is sent to any other host.
          </p>
        </section>

        {(withSavedKey.length > 0 || keyNote) && (
          <section className={styles.section} aria-labelledby="s-key">
            <h2 className={styles.sectionTitle} id="s-key">Delete a saved key</h2>
            <div aria-live="polite">{keyNote && <p className={styles.result} role="status">{keyNote}</p>}</div>
            {withSavedKey.map((p) => (
              <TypedConfirm
                key={p.id}
                phrase="delete key"
                title={`The saved ${providerById(p.id).label} key`}
                description={`Removes the key ending in ${p.key.saved_last4 ?? "····"} from the settings file.${
                  p.overrides.some((o) => o.field === "key") ? ` An environment variable (${p.overrides.find((o) => o.field === "key").variable}) also holds a key and is not touched.` : ""
                } Rooms are not affected.`}
                buttonLabel="Delete saved key"
                onConfirm={async (phrase) => {
                  const next = await deleteKey(p.id, phrase);
                  setView(next);
                  setKeyNote(`The saved ${providerById(p.id).label} key was deleted.`);
                  return "The saved key was deleted.";
                }}
              />
            ))}
          </section>
        )}

        <section className={styles.section} aria-labelledby="s-data">
          <h2 className={styles.sectionTitle} id="s-data">Your rooms</h2>
          <h3 className={styles.sectionTitle}>Export everything</h3>
          <p className={styles.text}>A file with every room, its events, and each person's name and role. It holds no keys and no access tokens.</p>
          <div className={styles.actions}>
            <button type="button" className={styles.buttonQuiet} onClick={doExport} disabled={exporting}>
              {exporting ? "Preparing…" : "Download an export"}
            </button>
          </div>
          <div aria-live="polite">
            {exportResult && (
              <p className={exportResult.ok ? styles.result : styles.error} role={exportResult.ok ? "status" : "alert"}>
                {exportResult.message}
              </p>
            )}
          </div>
          <TypedConfirm
            phrase="delete all rooms"
            title="Delete every room"
            description="Removes every room, its events and who was in it, then rewrites the data file so the text is not left behind, and removes the copies kept from before an update. People with a room open are told the rooms were deleted. Your saved key stays. This can't be undone."
            buttonLabel="Delete all rooms"
            onConfirm={async (phrase) => {
              const r = await deleteRooms(phrase);
              return `Deleted ${r.deleted_rooms} ${r.deleted_rooms === 1 ? "room" : "rooms"}${r.removed_backups ? ` and ${r.removed_backups} backup ${r.removed_backups === 1 ? "copy" : "copies"}` : ""}.`;
            }}
          />
        </section>

        <p className={styles.footnote}>
          <a href="/new">Start a room</a> · <a href="/">About Multiplayer AI</a>
        </p>
      </div>
    </div>
  );
}
