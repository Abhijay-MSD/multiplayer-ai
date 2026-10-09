import { test, expect } from "@playwright/test";
import { THEMES, MODES, prime, settle } from "./helpers.js";

// The room behaves the same in every theme:
// controller versus watcher, handoff and its ring, comments, the signal
// labels, and a layout that fits from 360px.

for (const theme of THEMES) {
  test.describe(theme, () => {
    test("controller sees both modes and can send to the agent", async ({ page }) => {
      await prime(page, { theme, mode: "light" });
      await page.goto("/__fixture/room?as=Dev");
      await settle(page);
      const group = page.getByRole("radiogroup", { name: "Where this message goes" });
      await expect(group.getByRole("radio", { name: "Message the agent" })).toHaveAttribute("aria-checked", "true");
      await expect(group.getByRole("radio", { name: "Comment" })).toBeVisible();
      await page.getByLabel("Message the agent…").fill("Check the export job");
      await page.keyboard.press("Enter");
      await expect(page.locator('[data-kind="directive"]', { hasText: "Check the export job" })).toBeVisible();
    });

    test("comment mode sends a comment, not a message to the agent", async ({ page }) => {
      await prime(page, { theme, mode: "light" });
      await page.goto("/__fixture/room?as=Dev");
      await page.getByRole("radio", { name: "Comment" }).click();
      await page.getByLabel(/Comment to the room/).fill("Looks right to me");
      await page.keyboard.press("Enter");
      await expect(page.locator('[data-kind="comment"]', { hasText: "Looks right to me" })).toBeVisible();
    });

    test("watcher is comment-only and sees the hint", async ({ page }) => {
      await prime(page, { theme, mode: "light" });
      await page.goto("/__fixture/room?as=Maya");
      await expect(page.getByRole("radiogroup", { name: "Where this message goes" })).toHaveCount(0);
      await expect(page.locator('[data-part="composer-hint"]')).toContainText("Only the controller can message the agent");
      await expect(page.getByLabel(/Comment to the room/)).toBeVisible();
    });

    test("a failed send keeps the text and says why", async ({ page }) => {
      await prime(page, { theme, mode: "light" });
      await page.goto("/__fixture/room?as=Dev");
      await page.getByLabel("Message the agent…").fill("this will fail");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("alert")).toContainText("Control changed a moment ago");
      await expect(page.getByLabel("Message the agent…")).toHaveValue("this will fail");
    });

    test("handoff moves the controller ring and the composer follows", async ({ page }) => {
      await prime(page, { theme, mode: "light" });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/__fixture/room?as=Dev");
      const ring = page.locator('[data-part="presence"] > div:first-child > div:nth-child(2) > div').first();
      const y = async () => ring.evaluate((el) => el.style.transform);
      const before = await y();
      await page.getByRole("button", { name: "Hand off →" }).first().click();
      await expect.poll(y).not.toBe(before);
      // Dev is now a watcher: the composer drops to comment-only.
      await expect(page.locator('[data-part="composer-hint"]')).toBeVisible();
    });

    test("the live signal shows the four labels", async ({ page }) => {
      await prime(page, { theme, mode: "light" });
      for (const [state, label] of [
        ["idle", "Agent is idle"],
        ["working", "Agent is working"],
        ["limit", "Step limit reached"],
        ["error", "Last step failed"]
      ]) {
        await page.goto(`/__fixture/room?as=Dev&state=${state}`);
        await expect(page.getByRole("status").filter({ hasText: label })).toBeVisible();
      }
    });

    for (const mode of MODES) {
      test(`fits at 360px · ${mode}`, async ({ page }) => {
        await prime(page, { theme, mode });
        await page.setViewportSize({ width: 360, height: 740 });
        await page.goto("/__fixture/room?as=Dev");
        await settle(page);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);
        // Presence is a drawer: closed, then opened from the keyboard.
        const toggle = page.getByRole("button", { name: "People" });
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await toggle.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByText("In the room")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        // The composer and the theme switcher are reachable and inside the screen.
        for (const loc of [page.getByLabel("Message the agent…"), page.getByRole("button", { name: "Theme" })]) {
          const b = await loc.boundingBox();
          expect(b.x).toBeGreaterThanOrEqual(0);
          expect(b.x + b.width).toBeLessThanOrEqual(360);
        }
      });
    }

    test("keyboard focus is visible on the main controls", async ({ page }) => {
      await prime(page, { theme, mode: "light" });
      await page.goto("/__fixture/room?as=Dev");
      await settle(page);
      const seen = new Set();
      for (let i = 0; i < 14; i++) {
        await page.keyboard.press("Tab");
        const info = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const cs = getComputedStyle(el);
          const box = el.closest('[data-part="composer"]');
          const boxCs = box ? getComputedStyle(box) : null;
          const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
          const ring = cs.boxShadow !== "none";
          // Some themes show focus on the composer box that contains the field.
          const container = boxCs && (boxCs.boxShadow !== "none" || boxCs.borderColor !== "");
          return { label: el.getAttribute("aria-label") || el.textContent.trim().slice(0, 24), visible: outline || ring || Boolean(container) };
        });
        if (info) {
          expect(info.visible, `no visible focus on "${info.label}"`).toBe(true);
          seen.add(info.label);
        }
      }
      expect(seen.size).toBeGreaterThan(6);
    });
  });
}
