import { test, expect, openPage } from "./test-base.js";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import { THEMES, MODES, VIEWPORTS, prime, settle, SCREENSHOT_DIR } from "./helpers.js";

// The room, the name-capture screen and the landing page, in every theme, both
// modes and both widths. Each page is screenshotted and checked with axe.
// The landing page always uses Signal Room (themes apply to the app only), so
// it is captured once per mode and width, and a separate check confirms a
// stored theme does not change it.

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const SURFACES = [
  { name: "room", path: "/__fixture/room?as=Dev" },
  { name: "name", path: "/__fixture/name" },
  { name: "files", path: "/__fixture/room?as=Dev&files=1&tab=files&host=1" },
  { name: "rooms", path: "/__fixture/rooms" },
  { name: "brief", path: "/__fixture/room?as=Dev&brief=1" }
];

async function expectNoViolations(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

for (const theme of THEMES) {
  for (const mode of MODES) {
    for (const vp of VIEWPORTS) {
      for (const surface of SURFACES) {
        test(`${surface.name} · ${theme} · ${mode} · ${vp.name}`, async ({ browser }) => {
          const { context, page } = await openPage(browser, { viewport: { width: vp.width, height: vp.height }, reducedMotion: "reduce" });
          await prime(page, { theme, mode });
          await page.goto(surface.path);
          await settle(page);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
          await page.screenshot({ path: `${SCREENSHOT_DIR}/${surface.name}-${theme}-${mode}-${vp.name}.png` });
          await expectNoViolations(page, `${surface.name}/${theme}/${mode}/${vp.name}`);
          await context.close();
        });
      }
    }
  }
}

for (const mode of MODES) {
  for (const vp of VIEWPORTS) {
    test(`landing · signal-room · ${mode} · ${vp.name}`, async ({ browser }) => {
      const { context, page } = await openPage(browser, { viewport: { width: vp.width, height: vp.height }, reducedMotion: "reduce" });
      // A stored theme from the app must not change the landing page.
      await prime(page, { theme: "horizon", mode });
      await page.goto("/");
      await settle(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", "signal-room");
      await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
      // Load the lazy screenshots before capturing and checking.
      await page.evaluate(async () => {
        await Promise.all([...document.images].map((i) => (i.loading = "eager", i.decode().catch(() => {}))));
      });
      await page.screenshot({ path: `${SCREENSHOT_DIR}/landing-signal-room-${mode}-${vp.name}.png`, fullPage: true });
      await expectNoViolations(page, `landing/${mode}/${vp.name}`);
      await context.close();
    });
  }
}

// Other states of the room, 1440 wide: contrast and rules only, no screenshots.
const STATES = [
  ["watcher", "/__fixture/room?as=Maya"],
  ["working", "/__fixture/room?as=Dev&state=working"],
  ["step limit", "/__fixture/room?as=Dev&state=limit"],
  ["failed step", "/__fixture/room?as=Dev&state=error"],
  ["empty", "/__fixture/room?as=Dev&empty=1"],
  ["error screen", "/__fixture/error"],
  ["loading screen", "/__fixture/loading"]
];
for (const theme of THEMES) {
  for (const mode of MODES) {
    for (const [label, url] of STATES) {
      test(`state ${label} · ${theme} · ${mode}`, async ({ browser }) => {
        const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
        await prime(page, { theme, mode });
        await page.goto(url);
        await settle(page);
        await expectNoViolations(page, `${label}/${theme}/${mode}`);
        await context.close();
      });
    }
  }
}
