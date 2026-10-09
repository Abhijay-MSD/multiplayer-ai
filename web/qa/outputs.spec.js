import { test, expect } from "./test-base.js";
import fs from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { THEMES, MODES, prime, stubFonts } from "./helpers.js";
import { ROOM, NOW, mockApi, asReturning, sse } from "./api-mocks.js";

// Outputs: Copy and Download on the agent's code blocks, and a per-room Outputs tab, against a mocked API.
// Everything a model writes is untrusted: names and contents must stay text, and sizes are bounded.

async function expectNoViolations(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

const fence = (info, body) => "```" + info + "\n" + body + "\n```";
const agent = (id, content) => ({ id, session_id: ROOM, kind: "agent_message", author: "agent", content, reply_to: 2, created_at: NOW() });

function stateWith(...replies) {
  return {
    session: { id: ROOM, title: "Plan the launch", task: "Plan the launch", status: "active", step_count: 1, agent_working: false },
    participants: [
      { session_id: ROOM, name: "Maya", role: "controller", last_seen: NOW() },
      { session_id: ROOM, name: "Dana", role: "watcher", last_seen: NOW() }
    ],
    events: [
      { id: 1, session_id: ROOM, kind: "join", author: "Maya", content: "Maya created the session.", created_at: NOW() },
      { id: 2, session_id: ROOM, kind: "directive", author: "Maya", content: "Write it", created_at: NOW() },
      ...replies
    ],
    you: { name: "Dana", role: "watcher" }
  };
}

async function openRoom(page, state, { path = `/s/${ROOM}` } = {}) {
  await asReturning(page, { name: "Dana", token: "mpai_dana" });
  await mockApi(page, {
    onJoin: () => ({ json: state }),
    stream: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse({ type: "state", data: state }) })
  });
  await page.goto(path);
  await expect(page.getByText("Write it").first()).toBeVisible();
}

const CODE = "def hello():\n    return 'hi'\n";

test("a code block in an agent reply can be copied and downloaded under a safe name", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openRoom(page, stateWith(agent(3, `Here:\n\n${fence("main.py", CODE)}`)));
  const block = page.locator('[data-part="code-block"]').first();
  await expect(block).toContainText("def hello()");
  await block.getByRole("button", { name: "Copy main.py" }).click();
  await expect(block.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CODE);

  const [download] = await Promise.all([page.waitForEvent("download"), block.getByRole("button", { name: "Download main.py" }).click()]);
  expect(download.suggestedFilename()).toBe("main.py");
  expect(fs.readFileSync(await download.path(), "utf8")).toBe(CODE);
});

test("a block with no name gets one from its language and position; a download is always plain text", async ({ page }) => {
  await page.addInitScript(() => {
    window.__blobTypes = [];
    const make = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => (window.__blobTypes.push(blob.type), make(blob));
  });
  await openRoom(page, stateWith(agent(3, fence("html", "<h1>hi</h1><script>window.__ran=1</script>"))));
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /^Download output-3-1/ }).first().click()]);
  expect(download.suggestedFilename()).toBe("output-3-1.html.txt");
  expect(await page.evaluate(() => window.__blobTypes)).toEqual(["text/plain;charset=utf-8"]);
  expect(await page.evaluate(() => window.__ran)).toBeUndefined();
});

test("a hostile file name in the fence is cut down to a safe one, and shown as text", async ({ page }) => {
  await page.addInitScript(() => (window.__p = 0));
  const evil = '../../x"><img src=x onerror=window.__p=1>.html';
  await openRoom(page, stateWith(agent(3, fence(evil, "plain"))));
  const block = page.locator('[data-part="code-block"]').first();
  const label = await block.locator('[data-part="code-name"]').textContent();
  expect(label).toMatch(/^[A-Za-z0-9._-]+$/);
  const [download] = await Promise.all([page.waitForEvent("download"), block.getByRole("button", { name: /^Download / }).click()]);
  expect(download.suggestedFilename()).toMatch(/^[A-Za-z0-9._-]+$/);
  expect(download.suggestedFilename()).not.toMatch(/\.\./);
  expect(await page.evaluate(() => window.__p)).toBe(0);
  expect(await block.locator("img").count()).toBe(0);
});

test("markup inside a code block, and around it, stays text", async ({ page }) => {
  await page.addInitScript(() => (window.__xss = 0));
  const payload = '<script>window.__xss=1</script></code></pre><img src=x onerror="window.__xss=2">';
  await openRoom(page, stateWith(agent(3, `${fence("html", payload)}\n\n<img src=x onerror="window.__xss=3"> and **bold**`)));
  await expect(page.locator('[data-part="code-block"] pre').first()).toContainText(payload);
  await page.getByRole("tab", { name: /^Outputs/ }).click();
  await expect(page.locator('[data-part="outputs"]')).toContainText("<script>window.__xss=1</script>");
  expect(await page.evaluate(() => window.__xss)).toBe(0);
  expect(await page.locator('[data-part="room"] img').count()).toBe(0);
});

test("the Outputs tab appears only when there is something in it", async ({ page }) => {
  await openRoom(page, stateWith(agent(3, "No code here.")));
  await expect(page.getByRole("tab")).toHaveCount(0);
});

