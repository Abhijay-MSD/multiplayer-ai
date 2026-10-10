import { test, expect } from "./test-base.js";
import AxeBuilder from "@axe-core/playwright";
import { THEMES, MODES, prime, stubFonts } from "./helpers.js";
import { ROOM, mockApi, asReturning, sse } from "./api-mocks.js";

// The Continue button on "The model provider is limiting how fast this key can be used. Try again in about N seconds.", against a
// mocked API and a clock the test moves. What the server does with the message the button sends (who may send it, what it costs)
// is covered by the server's tests.

const T0 = Date.parse("2026-10-21T07:00:00.000Z");
const FAST = (n) => `Agent could not reply: The model provider is limiting how fast this key can be used. Try again in about ${n} ${n === 1 ? "second" : "seconds"}.`;
const SLOW = "Agent could not reply: The model provider is limiting this key. Check the provider's console for the limit, then try again.";
const person = (name, role, extra = {}) => ({ session_id: ROOM, name, role, last_seen: new Date(T0).toISOString(), is_host: false, ...extra });
const ago = (ms) => new Date(T0 - ms).toISOString();

function roomFor(me, { controller = "Maya", line = FAST(30), writtenAgo = 0, after = [] } = {}) {
  return {
    session: { id: ROOM, title: "A long report", task: "A long report", status: "active", step_count: 0, agent_working: false, control_policy: "ask", files_enabled: false },
    room: { state: "open", archive_after_days: 7, sharing: false, control_policy: "ask" },
    participants: [person("Maya", controller === "Maya" ? "controller" : "watcher"), ...(me === "Maya" ? [] : [person(me, controller === me ? "controller" : "watcher")])],
    events: [
      { id: 1, session_id: ROOM, kind: "join", author: "Maya", content: "Maya created the session.", created_at: ago(60_000) },
      { id: 2, session_id: ROOM, kind: "directive", author: "Maya", content: "Write a long report", created_at: ago(40_000) },
      { id: 3, session_id: ROOM, kind: "status", author: "system", content: line, created_at: ago(writtenAgo) },
      ...after
    ],
    you: { name: me, role: controller === me ? "controller" : "watcher" }
  };
}

async function open(page, { me = "Maya", sendResult, theme, mode, ...roomOptions } = {}) {
  await page.clock.install({ time: T0 });
  await stubFonts(page);
  if (theme) await prime(page, { theme, mode });
  const state = roomFor(me, roomOptions);
  await asReturning(page, { name: me, token: "mpai_" + me.toLowerCase() });
  const calls = await mockApi(page, {
    onJoin: () => ({ json: state }),
    stream: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse({ type: "state", data: state }) }),
    onTool: { send_directive: () => sendResult?.() ?? { json: { event: { id: 99 } } } }
  });
  await page.route("**/api/status", (route) => route.fulfill({ json: { configured: true, sharing: false, host: false } }));
  await page.goto(`/s/${ROOM}`);
  return calls;
}
const sent = (calls) => calls.tools.filter((c) => c.name === "send_directive").map((c) => c.body);
const button = (page) => page.getByRole("button", { name: "Continue", exact: true });
const live = (page) => page.locator("[aria-live], [role=status]").filter({ hasText: /continue now/i });

test("the controller sees the line and a Continue button that waits out the provider's 30 seconds, then sends the message", async ({ page }) => {
  const calls = await open(page);
  await expect(page.getByText(FAST(30))).toBeVisible();
  await expect(button(page)).toBeVisible();
  await expect(button(page)).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator('[data-part="continue-countdown"]')).toHaveText("30");
  await button(page).click({ force: true });
  expect(sent(calls), "pressing it early does nothing").toEqual([]);

  await page.clock.runFor(12_000);
  await expect(page.locator('[data-part="continue-countdown"]')).toHaveText("18");
  await expect(button(page)).toHaveAttribute("aria-disabled", "true");

  await page.clock.runFor(18_000);
  await expect(page.locator('[data-part="continue-countdown"]')).toHaveCount(0);
  await expect(button(page)).not.toHaveAttribute("aria-disabled", "true");
  await button(page).click();
  await expect.poll(() => sent(calls)).toEqual([{ session_id: ROOM, token: "mpai_maya", content: "Continue from where you stopped" }]);
});

test("the wait is counted from when the line was written, not from when the page opened", async ({ page }) => {
  await open(page, { writtenAgo: 10_000 });
  await expect(page.locator('[data-part="continue-countdown"]')).toHaveText("20");
  await page.clock.runFor(20_000);
  await expect(button(page)).not.toHaveAttribute("aria-disabled", "true");
});

test("a wait that is already over leaves the button ready, and a clock behind the server's does not make it longer", async ({ page }) => {
  await open(page, { writtenAgo: 90_000 });
  await expect(button(page)).toBeVisible();
  await expect(button(page)).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.locator('[data-part="continue-countdown"]')).toHaveCount(0);
});

test("a wait of one second says second, and the longer sentence has the button with no countdown", async ({ page }) => {
  await open(page, { line: FAST(1) });
  await expect(page.getByText(FAST(1))).toBeVisible();
  await expect(page.locator('[data-part="continue-countdown"]')).toHaveText("1");
});

