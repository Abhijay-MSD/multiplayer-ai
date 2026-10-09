import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Every folder under src/themes with a theme.json.
export const THEMES = fs
  .readdirSync(path.join(here, "../src/themes"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(here, "../src/themes", d.name, "theme.json")))
  .map((d) => JSON.parse(fs.readFileSync(path.join(here, "../src/themes", d.name, "theme.json"), "utf8")))
  .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
  .map((t) => t.id);

export const MODES = ["light", "dark"];
export const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 }
];

// Stores the viewer's choice before the page loads, as a returning viewer would have.
export async function prime(page, { theme, mode }) {
  await page.addInitScript(
    ([t, m]) => {
      localStorage.setItem("multiplayer-ai:theme", t);
      localStorage.setItem("multiplayer-ai:mode", m);
    },
    [theme, mode]
  );
}

export async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

// A test run writes its screenshots to an untracked folder, so running the tests
// never changes a file in git. The tracked set in qa/screenshots is replaced only
// by the explicit command: npm run qa:update-screenshots (from web/).
export const UPDATING_SCREENSHOTS = process.env.UPDATE_SCREENSHOTS === "1";
export const SCREENSHOT_DIR = UPDATING_SCREENSHOTS ? path.join(here, "screenshots") : path.join(here, ".results", "screenshots");

// The fonts are bundled with the app and served from its own address, so a test that depends on
// timing depends on how fast those files arrive. This controls that.
//   delayMs 0 (default): the font files are refused, so every theme lays out in its fallback fonts
//     and nothing arrives late. Deterministic.
//   delayMs > 0: the font files arrive after that long. For showing what a slow disk does.
export async function stubFonts(page, { delayMs = 0 } = {}) {
  await page.route(/\.woff2?(\?|$)/, async (route) => {
    if (!delayMs) return route.abort();
    await new Promise((r) => setTimeout(r, delayMs));
    await route.continue();
  });
}
