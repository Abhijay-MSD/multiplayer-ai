import { useEffect, useId, useRef, useState } from "react";
import styles from "./ThemeSwitcher.module.css";
import { useTheme } from "./ThemeProvider";

const MODE_LABELS = { system: "System", light: "Light", dark: "Dark" };

// Each swatch carries its own data-theme and data-mode, so it paints with that
// theme's real tokens rather than a copy of them.
function Swatch({ id, mode }) {
  return (
    <span className={styles.swatch} data-theme={id} data-mode={mode} aria-hidden="true">
      <span className={styles.swatchSurface} />
      <span className={styles.swatchText} />
      <span className={styles.swatchAccent} />
    </span>
  );
}

// Roving-tabindex radio group: arrows move and select, Home/End jump.
function RadioGroup({ label, group, options, value, onSelect, renderOption, className }) {
  const refs = useRef([]);
  const onKeyDown = (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    let next = null;
    const i = options.findIndex((o) => o.value === value);
    if (e.key in keys) next = (i + keys[e.key] + options.length) % options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    if (next === null) return;
    e.preventDefault();
    onSelect(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} data-group={group} className={className} onKeyDown={onKeyDown}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => (refs.current[i] = el)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onSelect(o.value)}
        >
          {renderOption(o)}
        </button>
      ))}
    </div>
  );
}

export function ThemeSwitcher() {
  const { theme, themes, mode, modePref, setTheme, setModePref } = useTheme();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const popId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onPointer = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    // Move focus to the checked theme so the dialog is usable from the keyboard.
    wrapRef.current?.querySelector('[data-group="theme"] [aria-checked="true"]')?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <div className={styles.wrap} ref={wrapRef} data-part="theme-switcher">
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popId}
        onClick={() => setOpen((o) => !o)}
      >
        <Swatch id={theme} mode={mode} />
        <span>Theme</span>
      </button>

      {open && (
        <div id={popId} role="dialog" aria-label="Appearance" className={styles.pop}>
          <div className={styles.heading}>Theme</div>
          <RadioGroup
            label="Theme"
            group="theme"
            className={styles.themes}
            options={themes.map((t) => ({ value: t.id, ...t }))}
            value={theme}
            onSelect={setTheme}
            renderOption={(t) => (
              <>
                <Swatch id={t.id} mode={mode} />
                <span className={styles.themeText}>
                  <span className={styles.themeName}>{t.label}</span>
                  <span className={styles.themeBlurb}>{t.blurb}</span>
                </span>
              </>
            )}
          />
          <div className={styles.heading}>Color mode</div>
          <RadioGroup
            label="Color mode"
            className={styles.modes}
            options={Object.entries(MODE_LABELS).map(([value, label]) => ({ value, label }))}
            value={modePref}
            onSelect={setModePref}
            renderOption={(o) => o.label}
          />
        </div>
      )}
    </div>
  );
}
