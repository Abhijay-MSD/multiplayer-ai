import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { THEMES, MODES, prime, stubFonts } from "./helpers.js";
import { ROOM, NOW, mockApi, asReturning, sse } from "./api-mocks.js";

// Retry, the keyboard shortcuts, Copy on a message and searching the conversation, in the browser, against a mocked API.
// What the server does when a message is sent again is covered by the server's tests.

async function expectNoViolations(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

const AGENT_TEXT = "Here is the plan:\n\n```js\nconsole.log('hi')\n```\n\nThat is all.";
const person = (name, role, extra = {}) => ({ session_id: ROOM, name, role, last_seen: NOW(), is_host: false, ...extra });
function roomFor(me, { controller = "Maya", working = false, extraEvents = [] } = {}) {
  return {
    session: { id: ROOM, title: "Plan the launch", task: "Plan the launch", status: "active", step_count: 1, agent_working: working, control_policy: "ask" },
    room: { state: "open", archive_after_days: 7, sharing: false, control_policy: "ask" },
    participants: [person("Maya", controller === "Maya" ? "controller" : "watcher", { is_host: true }), ...(me === "Maya" ? [] : [person(me, controller === me ? "controller" : "watcher")])],
    events: [
      { id: 1, session_id: ROOM, kind: "join", author: "Maya", content: "Maya created the session.", created_at: NOW() },
      { id: 2, session_id: ROOM, kind: "directive", author: "Maya", content: "Plan the launch", created_at: NOW() },
      { id: 3, session_id: ROOM, kind: "agent_message", author: "agent", content: AGENT_TEXT, reply_to: 2, created_at: NOW() },
      { id: 4, session_id: ROOM, kind: "comment", author: "Dana", content: "Shouldn't we wait for <b>legal</b>?", created_at: NOW() },
      { id: 5, session_id: ROOM, kind: "status", author: "system", content: "Created notes.md, 21 bytes", created_at: NOW() },
      ...extraEvents
    ],
    you: { name: me, role: controller === me ? "controller" : "watcher" }
  };
}
async function room(page, { me = "Maya", controller = "Maya", working = false, onTool = {}, extraEvents } = {}) {
  const state = roomFor(me, { controller, working, extraEvents });
  const calls = [];
  await asReturning(page, { name: me, token: "mpai_" + me.toLowerCase() });
  await mockApi(page, { onJoin: () => ({ json: state }), stream: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse({ type: "state", data: state }) }), onTool: { ...onTool, retry_last: (b) => (calls.push(["retry_last", b]), onTool.retry_last ? onTool.retry_last(b) : { json: { event: { id: 99 } } }), send_directive: (b) => (calls.push(["send_directive", b]), { json: { event: { id: 98 } } }), send_comment: (b) => (calls.push(["send_comment", b]), { json: { event: { id: 97 } } }) } });
  await page.route("**/api/status", (r) => r.fulfill({ json: { configured: true, sharing: false, host: false } }));
  return calls;
}

// ── retry ─────────────────────────────────────────────────────────────

test("the controller can send their last message again; the server is asked with their token", async ({ page }) => {
  const calls = await room(page);
  await page.goto(`/s/${ROOM}`);
  const retry = page.getByRole("button", { name: "Send my last message again" });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect.poll(() => calls.filter((c) => c[0] === "retry_last").length).toBe(1);
  expect(calls.find((c) => c[0] === "retry_last")[1]).toEqual({ session_id: ROOM, token: "mpai_maya" });
});

test("it is off while the agent is working", async ({ page }) => {
  await room(page, { working: true });
  await page.goto(`/s/${ROOM}`);
  await expect(page.getByRole("button", { name: "Send my last message again" })).toBeDisabled();
});

