import styles from "./Marketing.module.css";
import { useTheme } from "../themes/ThemeProvider";

const OPTIONS = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"]
];

// Light, dark, or follow the system. The landing page keeps the Signal Room
// theme; only the mode changes.
export function ModeToggle() {
  const { modePref, setModePref } = useTheme();
  return (
    <div role="radiogroup" aria-label="Color mode" className={styles.segmented}>
      {OPTIONS.map(([value, label]) => (
        <button key={value} type="button" role="radio" aria-checked={modePref === value} onClick={() => setModePref(value)}>
          {label}
        </button>
      ))}
    </div>
  );
}
