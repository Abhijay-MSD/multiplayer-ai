import { useEffect, useRef, useState } from "react";
import styles from "./Admin.module.css";
import { PROVIDERS, EXPERIMENTAL_NOTE, providerById } from "../lib/providers";
import { checkBaseUrl, saveKey, saveSettings, testKey } from "../lib/adminApi";
import { describeFailure } from "../lib/failures";

// Pick a provider, paste a key, test it, save it. Used by Setup (the first time) and by
// Settings. `view` is the settings view from the server: it holds the last 4 characters
// of a key and never the key. The key typed here lives in this component's state until it
// is saved or the page is left; it is not written to storage or put in an address.
export function ProviderKeyForm({ view, onSaved, saveLabel = "Save" }) {
  const info = (id) => view.providers.find((p) => p.id === id);
  const [provider, setProvider] = useState(view.provider_source === "default" ? PROVIDERS[0].id : view.provider);
  const current = info(provider);
  const [key, setKey] = useState("");
  const [model, setModel] = useState(current.saved_model ?? "");
  const [baseUrl, setBaseUrl] = useState(current.saved_base_url ?? current.base_url ?? "");
  const [urlCheck, setUrlCheck] = useState(null); // what the address check said about where the key would go
  const [test, setTest] = useState(null); // { ok, message } of the last Test key
  const [showModel, setShowModel] = useState(Boolean(current.saved_model) || current.id === "compat" || current.overrides.some((o) => o.field === "model")); // a required field is not kept folded
  const [busy, setBusy] = useState(null); // "test" | "save" | null
  const [problem, setProblem] = useState(null);
  const typedFor = useRef(0);

  const choose = (id) => {
    const next = info(id);
    setProvider(id);
    setKey("");
    setModel(next.saved_model ?? "");
    setShowModel(Boolean(next.saved_model) || id === "compat" || next.overrides.some((o) => o.field === "model"));
    setBaseUrl(next.saved_base_url ?? next.base_url ?? "");
    setTest(null);
    setProblem(null);
  };

  // Where a key for a custom provider would go, worked out by the server as the address is typed.
  useEffect(() => {
    if (provider !== "compat") return undefined;
    if (!baseUrl.trim()) {
      setUrlCheck(null);
      return undefined;
    }
    const mine = ++typedFor.current;
    const id = setTimeout(() => {
      checkBaseUrl(baseUrl)
        .then((r) => mine === typedFor.current && setUrlCheck(r))
        .catch(() => mine === typedFor.current && setUrlCheck(null));
    }, 300);
    return () => clearTimeout(id);
  }, [provider, baseUrl]);

  const overrides = Object.fromEntries(current.overrides.map((o) => [o.field, o.variable]));
  const label = providerById(provider);
  const hasKey = current.key.present;
  const typed = key.trim() !== "";
  const compat = provider === "compat";
  const sendsTo = compat ? (urlCheck?.ok ? `${urlCheck.display}` : null) : label.sendsTo;
  const needsAddress = compat && (!baseUrl.trim() || urlCheck?.ok === false);
  const canSave = !busy && (typed || hasKey || compat) && !needsAddress && (!compat || model.trim() !== "" || Boolean(overrides.model));

  const args = () => ({ provider, key: typed ? key.trim() : undefined, base_url: compat ? baseUrl.trim() : undefined, model: model.trim() || undefined });

  const runTest = async () => {
    setBusy("test");
    setProblem(null);
    setTest(null);
    try {
      setTest(await testKey(args()));
    } catch (err) {
      setProblem(describeFailure(err).body);
    }
    setBusy(null);
  };

  const save = async (e) => {
    e?.preventDefault();
    if (!canSave) return;
    setBusy("save");
    setProblem(null);
    try {
      let next = await saveSettings({ provider, model: model.trim(), ...(compat ? { base_url: baseUrl.trim() } : {}) });
      if (typed) next = await saveKey(provider, key.trim());
      setKey("");
      setTest(null);
      onSaved?.(next);
    } catch (err) {
      setProblem(err.message || describeFailure(err).body);
    }
    setBusy(null);
  };

  return (
    <form onSubmit={save} noValidate data-part="provider-key-form">
      <fieldset className={styles.choices}>
        <legend className={styles.legend}>Model provider</legend>
        {PROVIDERS.map((p) => (
          <label key={p.id} className={styles.choice}>
            <input type="radio" name="provider" value={p.id} checked={provider === p.id} onChange={() => choose(p.id)} />
            {p.label}
            {p.experimental ? " (experimental)" : ""}
          </label>
        ))}
      </fieldset>
      {view.provider_override && (
        <p className={styles.notice}>
          The environment variable <code>{view.provider_override.variable}</code> chooses the provider and is used instead of this choice.
        </p>
      )}

      {label.experimental && <p className={styles.notice}>{EXPERIMENTAL_NOTE}</p>}

      <p className={styles.text}>
        {label.keyHint}{" "}
        {label.keyLink && (
          <a href={label.keyLink.href} target="_blank" rel="noopener noreferrer">
            {label.keyLink.text}
          </a>
        )}
      </p>

      {compat && (
        <>
          <label className={styles.label} htmlFor="provider-address">
            Address
          </label>
          <input
            id="provider-address"
            className={`${styles.field} ${styles.fieldMono}`}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={urlCheck?.ok === false ? true : undefined}
            aria-describedby="provider-sends-to"
          />
          {overrides.base_url && <p className={styles.notice}>The environment variable <code>{overrides.base_url}</code> sets the address and is used instead of this field.</p>}
        </>
      )}

      <label className={styles.label} htmlFor="provider-key">
        API key
      </label>
      <input
        id="provider-key"
        className={`${styles.field} ${styles.fieldMono}`}
        type="password"
        name="api-key"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore="true"
        data-lpignore="true"
        placeholder={hasKey ? "Paste a new key to replace the one in use" : "Paste your key here"}
        aria-describedby="provider-key-state"
      />
      <p className={styles.text} id="provider-key-state">
        {hasKey
          ? `A key ending in ${current.key.last4 ?? "····"} is in use${current.key.source === "env" ? ", from an environment variable" : ", saved on this computer"}. Leave the field empty to keep it.`
          : compat
            ? "No key is saved. A model running on this computer may not need one."
            : "No key is saved yet."}
      </p>
      {overrides.key && (
        <p className={styles.notice}>
          The environment variable <code>{overrides.key}</code> holds the key in use. It is used instead of anything saved here.
        </p>
      )}

      <details open={showModel} onToggle={(e) => setShowModel(e.currentTarget.open)}>
        <summary className={styles.text}>Model{compat ? "" : " (optional)"}</summary>
        <input
          className={`${styles.field} ${styles.fieldMono}`}
          aria-label="Model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={current.default_model ?? "The model name your provider uses"}
          autoComplete="off"
          spellCheck={false}
        />
        {overrides.model && <p className={styles.notice}>The environment variable <code>{overrides.model}</code> sets the model and is used instead of this field.</p>}
      </details>
      {compat && (
        <p className={styles.text}>
          A model name is required for this choice.
        </p>
      )}

      <p className={styles.sendsTo} id="provider-sends-to">
        {sendsTo ? (
          <>
            Your key will be sent to: <strong>{sendsTo}</strong>
          </>
        ) : compat && urlCheck?.ok === false ? (
          <span className={styles.error}>{urlCheck.message}</span>
        ) : compat ? (
          "Enter the address to see where your key would be sent."
        ) : null}
      </p>

      <div aria-live="polite">
        {test && (
          <p className={styles.result} data-ok={test.ok} role="status">
            <span className={styles.resultTitle} data-ok={test.ok}>
              {test.ok ? "The key works." : "The key didn't work."}
            </span>{" "}
            {test.ok ? (test.model ? `One small request to ${test.model} was answered.` : "One small request was answered.") : test.message}
          </p>
        )}
        {problem && (
          <p className={styles.error} role="alert">
            {problem}
          </p>
        )}
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.buttonQuiet} onClick={runTest} disabled={Boolean(busy) || (!typed && !hasKey && !compat) || needsAddress}>
          {busy === "test" ? "Testing…" : "Test key"}
        </button>
        <button type="submit" className={styles.button} disabled={!canSave}>
          {busy === "save" ? "Saving…" : saveLabel}
        </button>
      </div>
    </form>
  );
}