test("someone who isn't the controller doesn't get it", async ({ page }) => {
  await room(page, { me: "Dana", controller: "Maya" });
  await page.goto(`/s/${ROOM}`);
  await expect(page.getByRole("textbox", { name: /Comment to the room|Message/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send my last message again" })).toHaveCount(0);
});

test("a refusal from the server is shown in words", async ({ page }) => {
  await room(page, { onTool: { retry_last: () => ({ status: 409, json: { error: "The agent is working. Wait for it to finish, or stop it, then try again.", code: "AGENT_WORKING" } }) } });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: "Send my last message again" }).click();
  await expect(page.getByRole("alert")).toContainText("The agent is working.");
});

// ── shortcuts ─────────────────────────────────────────────────────────

test("Enter, Ctrl+Enter and Cmd+Enter send a message; Shift+Enter adds a line and sends nothing", async ({ page }) => {
  const calls = await room(page);
  await page.goto(`/s/${ROOM}`);
  const box = page.getByRole("textbox", { name: /Message the agent/ });
  await box.fill("first");
  await box.press("Shift+Enter");
  await box.pressSequentially("second line");
  await expect(box).toHaveValue("first\nsecond line");
  expect(calls.filter((c) => c[0] === "send_directive")).toEqual([]);
  await box.press("Control+Enter");
  await expect.poll(() => calls.filter((c) => c[0] === "send_directive").length).toBe(1);
  expect(calls.find((c) => c[0] === "send_directive")[1].content).toBe("first\nsecond line");
  await expect(box).toHaveValue(""); // the box is emptied once the message has gone
  await box.fill("third");
  await box.press("Meta+Enter");
  await expect.poll(() => calls.filter((c) => c[0] === "send_directive").length).toBe(2);
  await expect(box).toHaveValue("");
  await box.fill("fourth");
  await box.press("Enter");
  await expect.poll(() => calls.filter((c) => c[0] === "send_directive").length).toBe(3);
});

test("Ctrl+Enter sends a comment too, when commenting", async ({ page }) => {
  const calls = await room(page);
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("radio", { name: "Comment" }).click();
  const box = page.getByRole("textbox", { name: /Comment to the room/ });
  await box.fill("a comment");
  await box.press("Control+Enter");
  await expect.poll(() => calls.filter((c) => c[0] === "send_comment").length).toBe(1);
});

test("a shortcut with an empty box sends nothing", async ({ page }) => {
  const calls = await room(page);
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("textbox", { name: /Message the agent/ }).press("Control+Enter");
  await page.waitForTimeout(150);
  expect(calls.filter((c) => c[0] === "send_directive")).toEqual([]);
});

test("Escape closes the host's panel, the people drawer, and clears a search", async ({ page }) => {
  await room(page);
  await page.goto(`/s/${ROOM}`);
  const search = page.getByRole("searchbox", { name: "Search the conversation" });
  await search.fill("plan");
  await expect(page.getByRole("status").filter({ hasText: /match/ })).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveValue("");
});

// ── copy ──────────────────────────────────────────────────────────────

test("every message has a Copy that puts its own text on the clipboard; the agent's reply is copied as the Markdown it wrote", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await room(page);
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: "Copy message from agent" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(AGENT_TEXT);
  await expect(page.getByRole("status").filter({ hasText: "Copied to the clipboard." })).toHaveCount(1);
  await page.getByRole("button", { name: "Copy message from Dana" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Shouldn't we wait for <b>legal</b>?");
  await page.getByRole("button", { name: "Copy message from Maya" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Plan the launch");
});

test("when the clipboard can't be used the message says so", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("no")) }, configurable: true });
    document.execCommand = () => false;
  });
  await room(page);
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: "Copy message from Maya" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Couldn't copy. Select the text and copy it yourself." })).toHaveCount(1);
});

// ── search ────────────────────────────────────────────────────────────

test("search keeps the messages that hold the words, in order, says how many, and clears", async ({ page }) => {
  await room(page);
  await page.goto(`/s/${ROOM}`);
  const search = page.getByRole("searchbox", { name: "Search the conversation" });
  await search.fill("PLAN");
  await expect(page.locator('[data-part="transcript-tools"]').getByRole("status")).toHaveText("2 of 5 messages match.");
  await expect(page.locator('[data-part="entry"]')).toHaveCount(2);
  await expect(page.getByText("Shouldn't we wait")).toHaveCount(0);
  await expect(page.locator('[data-part="reply-to"]')).toContainText("Replying to Maya", { timeout: 2000 });
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.locator('[data-part="entry"]')).toHaveCount(5);
});

test("search looks at who said it as well as what", async ({ page }) => {
  await room(page);
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("searchbox", { name: "Search the conversation" }).fill("dana");
  await expect(page.locator('[data-part="entry"]')).toHaveCount(1);
});

test("no match says so, in the conversation and in the count", async ({ page }) => {
  await room(page);
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("searchbox", { name: "Search the conversation" }).fill("zzzz-nothing");
  await expect(page.locator('[data-part="empty-title"]')).toHaveText("No messages match.");
  await expect(page.locator('[data-part="transcript-tools"]').getByRole("status")).toHaveText("No messages match.");
});

test("a search is only ever compared with the text: markup typed into it, or found in a message, is not made into elements", async ({ page }) => {
  let dialog = false;
  page.on("dialog", (d) => ((dialog = true), d.dismiss()));
  await room(page, { extraEvents: [{ id: 6, session_id: ROOM, kind: "comment", author: "Dana", content: "<img src=x onerror=alert(1)> look", created_at: NOW() }] });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("searchbox", { name: "Search the conversation" }).fill("<img src=x onerror=alert(1)>");
  await expect(page.locator('[data-part="entry"]')).toHaveCount(1);
  expect(await page.locator("img[src='x']").count()).toBe(0);
  await expect(page.locator('[data-part="comment-body"]')).toHaveText("<img src=x onerror=alert(1)> look");
  expect(dialog).toBe(false);
});

test("a long search term and regular-expression characters are plain text", async ({ page }) => {
  await room(page);
  await page.goto(`/s/${ROOM}`);
  const search = page.getByRole("searchbox", { name: "Search the conversation" });
  await search.fill("(.*)[");
  await expect(page.locator('[data-part="empty-title"]')).toHaveText("No messages match.");
  await search.fill("x".repeat(500));
  expect(await search.inputValue()).toHaveLength(200);
});

test("at 360px the tools row, the copy buttons and the retry button fit", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await room(page);
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("searchbox", { name: "Search the conversation" }).fill("plan");
  await expect(page.getByRole("button", { name: "Send my last message again" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

for (const theme of THEMES) {
  for (const mode of MODES) {
    test(`axe: search, copy buttons and retry, in ${theme} · ${mode}`, async ({ page }) => {
      await stubFonts(page);
      await prime(page, { theme, mode });
      await room(page);
      await page.goto(`/s/${ROOM}`);
      await expect(page.getByRole("button", { name: "Send my last message again" })).toBeVisible();
      await expectNoViolations(page, `${theme}/${mode} room`);
      await page.getByRole("searchbox", { name: "Search the conversation" }).fill("plan");
      await expectNoViolations(page, `${theme}/${mode} room with a search`);
    });
  }
}
