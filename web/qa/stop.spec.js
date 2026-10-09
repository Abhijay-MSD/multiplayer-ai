import { test, expect } from "./test-base.js";
import AxeBuilder from "@axe-core/playwright";
import { THEMES, MODES, prime, stubFonts } from "./helpers.js";
import { ROOM, NOW, mockApi, asReturning, sse } from "./api-mocks.js";

// Stop and the usage lines, against a mocked API. What the server does when Stop is pressed is covered by the server's tests.

async function expectNoViolations(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

const person = (name, role, extra = {}) => ({ session_id: ROOM, name, role, last_seen: NOW(), is_host: false, ...extra });
const USED = "Used 2 model calls and 1 file tool call. Tokens: 30 in, 11 out.";
function roomFor(me, { controller = "Maya", working = true } = {}) {
  return {
    session: { id: ROOM, title: "Plan the launch", task: "Plan the launch", status: "active", step_count: 1, agent_working: working, control_policy: "ask", files_enabled: true },
    room: { state: "open", archive_after_days: 7, sharing: false, control_policy: "ask" },
    participants: [person("Maya", controller === "Maya" ? "controller" : "watcher", { is_host: true }), ...(me === "Maya" ? [] : [person(me, controller === me ? "controller" : "watcher")])],
    events: [
      { id: 1, session_id: ROOM, kind: "join", author: "Maya", content: "Maya created the session.", created_at: NOW() },
      { id: 2, session_id: ROOM, kind: "directive", author: "Maya", content: "Plan the launch", created_at: NOW() },
      { id: 3, session_id: ROOM, kind: "status", author: "system", content: "Created notes.md, 21 bytes", created_at: NOW() },
      { id: 4, session_id: ROOM, kind: "agent_message", author: "agent", content: "I wrote notes.md.", reply_to: 2, created_at: NOW() },
      { id: 5, session_id: ROOM, kind: "status", author: "system", content: USED, created_at: NOW() },
      { id: 6, session_id: ROOM, kind: "status", author: "system", content: "Stopped by Maya", created_at: NOW() }
    ],
    you: { name: me, role: controller === me ? "controller" : "watcher" }
  };
}
const streamFor = (state) => () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse({ type: "state", data: state }) });

async function stopRoom(page, { me = "Maya", controller = "Maya", host = false, working = true, stopResult = { stopped: true, dropped: 0 }, counters } = {}) {
  const state = roomFor(me, { controller, working });
  const calls = [];
  await asReturning(page, { name: me, token: "mpai_" + me.toLowerCase() });
  await mockApi(page, { onJoin: () => ({ json: state }), stream: streamFor(state), onTool: { stop_agent: (body) => (calls.push(body), typeof stopResult === "function" ? stopResult() : { json: stopResult }) } });
  await page.route("**/api/status", (route) => route.fulfill({ json: { configured: true, sharing: false, host } }));
  await page.route("**/api/host/**", (route) =>
    route.fulfill({ json: { room: { id: ROOM, title: "x" }, policy: "ask", counters: counters ?? { guest_messages: 0, guest_cap: 20, room_steps: 1, room_cap: 50, model_calls: 7, model_call_cap: 200 }, pending: [], people: [{ name: "Maya", role: "controller", is_host: true, last_seen: NOW() }], files: { available: true, enabled: true, count: 0, bytes: 0, limits: { maxFileBytes: 204800, maxFiles: 50, maxTotalBytes: 2097152 } }, share: { link: "http://127.0.0.1:3737/x", qr_svg: null, sharing: false, needs_address: false, note: "x", warning: null } } })
  );
  return calls;
}

test("the controller sees Stop while the agent is working, and pressing it asks the server to stop with their token", async ({ page }) => {
  const calls = await stopRoom(page, { me: "Maya", controller: "Maya", host: true });
  await page.goto(`/s/${ROOM}`);
  const stop = page.getByRole("button", { name: "Stop the agent" });
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(page.getByText("Stopping the agent.")).toBeVisible();
  expect(calls).toEqual([{ session_id: ROOM, token: "mpai_maya" }]);
});

test("Stop is not offered when the agent is idle", async ({ page }) => {
  await stopRoom(page, { me: "Maya", controller: "Maya", host: true, working: false });
  await page.goto(`/s/${ROOM}`);
  await expect(page.getByRole("textbox", { name: /Message the agent/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop the agent" })).toHaveCount(0);
});

test("a guest who isn't steering never sees Stop", async ({ page }) => {
  await stopRoom(page, { me: "Dana", controller: "Maya", host: false });
  await page.goto(`/s/${ROOM}`);
  await expect(page.getByRole("textbox", { name: /Comment to the room|Message/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop the agent" })).toHaveCount(0);
});

test("a guest who holds control can stop it, as the controller", async ({ page }) => {
  await stopRoom(page, { me: "Dana", controller: "Dana", host: false });
  await page.goto(`/s/${ROOM}`);
  await expect(page.getByRole("button", { name: "Stop the agent" })).toBeVisible();
});

test("the host sees Stop even when someone else is steering", async ({ page }) => {
  await stopRoom(page, { me: "Maya", controller: "Dana", host: true });
  await page.goto(`/s/${ROOM}`);
  await expect(page.getByRole("button", { name: "Stop the agent" })).toBeVisible();
});

test("if nothing was running by the time Stop arrived, it says so in plain words", async ({ page }) => {
  await stopRoom(page, { stopResult: { stopped: false, dropped: 0 }, host: true });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: "Stop the agent" }).click();
  await expect(page.getByText("The agent isn't working right now.")).toBeVisible();
});

test("a refused Stop shows the server's words", async ({ page }) => {
  await stopRoom(page, { stopResult: () => ({ status: 403, json: { error: "Only the controller or the host can stop the agent.", code: "NOT_ALLOWED" } }), host: true });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: "Stop the agent" }).click();
  await expect(page.getByText("Only the controller or the host can stop the agent.")).toBeVisible();
});

test("Stop works from the keyboard alone", async ({ page }) => {
  const calls = await stopRoom(page, { host: true });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: "Stop the agent" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Stopping the agent.")).toBeVisible();
  expect(calls.length).toBe(1);
});

test("the usage line and the stop line are quiet lines in the conversation, in the room's own words", async ({ page }) => {
  await stopRoom(page, { host: true, working: false });
  await page.goto(`/s/${ROOM}`);
  const lines = page.locator('[data-kind="system"]');
  await expect(lines.filter({ hasText: USED })).toHaveCount(1);
  await expect(lines.filter({ hasText: "Stopped by Maya" })).toHaveCount(1);
});

test("the host's panel shows the room's model calls against their cap", async ({ page }) => {
  await stopRoom(page, { host: true, working: false });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: "Host controls" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Model calls: 7 of 200" })).toBeVisible();
});

test("at 360px the Stop row fits", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await stopRoom(page, { host: true });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: "Stop the agent" }).click();
  await expect(page.getByText("Stopping the agent.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

for (const theme of THEMES) {
  for (const mode of MODES) {
    test(`axe: the composer with Stop showing, in ${theme} · ${mode}`, async ({ page }) => {
      await stubFonts(page);
      await prime(page, { theme, mode });
      await stopRoom(page, { host: true });
      await page.goto(`/s/${ROOM}`);
      await page.getByRole("button", { name: "Stop the agent" }).click();
      await expect(page.getByText("Stopping the agent.")).toBeVisible();
      await expectNoViolations(page, `${theme}/${mode} stop`);
    });
  }
}
