import { useState } from "react";
import styles from "./Marketing.module.css";
import { THEMES } from "../themes/registry";
import { useTheme } from "../themes/ThemeProvider";

const SIGNAL_WORDS = {
  wave: "a flat waveform",
  softwave: "a soft wave with one small gradient",
  dots: "three dots that pulse in turn",
  line: "a thin line that breathes"
};

// Screenshots are real: scripts in web/qa render the room, from the recording,
// in every theme and mode (npm run qa:marketing-shots).
export function ThemeShowcase() {
  const { mode: pageMode } = useTheme();
  const [themeId, setThemeId] = useState(THEMES[0].id);
  const [mode, setMode] = useState(pageMode);
  const theme = THEMES.find((t) => t.id === themeId);

  return (
    <div className={styles.showcase}>
      <div className={styles.showcaseControls}>
        <div role="tablist" aria-label="Theme" className={styles.segmented}>
          {THEMES.map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              id={`tab-${t.id}`}
              aria-selected={t.id === themeId}
              aria-controls="theme-shot"
              onClick={() => setThemeId(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div role="radiogroup" aria-label="Color mode" className={styles.segmented}>
          {["light", "dark"].map((m) => (
            <button key={m} role="radio" type="button" aria-checked={mode === m} onClick={() => setMode(m)}>
              {m === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </div>

      <div id="theme-shot" role="tabpanel" aria-labelledby={`tab-${themeId}`} className={styles.shotFrame}>
        <img
          key={`${themeId}-${mode}`}
          className={styles.shot}
          src={`/marketing/room-${themeId}-${mode}.jpg`}
          width="1440"
          height="900"
          alt={`The same room in the ${theme.label} theme, ${mode} mode.`}
          loading="lazy"
        />
      </div>

      <p className={styles.shotNote}>
        <strong>{theme.label}.</strong> {theme.blurb} Type: {theme.fonts.families.map((f) => f.replace(/ Variable$/, "")).join(", ")}. The live signal is{" "}
        {SIGNAL_WORDS[theme.signal] ?? "drawn by the theme"}.
      </p>
    </div>
  );
}
