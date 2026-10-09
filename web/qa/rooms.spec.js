import { test, expect } from "./test-base.js";
import AxeBuilder from "@axe-core/playwright";
import { THEMES, MODES, prime, stubFonts } from "./helpers.js";
import { ROOM, NOW, mockApi, asReturning, sse } from "./api-mocks.js";

// "Your rooms" in the browser, against a mocked API: the list, rename, archive and unarchive, deleting one room behind
// typed words, the empty and error states, and who is shown the link. What the server does and who can reach it is covered
// by the server's tests.

async function expectNoViolations(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

const R = (n, over = {}) => ({ id: `${n}`.padStart(8, "0") + "-2222-4333-8444-555555555555", title: `Room ${n}`, created_at: NOW(), last_activity: NOW(), people: 2, state: "open", archived_by_host: false, step_count: 3, agent_working: false, ...over });

/** Answers the host routes for the list. `rooms` is the current list; every action returns the new list. */
async function roomsApi(page, { rooms = [R(1, { title: "Plan the launch" }), R(2, { title: "Rollback plan", state: "archived", people: 1 }), R(3, { title: "Old thing", state: "ended" })], listStatus = 200, listBody, deleteError } = {}) {
  const calls = [];
  const live = { rooms: [...rooms] };
  await page.route("**/api/host/rooms**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.postData() ? req.postDataJSON() : undefined;
    calls.push({ method: req.method(), path, body });
    if (req.method() === "GET") return route.fulfill({ status: listStatus, json: listBody ?? { rooms: live.rooms } });
    const id = path.split("/")[4];
    if (path.endsWith("/title")) live.rooms = live.rooms.map((r) => (r.id === id ? { ...r, title: body.title.trim() } : r));
    if (path.endsWith("/archive")) live.rooms = live.rooms.map((r) => (r.id === id ? { ...r, state: body.archived ? "archived" : "open", archived_by_host: body.archived } : r));
    if (path.endsWith("/delete")) {
      if (deleteError) return route.fulfill({ status: 409, json: deleteError });
      live.rooms = live.rooms.filter((r) => r.id !== id);
    }
    return route.fulfill({ json: { rooms: live.rooms } });
  });
  await page.route("**/api/status", (route) => route.fulfill({ json: { configured: true, sharing: false, host: true } }));
  return calls;
}

test("the list shows each room's title as a link, its last activity, how many people, and its state", async ({ page }) => {
  await roomsApi(page);
  await page.goto("/rooms");
  await expect(page.getByRole("heading", { name: "Your rooms" })).toBeVisible();
  const items = page.locator('[data-part="room-item"]');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0).getByRole("link", { name: "Plan the launch", exact: true })).toHaveAttribute("href", /\/s\/00000001-/);
  await expect(items.nth(0)).toContainText("2 people");
  await expect(items.nth(0)).toContainText("Open");
  await expect(items.nth(1)).toContainText("1 person");
  await expect(items.nth(1)).toContainText("Archived");
  await expect(items.nth(2)).toContainText("Ended");
  await expect(items.nth(0)).toContainText(/Last activity [A-Z][a-z]{2} \d{1,2}, \d{4}/);
});

test("a room archived by the host says so, and offers Unarchive", async ({ page }) => {
  await roomsApi(page, { rooms: [R(1, { title: "Mine", state: "archived", archived_by_host: true })] });
  await page.goto("/rooms");
  await expect(page.locator('[data-part="room-item"]')).toContainText("Archived by you");
  await expect(page.getByRole("button", { name: "Unarchive Mine" })).toBeVisible();
});

test("with no rooms it says so in plain words and offers to start one", async ({ page }) => {
  await roomsApi(page, { rooms: [] });
  await page.goto("/rooms");
  await expect(page.locator('[data-part="rooms-empty"]')).toContainText("No rooms yet. When you start one it will be listed here.");
  await expect(page.locator('[data-part="rooms-empty"]').getByRole("link", { name: "Start a room" })).toHaveAttribute("href", "/new");
});

test("without the sign-in cookie the page says how to get in, and shows no rooms", async ({ page }) => {
  await roomsApi(page, { listStatus: 401, listBody: { error: "x", code: "ADMIN_LINK_NEEDED" } });
  await page.goto("/rooms");
  await expect(page.getByText("Open Multiplayer AI from the terminal's link")).toBeVisible();
  await expect(page.getByText(/Setup, Settings and Your rooms open only from the link/)).toBeVisible();
  await expect(page.locator('[data-part="room-item"]')).toHaveCount(0);
});

