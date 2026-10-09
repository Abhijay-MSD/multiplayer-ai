import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getTheme, THEMES } from "./registry";
import { ensureThemeFonts } from "./fonts";
import { DEFAULT_THEME, MODES, loadPreferences, savePreferences } from "./preferences";

const ThemeContext = createContext(null);

const root = () => document.documentElement;
const systemMode = () => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
const resolveMode = (pref) => (pref === "system" ? systemMode() : pref);

function applyAttributes({ theme, modePref }) {
  const mode = resolveMode(modePref);
  const el = root();
  el.setAttribute("data-theme", theme);
  el.setAttribute("data-mode", mode);
  el.setAttribute("data-mode-pref", modePref);
  el.style.colorScheme = mode;
  return mode;
}

// The boot script in index.html has already set the attributes before first
// paint; this reads them back so React and the DOM start in agreement.
function readFromDom() {
  const el = root();
  const theme = el.getAttribute("data-theme");
  const modePref = el.getAttribute("data-mode-pref");
  return {
    theme: THEMES.some((t) => t.id === theme) ? theme : DEFAULT_THEME,
    modePref: MODES.includes(modePref) ? modePref : "system"
  };
}

export function ThemeProvider({ children }) {
  const [state, setState] = useState(() => ({ ...readFromDom(), mode: root().getAttribute("data-mode") || "light" }));
  const switchToken = useRef(0);

  const setTheme = useCallback(async (id) => {
    const target = getTheme(id);
    const token = ++switchToken.current;
    // Wait for the new fonts so text does not reflow after the switch.
    await ensureThemeFonts(target);
    if (token !== switchToken.current) return; // a newer choice won
    setState((prev) => {
      const mode = applyAttributes({ theme: target.id, modePref: prev.modePref });
      savePreferences({ theme: target.id });
      return { ...prev, theme: target.id, mode };
    });
  }, []);

  const setModePref = useCallback((pref) => {
    if (!MODES.includes(pref)) return;
    setState((prev) => {
      const mode = applyAttributes({ theme: prev.theme, modePref: pref });
      savePreferences({ mode: pref });
      return { ...prev, modePref: pref, mode };
    });
  }, []);

  // Follow the operating system while the mode preference is "system".
  useEffect(() => {
    if (state.modePref !== "system") return;
    const query = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () =>
      setState((prev) => ({ ...prev, mode: applyAttributes({ theme: prev.theme, modePref: "system" }) }));
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [state.modePref]);

  // Keep other open tabs in step with a change made in this one.
  useEffect(() => {
    const onStorage = () => {
      const saved = loadPreferences();
      const theme = THEMES.some((t) => t.id === saved.theme) ? saved.theme : DEFAULT_THEME;
      const modePref = MODES.includes(saved.mode) ? saved.mode : "system";
      ensureThemeFonts(getTheme(theme)).then(() => {
        const mode = applyAttributes({ theme, modePref });
        setState({ theme, modePref, mode });
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo(
    () => ({ ...state, meta: getTheme(state.theme), themes: THEMES, setTheme, setModePref }),
    [state, setTheme, setModePref]
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
