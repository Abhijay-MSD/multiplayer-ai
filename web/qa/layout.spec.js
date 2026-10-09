import { test, expect, openPage } from "./test-base.js";
import { THEMES, MODES, prime, settle } from "./helpers.js";

// Every screen with a made-up room, in every theme and both modes, at 1440, 768 and 360 wide: nothing may make the page scroll
// sideways, and nothing important may be cut off at the edges. (Contrast and rules are checked by axe in the other specs.)

const WIDTHS = [1440, 768, 360];
const SURFACES = [
  ["the room", "/__fixture/room?as=Dev"],
  ["the room as a watcher", "/__fixture/room?as=Maya"],
  ["the room with a brief and files", "/__fixture/room?as=Dev&brief=1&files=1"],
  ["the Files tab", "/__fixture/room?as=Dev&files=1&tab=files&host=1"],
  ["Your rooms", "/__fixture/rooms"],
  ["the name screen", "/__fixture/name"]
];

for (const width of WIDTHS) {
  for (const theme of THEMES) {
    for (const mode of MODES) {
      for (const [label, url] of SURFACES) {
        test(`${label} · ${theme} · ${mode} · ${width}px has no sideways scroll`, async ({ browser }) => {
          const { page, done } = await openPage(browser, { viewport: { width, height: 900 }, reducedMotion: "reduce" });
          await prime(page, { theme, mode });
          await page.goto(url);
          await settle(page);
          const wide = await page.evaluate(() => {
            const w = document.documentElement.clientWidth;
            return {
              page: document.documentElement.scrollWidth - w,
              off: [...document.querySelectorAll("body *")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > w + 1 && !el.closest("[data-part='transcript'], pre, .md-table, [role='region']"); }).slice(0, 4).map((el) => `${el.tagName}.${String(el.className).slice(0, 30)}`)
            };
          });
          expect(wide.page, `sideways overflow ${JSON.stringify(wide.off)}`).toBeLessThanOrEqual(0);
          await done();
        });
      }
    }
  }
}
