import { test, expect } from "./test-base.js";
import AxeBuilder from "@axe-core/playwright";
import { ROOM, NOW, mockApi, asReturning, sse } from "./api-mocks.js";

// "The reply reached its length limit" and the Continue button, against a mocked API. What the server does with the message the
// button sends (who may send it, what it costs) is covered by the server's tests.

const LINE = "The reply reached its length limit";
const person = (name, role, extra = {}) => ({ session_id: ROOM, name, role, last_seen: NOW(), is_host: false, ...extra });
function roomFor(me, { controller = "Maya", working = false, after = [] } = {}) {
  return {
    session: { id: ROOM, title: "Write about tea", task: "Write about tea", status: "active", step_count: 1, agent_working: working, control_policy: "ask", files_enabled: false },
    room: { state: "open", archive_after_days: 7, sharing: false, control_policy: "ask" },
    participants: [person("Maya", controller === "Maya" ? "controller" : "watcher"), ...(me === "Maya" ? [] : [person(me, controller === me ? "controller" : "watcher")])],
    events: [
      { id: 1, session_id: ROOM, kind: "join", author: "Maya", content: "Maya created the session.", created_at: NOW() },
      { id: 2, session_id: ROOM, kind: "directive", author: "Maya", content: "Write 5000 words about tea", created_at: NOW() },
      { id: 3, session_id: ROOM, kind: "agent_message", author: "agent", content: "Tea began in…", reply_to: 2, created_at: NOW() },
      { id: 4, session_id: ROOM, kind: "status", author: "system", content: LINE, created_at: NOW() },
      { id: 5, session_id: ROOM, kind: "status", author: "system", content: "Used 1 model call. Tokens: 30 in, 11 out.", created_at: NOW() },
      ...after
    ],
    you: { name: me, role: controller === me ? "controller" : "watcher" }
  };
}

async function open(page, { me = "Maya", controller = "Maya", working = false, after = [], sendResult } = {}) {
  const state = roomFor(me, { controller, working, after });
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

test("the controller sees the line with a Continue button, and pressing it sends the message, with their token, as any message", async ({ page }) => {
  const calls = await open(page);
  await expect(page.getByText(LINE)).toBeVisible();
  const button = page.getByRole("button", { name: "Continue", exact: true });
  await expect(button).toBeVisible();
  await button.click();
  await expect.poll(() => sent(calls)).toEqual([{ session_id: ROOM, token: "mpai_maya", content: "Continue from where you stopped" }]);
});

test("a guest who is not steering sees the line and no button", async ({ page }) => {
  const calls = await open(page, { me: "Dana", controller: "Maya" });
  await expect(page.getByText(LINE)).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  expect(sent(calls)).toEqual([]);
});

test("a guest who holds control gets the button, as the controller", async ({ page }) => {
  await open(page, { me: "Dana", controller: "Dana" });
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
});

test("no button while the agent is working, and none once something has been said to the agent since", async ({ page }) => {
  await open(page, { working: true });
  await expect(page.getByText(LINE)).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
});

test("a message after the line, Continue included, takes the button away", async ({ page }) => {
  await open(page, { after: [{ id: 6, session_id: ROOM, kind: "directive", author: "Maya", content: "Continue from where you stopped", created_at: NOW() }] });
  await expect(page.getByText(LINE)).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
});

test("only the latest line has the button", async ({ page }) => {
  await open(page, { after: [
    { id: 6, session_id: ROOM, kind: "directive", author: "Maya", content: "Continue from where you stopped", created_at: NOW() },
    { id: 7, session_id: ROOM, kind: "agent_message", author: "agent", content: "…and so on.", reply_to: 6, created_at: NOW() },
    { id: 8, session_id: ROOM, kind: "status", author: "system", content: LINE, created_at: NOW() }
  ] });
  await expect(page.getByText(LINE)).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(1);
});

test("a message the server refuses shows the server's words next to the button, and the button comes back", async ({ page }) => {
  await open(page, { sendResult: () => ({ status: 403, json: { error: "Only the controller (Maya) can message the agent.", code: "NOT_CONTROLLER" } }) });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Only the controller (Maya) can message the agent." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
});

test("the line and its button pass the accessibility checks", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
});