test("on another computer it says the page works only where Multiplayer AI runs", async ({ page }) => {
  await roomsApi(page, { listStatus: 403, listBody: { error: "x", code: "ADMIN_LOCAL_ONLY" } });
  await page.goto("/rooms");
  await expect(page.getByText("Only on the computer running Multiplayer AI")).toBeVisible();
});

test("with Supabase storage it says the page isn't available", async ({ page }) => {
  await roomsApi(page, { listStatus: 409, listBody: { error: "x", code: "ROOMS_UNAVAILABLE" } });
  await page.goto("/rooms");
  await expect(page.getByText("Your rooms need the local data file")).toBeVisible();
});

test("a server that can't be reached says so, and Try again reloads", async ({ page }) => {
  await page.route("**/api/host/rooms**", (route) => route.abort());
  await page.goto("/rooms");
  await expect(page.getByText("Can't reach the server")).toBeVisible();
});

test("renaming sends the new title and shows it; markup in a title is shown as characters", async ({ page }) => {
  const calls = await roomsApi(page);
  await page.goto("/rooms");
  await page.getByRole("button", { name: "Rename Plan the launch" }).click();
  const field = page.getByLabel("New title for Plan the launch");
  await expect(field).toBeFocused();
  await field.fill("<img src=x onerror=alert(1)> Launch");
  await page.getByRole("button", { name: "Save title" }).click();
  await expect(page.getByRole("link", { name: "<img src=x onerror=alert(1)> Launch", exact: true })).toBeVisible();
  expect(await page.locator("img[src='x']").count()).toBe(0);
  expect(calls.find((c) => c.method === "PUT").body).toEqual({ title: "<img src=x onerror=alert(1)> Launch" });
  await expect(page.getByRole("status")).toContainText("Renamed to");
});

test("an empty title can't be saved, and Cancel changes nothing", async ({ page }) => {
  const calls = await roomsApi(page);
  await page.goto("/rooms");
  await page.getByRole("button", { name: "Rename Plan the launch" }).click();
  await page.getByLabel("New title for Plan the launch").fill("   ");
  await expect(page.getByRole("button", { name: "Save title" })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
});

test("archiving and unarchiving call the host's route and update the row", async ({ page }) => {
  const calls = await roomsApi(page);
  await page.goto("/rooms");
  await page.getByRole("button", { name: "Archive Plan the launch" }).click();
  await expect(page.getByRole("status")).toContainText("Archived Plan the launch.");
  await expect(page.locator('[data-part="room-item"]').first()).toContainText("Archived by you");
  await page.getByRole("button", { name: "Unarchive Plan the launch" }).click();
  await expect(page.getByRole("status")).toContainText("Unarchived Plan the launch.");
  expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ archived: true }, { archived: false }]);
});

test("deleting one room needs the words typed exactly, then removes only that room", async ({ page }) => {
  const calls = await roomsApi(page);
  await page.goto("/rooms");
  await page.getByRole("button", { name: "Delete Old thing" }).click();
  const confirm = page.getByLabel("Type “delete room” to confirm");
  await expect(confirm).toBeFocused();
  const go = page.getByRole("button", { name: "Delete this room" });
  await expect(go).toBeDisabled();
  await confirm.fill("delete");
  await expect(go).toBeDisabled();
  await confirm.fill("delete room");
  await expect(go).toBeEnabled();
  await go.click();
  await expect(page.getByRole("status")).toContainText("Deleted Old thing.");
  await expect(page.locator('[data-part="room-item"]')).toHaveCount(2);
  expect(calls.find((c) => c.path.endsWith("/delete")).body).toEqual({ confirm: "delete room" });
});

test("Keep it closes the delete form and nothing is sent", async ({ page }) => {
  const calls = await roomsApi(page);
  await page.goto("/rooms");
  await page.getByRole("button", { name: "Delete Old thing" }).click();
  await page.getByRole("button", { name: "Keep it" }).click();
  await expect(page.getByLabel("Type “delete room” to confirm")).toHaveCount(0);
  expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
});

test("a room whose agent is working can't be deleted, and the server's reason is shown", async ({ page }) => {
  await roomsApi(page, { rooms: [R(1, { title: "Busy", agent_working: true })], deleteError: { error: "The agent is replying in this room right now. Wait for it to finish, or stop it, then try again.", code: "AGENT_WORKING" } });
  await page.goto("/rooms");
  await expect(page.locator('[data-part="room-item"]')).toContainText("the agent is replying");
  await page.getByRole("button", { name: "Delete Busy" }).click();
  await page.getByLabel("Type “delete room” to confirm").fill("delete room");
  await page.getByRole("button", { name: "Delete this room" }).click();
  await expect(page.getByRole("alert")).toContainText("The agent is replying in this room right now.");
  await expect(page.locator('[data-part="room-item"]')).toHaveCount(1);
});