test("the Outputs tab lists code blocks newest first, with copy and download for each, and the conversation is kept", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openRoom(page, stateWith(agent(3, fence("py", "first")), agent(4, "text only"), agent(5, `${fence("js", "second")}\n\n${fence("json", "third")}`)));
  const tab = page.getByRole("tab", { name: "Outputs (3)" });
  await expect(tab).toBeVisible();
  await expect(page.getByRole("tab", { name: "Conversation" })).toHaveAttribute("aria-selected", "true");
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const items = page.locator('[data-part="outputs"] [data-part="output-item"]');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText("second");
  await expect(items.nth(1)).toContainText("third");
  await expect(items.nth(2)).toContainText("first");
  await expect(items.nth(0)).toContainText("output-5-1.js");
  await expect(items.nth(0)).toContainText("agent");
  await items.nth(2).getByRole("button", { name: /^Copy / }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("first");
  const [download] = await Promise.all([page.waitForEvent("download"), items.nth(1).getByRole("button", { name: /^Download / }).click()]);
  expect(download.suggestedFilename()).toBe("output-5-2.json");
  await page.getByRole("tab", { name: "Conversation" }).click();
  await expect(page.locator('[data-part="transcript"]')).toBeVisible();
});

test("the tabs work from the keyboard", async ({ page }) => {
  await openRoom(page, stateWith(agent(3, fence("py", "x"))));
  await page.getByRole("tab", { name: "Conversation" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /^Outputs/ })).toBeFocused();
  await expect(page.getByRole("tab", { name: /^Outputs/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Tab");
  await expect(page.locator('[data-part="outputs"]').getByRole("button", { name: /^Copy / }).first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Conversation" })).toHaveAttribute("aria-selected", "true");
});

test("a block over the size limit is shown but cannot be copied or downloaded, and says why", async ({ page }) => {
  const big = "x".repeat(1_000_001);
  await openRoom(page, stateWith(agent(3, fence("txt", big))));
  const block = page.locator('[data-part="code-block"]').first();
  await expect(block.getByRole("button", { name: /^Copy / })).toBeDisabled();
  await expect(block.getByRole("button", { name: /^Download / })).toBeDisabled();
  await expect(block).toContainText("Too large to copy or download here");
  await page.getByRole("tab", { name: /^Outputs/ }).click();
  const item = page.locator('[data-part="output-item"]').first();
  await expect(item).toContainText("Too large to copy or download here");
  expect((await item.innerText()).length, "the list holds a preview, not the whole block").toBeLessThan(2000);
});

test("many blocks: only the newest 200 are listed, the true total is said, and the page stays quick", async ({ page }) => {
  const replies = Array.from({ length: 450 }, (_, i) => agent(i + 3, fence("txt", `block ${i + 1}`)));
  await openRoom(page, stateWith(...replies));
  await expect(page.getByRole("tab", { name: "Outputs (450)" })).toBeVisible();
  const started = Date.now();
  await page.getByRole("tab", { name: /^Outputs/ }).click();
  await expect(page.locator('[data-part="output-item"]')).toHaveCount(200);
  expect(Date.now() - started).toBeLessThan(4000);
  await expect(page.locator('[data-part="outputs"]')).toContainText("Showing the newest 200 of 450.");
  await expect(page.locator('[data-part="output-item"]').first()).toContainText("block 450");
  await expect(page.locator('[data-part="output-item"]').last()).toContainText("block 251");
});

test("one reply with thousands of blocks does not hang the page", async ({ page }) => {
  const body = Array.from({ length: 3000 }, (_, i) => fence("txt", `b${i}`)).join("\n");
  await openRoom(page, stateWith(agent(3, body)));
  await page.getByRole("tab", { name: /^Outputs/ }).click();
  await expect(page.locator('[data-part="output-item"]')).toHaveCount(200);
  await expect(page.locator('[data-part="outputs"]')).toContainText("of 3000.");
});

test("360px: nothing scrolls sideways with the tab open or a wide block in the conversation", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const wide = "x".repeat(400);
  await openRoom(page, stateWith(agent(3, fence("main.py", wide)), agent(4, fence("a-very-long-file-name-for-the-sake-of-the-test.config.json", wide))));
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await fits()).toBe(0);
  await page.getByRole("tab", { name: /^Outputs/ }).click();
  await expect(page.locator('[data-part="output-item"]').first()).toBeVisible();
  expect(await fits()).toBe(0);
});

for (const theme of THEMES) {
  for (const mode of MODES) {
    test(`axe: code blocks and the Outputs tab · ${theme} · ${mode}`, async ({ page }) => {
      await stubFonts(page);
      await prime(page, { theme, mode });
      await openRoom(page, stateWith(agent(3, `Here:\n\n${fence("main.py", CODE)}\n\n${fence("", "plain text")}`), agent(4, fence("txt", "x".repeat(1_000_001)))));
      await expectNoViolations(page, `conversation · ${theme} · ${mode}`);
      await page.getByRole("tab", { name: /^Outputs/ }).click();
      await expect(page.locator('[data-part="output-item"]').first()).toBeVisible();
      await expectNoViolations(page, `outputs · ${theme} · ${mode}`);
    });
  }
}
