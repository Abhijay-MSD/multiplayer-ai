import { test, expect } from "./test-base.js";
import AxeBuilder from "@axe-core/playwright";
import { THEMES, MODES, prime, stubFonts } from "./helpers.js";
import { ROOM, NOW, mockApi, asReturning, sse } from "./api-mocks.js";

// The room brief in the browser, against a mocked API: everyone in the room sees it above the conversation, the host edits it in
// Host controls, and it is only ever text. What the server does with it, and who may set it, is covered by the server's tests.

async function expectNoViolations(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

const LONG = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long brief that keeps going so that it has to be cut.`).join("\n");

function roomFor(me, brief) {
  return {
    session: { id: ROOM, title: "Plan the launch", task: "Plan the launch", status: "active", step_count: 1, agent_working: false, control_policy: "ask", files_enabled: true, ...(brief === undefined ? {} : { brief }) },
    room: { state: "open", archive_after_days: 7, sharing: false, control_policy: "ask" },
    participants: [{ session_id: ROOM, name: "Maya", role: "controller", last_seen: NOW(), is_host: true }, ...(me === "Maya" ? [] : [{ session_id: ROOM, name: me, role: "watcher", last_seen: NOW(), is_host: false }])],
    events: [
      { id: 1, session_id: ROOM, kind: "join", author: "Maya", content: "Maya created the session.", created_at: NOW() },
      { id: 2, session_id: ROOM, kind: "status", author: "system", content: "The host set the room brief.", created_at: NOW() }
    ],
    you: { name: me, role: me === "Maya" ? "controller" : "watcher" }
  };
}

async function briefRoom(page, { me = "Dana", host = false, brief = "Answer in short sentences.\nNo emoji.", panelBrief } = {}) {
  const state = roomFor(me, brief);
  const calls = [];
  await asReturning(page, { name: me, token: "mpai_" + me.toLowerCase() });
  await mockApi(page, { onJoin: () => ({ json: state }), stream: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse({ type: "state", data: state }) }) });
  await page.route("**/api/status", (route) => route.fulfill({ json: { configured: true, sharing: false, host } }));
  let current = panelBrief === undefined ? brief : panelBrief;
  const panel = () => ({ room: { id: ROOM, title: "x" }, policy: "ask", counters: { guest_messages: 0, guest_cap: 20, room_steps: 1, room_cap: 50 }, pending: [], people: [{ name: "Maya", role: "controller", is_host: true, last_seen: NOW() }], ...(current === null ? {} : { brief: current }), files: { available: false }, share: { link: "http://127.0.0.1:3737/x", qr_svg: null, sharing: false, needs_address: false, note: "x", warning: null } });
  await page.route("**/api/host/rooms/**", async (route) => {
    const req = route.request();
    if (req.method() === "PUT" && new URL(req.url()).pathname.endsWith("/brief")) {
      const body = req.postDataJSON();
      calls.push(body);
      if (body.brief.includes("TOOLONG")) return route.fulfill({ status: 400, json: { error: "A brief can be up to 1500 characters.", code: "BRIEF_TOO_LONG" } });
      current = body.brief.trim();
    }
    return route.fulfill({ json: panel() });
  });
  return calls;
}

test("everyone in the room sees the brief above the conversation, as plain text", async ({ page }) => {
  await briefRoom(page, { me: "Dana", brief: "<img src=x onerror=alert(1)> Answer in short sentences.\nNo emoji." });
  await page.goto(`/s/${ROOM}`);
  const brief = page.locator('[data-part="room-brief"]');
  await expect(brief).toBeVisible();
  await expect(brief).toContainText("Brief from the host");
  await expect(brief).toContainText("<img src=x onerror=alert(1)> Answer in short sentences.");
  expect(await page.locator("img[src='x']").count()).toBe(0);
  await expect(page.getByRole("button", { name: "Show all" })).toHaveCount(0);
});

test("a room with no brief shows nothing for it", async ({ page }) => {
  await briefRoom(page, { me: "Dana", brief: "" });
  await page.goto(`/s/${ROOM}`);
  await expect(page.getByRole("textbox", { name: /Comment to the room|Message/ })).toBeVisible();
  await expect(page.locator('[data-part="room-brief"]')).toHaveCount(0);
});

test("a long brief is cut to a few lines, never hidden, and Show all opens the rest", async ({ page }) => {
  await briefRoom(page, { me: "Dana", brief: LONG });
  await page.goto(`/s/${ROOM}`);
  const text = page.locator('[data-part="room-brief"] p');
  await expect(text).toBeVisible();
  const clamped = await text.evaluate((el) => el.getBoundingClientRect().height);
  await page.getByRole("button", { name: "Show all" }).click();
  await expect(page.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  expect(await text.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(clamped * 2);
  await expect(text).toContainText("Line 12 of a long brief");
  await page.getByRole("button", { name: "Show less" }).click();
  expect(await text.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(clamped + 1);
});

test("the host edits it in Host controls: Save sends the text, the counter counts characters, Clear empties it", async ({ page }) => {
  const calls = await briefRoom(page, { me: "Maya", host: true, brief: "Old brief." });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: "Host controls" }).click();
  const box = page.getByLabel("Brief (up to 1500 characters)");
  await expect(box).toHaveValue("Old brief.");
  const save = page.getByRole("button", { name: "Save brief" });
  await expect(save).toBeDisabled();
  await box.fill("😀 New brief\nsecond line");
  await expect(page.getByText("23 of 1500")).toBeVisible();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();
  expect(calls).toEqual([{ brief: "😀 New brief\nsecond line" }]);
  await page.getByRole("button", { name: "Clear brief" }).click();
  await expect(box).toHaveValue("");
  expect(calls.at(-1)).toEqual({ brief: "" });
});

test("a refusal from the server is shown in words and the text stays in the box", async ({ page }) => {
  await briefRoom(page, { me: "Maya", host: true, brief: "" });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: "Host controls" }).click();
  await page.getByLabel("Brief (up to 1500 characters)").fill("TOOLONG text");
  await page.getByRole("button", { name: "Save brief" }).click();
  await expect(page.getByRole("alert")).toContainText("A brief can be up to 1500 characters.");
  await expect(page.getByLabel("Brief (up to 1500 characters)")).toHaveValue("TOOLONG text");
});

test("with Supabase storage (no brief in the panel) the host panel has no brief section", async ({ page }) => {
  await briefRoom(page, { me: "Maya", host: true, brief: "", panelBrief: null });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: "Host controls" }).click();
  await expect(page.getByRole("heading", { name: "Host controls" })).toBeVisible();
  await expect(page.getByLabel("Brief (up to 1500 characters)")).toHaveCount(0);
});

test("a guest has no way to edit it: no panel, no button, only the text", async ({ page }) => {
  await briefRoom(page, { me: "Dana", host: false });
  await page.goto(`/s/${ROOM}`);
  await expect(page.locator('[data-part="room-brief"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Host controls" })).toHaveCount(0);
  await expect(page.getByLabel("Brief (up to 1500 characters)")).toHaveCount(0);
});

test("from the keyboard: Show all with Enter, and the host's box and buttons in order", async ({ page }) => {
  await briefRoom(page, { me: "Maya", host: true, brief: LONG });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: "Show all" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Show less" })).toBeFocused();
  await page.getByRole("button", { name: "Host controls" }).focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("Brief (up to 1500 characters)").focus();
  await page.keyboard.press("End");
  await page.keyboard.type(" Added.");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Save brief" })).toBeFocused();
});

test("at 360px a long brief and the host's box fit", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await briefRoom(page, { me: "Maya", host: true, brief: "x".repeat(300) + " " + "y".repeat(120) });
  await page.goto(`/s/${ROOM}`);
  await expect(page.locator('[data-part="room-brief"]')).toBeVisible();
  await page.getByRole("button", { name: "Host controls" }).click();
  await expect(page.getByLabel("Brief (up to 1500 characters)")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

for (const theme of THEMES) {
  for (const mode of MODES) {
    test(`axe: the brief above the conversation, and the host's brief box, in ${theme} · ${mode}`, async ({ page }) => {
      await stubFonts(page);
      await prime(page, { theme, mode });
      await briefRoom(page, { me: "Maya", host: true, brief: LONG });
      await page.goto(`/s/${ROOM}`);
      await expect(page.locator('[data-part="room-brief"]')).toBeVisible();
      await expectNoViolations(page, `${theme}/${mode} brief`);
      await page.getByRole("button", { name: "Host controls" }).click();
      await expect(page.getByLabel("Brief (up to 1500 characters)")).toBeVisible();
      await expectNoViolations(page, `${theme}/${mode} host brief`);
    });
  }
}
