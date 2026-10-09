import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { THEMES, MODES, prime, stubFonts } from "./helpers.js";
import { ROOM, roomState, streamOf, mockApi, asReturning } from "./api-mocks.js";

// The ideas on the start screen: six buttons that fill the task box and send nothing.

async function expectNoViolations(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}
async function start(page) {
  await asReturning(page, { name: "Dana" });
  const calls = await mockApi(page, { onJoin: () => ({ json: roomState({ name: "Dana", role: "controller" }) }), stream: streamOf(roomState()), onTool: { create_session: () => ({ json: { session_id: ROOM, token: "mpai_c", you: { name: "Dana", role: "controller" } } }) } });
  await page.goto("/new");
  return calls;
}
const starters = (page) => page.getByRole("group", { name: "Or start from an idea" }).getByRole("button");

test("there are six ideas, each a button with its words on it", async ({ page }) => {
  await start(page);
  await expect(starters(page)).toHaveCount(6);
  for (const b of await starters(page).all()) expect((await b.textContent()).length).toBeGreaterThan(30);
});

test("choosing one fills the task box with exactly its words, moves focus there, and sends nothing", async ({ page }) => {
  const calls = await start(page);
  const first = starters(page).first();
  const text = await first.textContent();
  await first.click();
  const box = page.getByLabel("What should the agent work on?");
  await expect(box).toHaveValue(text);
  await expect(box).toBeFocused();
  expect(calls.tools.filter((c) => c.name === "create_session")).toEqual([]);
  await starters(page).nth(3).click();
  await expect(box).toHaveValue(await starters(page).nth(3).textContent());
});

test("the words can be changed before starting, and the room starts with the changed words", async ({ page }) => {
  const calls = await start(page);
  await starters(page).nth(1).click();
  await page.getByLabel("What should the agent work on?").pressSequentially(" Keep it short.");
  await page.getByRole("button", { name: "Start room" }).click();
  await expect.poll(() => calls.tools.filter((c) => c.name === "create_session").length).toBe(1);
  expect(calls.tools.find((c) => c.name === "create_session").body.task).toMatch(/ Keep it short\.$/);
});

test("from the keyboard: Tab to an idea, Enter fills the box", async ({ page }) => {
  await start(page);
  await starters(page).first().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("What should the agent work on?")).not.toHaveValue("");
});

test("at 360px the ideas fit", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await start(page);
  await expect(starters(page).last()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

for (const theme of THEMES) {
  for (const mode of MODES) {
    test(`axe: the start screen with ideas, in ${theme} · ${mode}`, async ({ page }) => {
      await stubFonts(page);
      await prime(page, { theme, mode });
      await start(page);
      await expect(starters(page)).toHaveCount(6);
      await expectNoViolations(page, `${theme}/${mode} start`);
      await starters(page).first().click();
      await expectNoViolations(page, `${theme}/${mode} start filled`);
    });
  }
}
