import { test, expect } from "./test-base.js";
import { THEMES } from "./helpers.js";
import { ROOM, roomState, mockApi, asReturning } from "./api-mocks.js";

// Every request a page makes to a host other than this app's own, at load: there must be none.
// The privacy text says nothing leaves the computer except the calls the server makes to the
// model provider you chose; the web app in the browser asks no one else for anything, not even
// for fonts (they are bundled). This test fails if a page starts talking to anything else, so
// that sentence cannot go stale.

const PAGES = [
  ["the landing page", "/"],
  ["start a room", "/new"],
  ["Setup", "/setup"],
  ["Settings", "/settings"],
  ["Your rooms", "/rooms"],
  ["the expired sign-in page", "/signin-expired"],
  ["a room", `/s/${ROOM}`]
];

const outsideOf = (page, own) => {
  const outside = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (["data:", "blob:", "about:"].includes(url.protocol)) return;
    if (url.host !== own) outside.push(`${url.host}${url.pathname} (${req.resourceType()})`);
  });
  return outside;
};

test.describe("requests to other hosts at load", () => {
  for (const [name, route] of PAGES) {
    test(`${name} (${route}) asks no other host for anything`, async ({ page, baseURL }) => {
      const outside = outsideOf(page, new URL(baseURL).host);
      await asReturning(page, { name: "Dana", token: "mpai_dana" });
      await mockApi(page, { onJoin: () => ({ json: roomState() }) });
      await page.route(/\/api\/(settings|status)/, (route) => route.fulfill({ status: 401, json: { error: "x", code: "ADMIN_LINK_NEEDED" } }));
      await page.goto(route, { waitUntil: "networkidle" });
      expect(outside, `${name} made requests to other hosts`).toEqual([]);
    });
  }
});

test("the landing page names each theme's fonts plainly", async ({ page }) => {
  await page.goto("/");
  const notes = page.locator("p", { hasText: "Type:" });
  await expect(notes.first()).toBeVisible();
  const text = (await notes.allTextContents()).join(" ");
  expect(text).toContain("Fraunces, Hanken Grotesk, Spline Sans Mono");
  expect(text).not.toMatch(/Variable/);
});

test.describe("fonts are bundled", () => {
  for (const theme of THEMES) {
    test(`${theme}: its fonts come from this app's own address and are really loaded`, async ({ page, baseURL }) => {
      const own = new URL(baseURL).host;
      const outside = outsideOf(page, own);
      const fontFiles = [];
      page.on("response", (res) => res.request().resourceType() === "font" && fontFiles.push(new URL(res.url()).host));
      await page.addInitScript((t) => localStorage.setItem("multiplayer-ai:theme", t), theme);
      await page.goto("/__fixture/room?as=Dev", { waitUntil: "networkidle" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const loaded = await page.evaluate(async () => {
        await document.fonts.ready;
        return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, ""));
      });
      expect(loaded.length, "at least one bundled font face was loaded").toBeGreaterThan(0);
      expect(loaded.every((f) => / Variable$/.test(f)), `only bundled families: ${loaded.join(", ")}`).toBe(true);
      expect(fontFiles.length).toBeGreaterThan(0);
      expect(fontFiles.every((h) => h === own), `font files came from ${[...new Set(fontFiles)].join(", ")}`).toBe(true);
      expect(outside).toEqual([]);
    });
  }

  test("with every other host blocked, switching themes still waits for the new fonts and then applies them", async ({ page, baseURL }) => {
    const own = new URL(baseURL).host;
    const blocked = [];
    await page.route((url) => url.host !== own && !["data:", "blob:", "about:"].includes(url.protocol), (route) => (blocked.push(route.request().url()), route.abort()));
    await page.goto("/__fixture/room?as=Dev", { waitUntil: "networkidle" });
    for (const [theme, label, family] of [["paper", "Paper", "Newsreader Variable"], ["horizon", "Horizon", "Plus Jakarta Sans Variable"], ["plain", "Plain", "Figtree Variable"], ["signal-room", "Signal Room", "Fraunces Variable"]]) {
      await page.getByRole("button", { name: "Theme" }).click();
      await page.getByRole("radio", { name: new RegExp(label, "i") }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      // By the time the theme is applied, its font is already usable: nothing reflows after the switch.
      const ready = await page.evaluate((f) => document.fonts.check(`400 1em "${f}"`) && document.fonts.check(`600 1em "${f}"`), family);
      expect(ready, `${family} was ready when ${theme} was applied`).toBe(true);
      await page.keyboard.press("Escape");
    }
    expect(blocked, "the page tried to reach another host").toEqual([]);
  });
});
