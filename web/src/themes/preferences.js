// Where the viewer's theme and color-mode choice is kept.
// Storage keys and defaults must match the boot script in vite.config.js.

export const THEME_KEY = "multiplayer-ai:theme";
export const MODE_KEY = "multiplayer-ai:mode";
export const DEFAULT_THEME = "signal-room";
export const MODES = ["system", "light", "dark"];

// SEAM: user profile.
// Accounts don't exist yet, so preferences live in this browser's localStorage.
// When they do, replace `store` with an adapter that reads and writes the
// signed-in user's profile and falls back to localStorage when signed out.
// The adapter contract is { read() -> {theme, mode}, write({theme, mode}) }.
// Nothing outside this file knows where the values are kept.
const localStore = {
  read() {
    try {
      return { theme: localStorage.getItem(THEME_KEY), mode: localStorage.getItem(MODE_KEY) };
    } catch {
      return { theme: null, mode: null };
    }
  },
  write({ theme, mode }) {
    try {
      if (theme) localStorage.setItem(THEME_KEY, theme);
      if (mode) localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* private mode or blocked storage: the choice lasts for this page only */
    }
  }
};

let store = localStore;
export const setPreferenceStore = (next) => {
  store = next;
};

export const loadPreferences = () => store.read();
export const savePreferences = (prefs) => store.write(prefs);
