// Every folder in src/themes with a theme.json is a theme. The CSS in each
// folder (tokens.css, structure.css) is pulled in here, so adding a theme is a
// new folder and nothing else. Fonts are not part of the bundle: see fonts.js.
import { DEFAULT_THEME } from "./preferences";

const manifests = import.meta.glob("./*/theme.json", { eager: true, import: "default" });
import.meta.glob("./*/*.css", { eager: true });

export const THEMES = Object.values(manifests).sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

export const getTheme = (id) => THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME);