test("everything works from the keyboard alone", async ({ page }) => {
  await roomsApi(page);
  await page.goto("/rooms");
  await page.getByRole("button", { name: "Rename Plan the launch" }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Typed title");
  await page.keyboard.press("Enter"); // submits the form
  await expect(page.getByRole("link", { name: "Typed title", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete Rollback plan" }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByLabel("Type “delete room” to confirm")).toBeFocused();
  await page.keyboard.type("delete room");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("Deleted Rollback plan.");
});

test("the host sees the link in the room's header and on the landing page; a guest sees it nowhere", async ({ page }) => {
  await roomsApi(page);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Your rooms" })).toHaveAttribute("href", "/rooms");
  // A browser that is not the host's:
  await page.unroute("**/api/status");
  await page.route("**/api/status", (route) => route.fulfill({ json: { configured: true, sharing: false, host: false } }));
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Start a room" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Your rooms" })).toHaveCount(0);
});

test("in a room, the header has the link for the host only", async ({ page }) => {
  const state = { session: { id: ROOM, title: "T", task: "T", status: "active", step_count: 0, agent_working: false, files_enabled: true }, room: { state: "open", archive_after_days: 7, sharing: false }, participants: [{ session_id: ROOM, name: "Maya", role: "controller", last_seen: NOW(), is_host: true }], events: [{ id: 1, session_id: ROOM, kind: "join", author: "Maya", content: "x", created_at: NOW() }], you: { name: "Maya", role: "controller" } };
  await asReturning(page, { name: "Maya", token: "mpai_maya" });
  await mockApi(page, { onJoin: () => ({ json: state }), stream: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse({ type: "state", data: state }) }) });
  await page.route("**/api/status", (route) => route.fulfill({ json: { configured: true, sharing: false, host: true } }));
  await page.route("**/api/host/rooms/*", (route) => route.fulfill({ json: { room: { id: ROOM, title: "T" }, policy: "ask", counters: { guest_messages: 0, guest_cap: 20, room_steps: 0, room_cap: 50 }, pending: [], people: [], files: { available: false }, share: { link: "http://127.0.0.1:3737/x", qr_svg: null, sharing: false, needs_address: false, note: "x", warning: null } } }));
  await page.goto(`/s/${ROOM}`);
  await expect(page.getByRole("link", { name: "Your rooms" })).toHaveAttribute("href", "/rooms");
});

test("at 360px nothing scrolls sideways, with long titles and the delete form open", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await roomsApi(page, { rooms: [R(1, { title: "A".repeat(110) }), R(2, { title: "short" })] });
  await page.goto("/rooms");
  await page.getByRole("button", { name: /^Delete A/ }).click();
  await expect(page.getByLabel("Type “delete room” to confirm")).toBeVisible();
  const wide = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0).slice(0, 6).map((el) => `${el.tagName}.${String(el.className).slice(0, 30)} scroll=${el.scrollWidth} client=${el.clientWidth}`));
  expect(wide).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

for (const theme of THEMES) {
  for (const mode of MODES) {
    test(`axe: Your rooms with a rename form and a delete form open, in ${theme} · ${mode}`, async ({ page }) => {
      await stubFonts(page);
      await prime(page, { theme, mode });
      await roomsApi(page);
      await page.goto("/rooms");
      await expect(page.getByRole("heading", { name: "Your rooms" })).toBeVisible();
      await expectNoViolations(page, `${theme}/${mode} rooms`);
      await page.getByRole("button", { name: "Rename Plan the launch" }).click();
      await page.getByRole("button", { name: "Delete Old thing" }).click();
      await expect(page.getByLabel("Type “delete room” to confirm")).toBeVisible();
      await expectNoViolations(page, `${theme}/${mode} rooms with forms`);
    });
  }
}

test("with reduced motion nothing on the page animates", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await roomsApi(page);
  await page.goto("/rooms");
  await expect(page.getByRole("heading", { name: "Your rooms" })).toBeVisible();
  const animated = await page.evaluate(() => [...document.querySelectorAll("[data-part='rooms'], [data-part='rooms'] *")].filter((el) => getComputedStyle(el).animationName !== "none").length);
  expect(animated).toBe(0);
});
