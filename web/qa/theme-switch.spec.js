import { test, expect, openPage } from "./test-base.js";
import { THEMES, MODES, prime, settle, stubFonts } from "./helpers.js";

// Switching themes must not flash the wrong theme, and must not move things
// that should stay put.

test.describe("no flash of the wrong theme", () => {
  for (const theme of THEMES) {
    for (const mode of MODES) {
      test(`first frame · ${theme} · ${mode}`, async ({ browser }) => {
        const { page, done } = await openPage(browser, { reducedMotion: "reduce" });
        await prime(page, { theme, mode });
        // Runs before any page script. Records every change to the theme
        // attributes with its time, and the time of the first paint.
        await page.addInitScript(() => {
          window.__mut = [];
          window.__firstPaint = null;
          new MutationObserver((list) => {
            for (const m of list) window.__mut.push({ t: performance.now(), attr: m.attributeName });
          }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-theme", "data-mode"] });
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) if (e.name === "first-paint") window.__firstPaint = e.startTime;
          }).observe({ type: "paint", buffered: true });
        });
        await page.goto("/__fixture/room?as=Dev");
        await settle(page);
        const flash = await page.evaluate(() => {
          const root = document.documentElement;
          const cs = getComputedStyle(root);
          return {
            mut: window.__mut,
            firstPaint: window.__firstPaint,
            theme: root.getAttribute("data-theme"),
            mode: root.getAttribute("data-mode"),
            bg: cs.getPropertyValue("--bg").trim(),
            colorScheme: cs.colorScheme
          };
        });
        expect(flash.firstPaint, "a first paint was recorded").not.toBeNull();
        expect(flash.theme).toBe(theme);
        expect(flash.mode).toBe(mode);
        expect(flash.colorScheme).toBe(mode);
        expect(flash.bg, "tokens are applied").not.toBe("");
        const late = flash.mut.filter((m) => m.t > flash.firstPaint);
        expect(late, "theme attributes changed after the first paint").toEqual([]);
        await done();
      });
    }
  }

  test("system mode follows the operating system on first frame", async ({ browser }) => {
    for (const scheme of ["light", "dark"]) {
      const { page, done } = await openPage(browser, { colorScheme: scheme, reducedMotion: "reduce" });
      await page.goto("/__fixture/room?as=Dev");
      await expect(page.locator("html")).toHaveAttribute("data-mode", scheme);
      await expect(page.locator("html")).toHaveAttribute("data-mode-pref", "system");
      await done();
    }
  });
});

test.describe("switching at runtime", () => {
  test("no layout shift once the new theme is applied, and the switcher stays put", async ({ page }) => {
    // Fonts come from Google Fonts. The switcher waits up to 1.2s for a theme's fonts and then
    // applies it, so a slow answer means a late reflow that has nothing to do with the layout
    // under test (checked: with the real fonts delayed 2.5s, 1 to 3 shifts appear). The
    // request is answered here instead, so the result does not depend on the network.
    await stubFonts(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/__fixture/room?as=Dev");
    await settle(page);

    await page.evaluate(() => {
      window.__shifts = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__shifts.push(e.value);
      }).observe({ type: "layout-shift", buffered: false });
    });

    const trigger = page.getByRole("button", { name: "Theme" });
    const box = async () => trigger.boundingBox();
    const before = await box();

    for (const theme of [...THEMES, THEMES[0]]) {
      await trigger.click();
      await page.getByRole("radio", { name: new RegExp(`^.*${theme === "signal-room" ? "Signal Room" : theme}`, "i") }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.keyboard.press("Escape");
      // The switch itself is a deliberate layout change. After it, nothing may move.
      await page.waitForTimeout(150);
      await page.evaluate(() => (window.__shifts.length = 0));
      await page.waitForTimeout(1500);
      const shifts = await page.evaluate(() => window.__shifts);
      expect(shifts, `unexpected layout shift after switching to ${theme}`).toEqual([]);

      const after = await box();
      expect(after.width).toBeCloseTo(before.width, 0);
      expect(after.height).toBeCloseTo(before.height, 0);
      expect(after.x + after.width, "switcher's right edge").toBeLessThanOrEqual(1440);

      // The reader stays at the end of the transcript.
      const nearBottom = await page.evaluate(() => {
        const el = document.querySelector('[data-part="transcript"]');
        return el.scrollHeight - el.scrollTop - el.clientHeight;
      });
      expect(nearBottom).toBeLessThan(150);
    }
  });

  test("the choice is remembered and reapplied on reload", async ({ page }) => {
    await page.goto("/__fixture/room?as=Dev");
    await page.getByRole("button", { name: "Theme" }).click();
    await page.getByRole("radio", { name: /Paper/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
    await page.getByRole("radio", { name: "Dark" }).click();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
    await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  });

  test("the switcher works from the keyboard", async ({ page }) => {
    await page.goto("/__fixture/room?as=Dev");
    const trigger = page.getByRole("button", { name: "Theme" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Appearance" })).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("html")).toHaveAttribute("data-theme", THEMES[1]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