test("the longer sentence, which sends the host to the provider's console, has the button ready at once", async ({ page }) => {
  const calls = await open(page, { line: SLOW });
  await expect(page.getByText(SLOW)).toBeVisible();
  await expect(button(page)).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.locator('[data-part="continue-countdown"]')).toHaveCount(0);
  await button(page).click();
  await expect.poll(() => sent(calls).length).toBe(1);
});

test("a guest who is not steering sees the line and never the button, and nothing is sent", async ({ page }) => {
  const calls = await open(page, { me: "Dana", controller: "Maya" });
  await expect(page.getByText(FAST(30))).toBeVisible();
  await expect(button(page)).toHaveCount(0);
  await page.clock.runFor(60_000);
  await expect(button(page)).toHaveCount(0);
  expect(sent(calls)).toEqual([]);
});

test("a guest who holds control is the controller: they get the button", async ({ page }) => {
  await open(page, { me: "Dana", controller: "Dana" });
  await expect(button(page)).toBeVisible();
});

test("once a message has been sent after the line, the button is gone", async ({ page }) => {
  await open(page, { after: [{ id: 4, session_id: ROOM, kind: "directive", author: "Maya", content: "Continue from where you stopped", created_at: ago(0) }] });
  await expect(page.getByText(FAST(30))).toBeVisible();
  await expect(button(page)).toHaveCount(0);
});

test("a failure that is not a rate limit has no Continue button", async ({ page }) => {
  await open(page, { line: "Agent could not reply: The model provider is busy right now. Try again in a moment." });
  await expect(page.getByText(/provider is busy/)).toBeVisible();
  await expect(button(page)).toHaveCount(0);
});

test("a message the server refuses shows the server's words, and the button stays", async ({ page }) => {
  await open(page, { writtenAgo: 60_000, sendResult: () => ({ status: 403, json: { error: "Only the controller (Maya) can message the agent.", code: "NOT_CONTROLLER" } }) });
  await button(page).click();
  await expect(page.getByRole("alert").filter({ hasText: "Only the controller (Maya) can message the agent." })).toBeVisible();
  await expect(button(page)).toBeVisible();
});

test("with the keyboard: Tab reaches it, Enter does nothing while it waits, and Enter or Space sends once it is ready", async ({ page }) => {
  const calls = await open(page);
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await button(page).evaluate((el) => el === document.activeElement);
  }
  expect(reached, "Tab reaches the button even while it waits").toBe(true);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  expect(sent(calls)).toEqual([]);
  await page.clock.runFor(30_000);
  await expect(button(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => sent(calls).length).toBe(1);
});

test("Space sends it too, once it is ready", async ({ page }) => {
  const calls = await open(page, { writtenAgo: 60_000 });
  await button(page).focus();
  await page.keyboard.press("Space");
  await expect.poll(() => sent(calls).length).toBe(1);
});

test("a screen reader is told the wait once, in words, and told when it is over; the seconds are not read out one by one", async ({ page }) => {
  await open(page);
  await expect(button(page)).toHaveAccessibleDescription(/available in about 30 seconds/i);
  await expect(page.locator('[data-part="continue-countdown"]')).toHaveAttribute("aria-hidden", "true");
  await expect(live(page)).toHaveCount(0);
  const regions = page.locator("[aria-live]");
  const before = await regions.evaluateAll((els) => els.map((e) => e.textContent));
  await page.clock.runFor(10_000);
  await page.clock.runFor(10_000);
  expect(await regions.evaluateAll((els) => els.map((e) => e.textContent)), "nothing in a live region changes while it counts").toEqual(before);
  await page.clock.runFor(10_000);
  await expect(page.locator("[aria-live]").filter({ hasText: "You can continue now." })).toHaveCount(1);
  await expect(button(page)).not.toHaveAccessibleDescription(/available in about/i);
});

test("the countdown respects prefers-reduced-motion: its bar moves smoothly only when motion is welcome", async ({ page }) => {
  await open(page);
  const bar = page.locator('[data-part="continue-bar"] > span');
  await expect(bar).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await bar.evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
  expect(reduced, "no visible transition").toBeLessThan(0.01);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await bar.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("1s");
});

async function expectNoViolations(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

for (const theme of THEMES) {
  for (const mode of MODES) {
    test(`axe: the line and the button, waiting and ready, in ${theme} ${mode}`, async ({ page }) => {
      await open(page, { theme, mode });
      await expect(page.locator('[data-part="continue-countdown"]')).toHaveText("30");
      await expectNoViolations(page, `${theme} ${mode}, waiting`);
      await page.clock.runFor(30_000);
      await expect(button(page)).not.toHaveAttribute("aria-disabled", "true");
      await expectNoViolations(page, `${theme} ${mode}, ready`);
    });
  }
}

test.describe("at 360px wide", () => {
  test.use({ viewport: { width: 360, height: 740 } });
  for (const theme of THEMES) {
    test(`${theme}: the line wraps, the button is in view and big enough, and nothing scrolls sideways`, async ({ page }) => {
      await open(page, { theme, mode: "light" });
      await expect(button(page)).toBeVisible();
      const box = await button(page).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(360);
      expect(box.height, "a target of at least 24px").toBeGreaterThanOrEqual(24);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expectNoViolations(page, `${theme} at 360px`);
    });
  }
});
