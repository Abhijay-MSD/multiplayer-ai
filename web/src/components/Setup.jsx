import { useEffect, useState } from "react";
import styles from "./Admin.module.css";
import { LiveSignal } from "./LiveSignal";
import { FailureScreen } from "./FailureScreen";
import { ProviderKeyForm } from "./ProviderKeyForm";
import { describeFailure } from "../lib/failures";
import { getSettings } from "../lib/adminApi";

// Only a path inside this app, so a link can't send someone somewhere else after saving.
function nextPath() {
  const next = new URLSearchParams(window.location.search).get("next") || "";
  return /^\/[A-Za-z0-9/_-]*$/.test(next) && !next.startsWith("//") ? next : "/new";
}

// /setup: the first run. Choose a provider, paste a key, test it, save it, and go on to start a room.
export default function Setup() {
  const [view, setView] = useState(null);
  const [failure, setFailure] = useState(null);

  useEffect(() => {
    getSettings()
      .then(setView)
      .catch((err) => setFailure(describeFailure(err)));
  }, []);

  if (failure) return <FailureScreen failure={failure} onRetry={() => window.location.reload()} />;
  if (!view) return null;

  return (
    <div className={styles.wrap} data-part="setup">
      <div className={styles.card}>
        <div className={styles.signal}>
          <LiveSignal state="idle" showLabel={false} />
        </div>
        <h1 className={styles.title}>Set up a model key</h1>
        <p className={styles.subtitle}>
          An agent needs a model provider to answer. You choose one and paste your own key. The key is saved in a file on this computer and sent only to that provider.
        </p>
        {view.configured && (
          <p className={styles.notice}>
            A key is already set up. You can change it here, or go on to <a href="/new">start a room</a>.
          </p>
        )}
        <ProviderKeyForm view={view} saveLabel="Save and continue" onSaved={() => window.location.assign(nextPath())} />
        <p className={styles.footnote}>
          Everyone in a room you share uses your key, so each reply is billed to your account with the provider. <a href="/settings">Settings</a> · <a href="/">About Multiplayer AI</a>
        </p>
      </div>
    </div>
  );
}
