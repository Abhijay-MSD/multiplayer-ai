import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { THEMES, MODES, prime } from "./helpers.js";
import { ROOM, NOW, roomState, streamOf, mockApi, asReturning } from "./api-mocks.js";

// Starting a room, joining one, and every way either can fail, against a
// mocked API. Each screen is also checked with axe. The server's side of these
// (codes, statuses, archiving) is covered by the server's tests.

async function expectNoViolations(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

const created = (over = {}) => ({
  json: { session_id: ROOM, token: "mpai_creator", you: { name: "Dana", role: "controller" }, title: "Plan the launch", auto_start: true, ...over }
});
const asController = () => roomState({ name: "Dana", role: "controller" });
const reply = (status, code, error, extra = {}) => ({ status, json: { error, code, ...extra } });

const fillStart = async (page, { task = "Plan the launch", name } = {}) => {
  await page.getByLabel("What should the agent work on?").fill(task);
  if (name !== undefined) await page.getByLabel("Your name").fill(name);
};

// ── Start a room ────────────────────────────────────────────────────

test("/new: needs a task and a name, prefills the remembered name, and creates the room with auto_start", async ({ page }) => {
  await asReturning(page, { name: "Dana" });
  const calls = await mockApi(page, {
    onJoin: () => ({ json: asController() }),
    stream: streamOf(asController()),
    onTool: { create_session: () => created() }
  });
  await page.goto("/new");

  await expect(page.getByRole("heading", { name: "Start a room" })).toBeVisible();
  await expect(page.getByLabel("Your name")).toHaveValue("Dana"); // a suggestion, shown for confirmation
  const submit = page.getByRole("button", { name: "Start room" });
  await expect(submit).toBeDisabled(); // no task yet
  await fillStart(page);
  await expect(submit).toBeEnabled();
  await page.getByLabel("Your name").fill("");
  await expect(submit).toBeDisabled(); // no name
  await page.getByLabel("Your name").fill("  Dana  ");
  await submit.click();

  await expect(page).toHaveURL(new RegExp(`/s/${ROOM}$`)); // ?new=1 is removed once the panel is up
  expect(calls.tools.find((c) => c.name === "create_session").body).toEqual({ task: "Plan the launch", creator_name: "Dana", auto_start: true });
  expect(await page.evaluate((r) => localStorage.getItem(`multiplayer-ai:token:${r}`), ROOM)).toBe("mpai_creator");
  expect(await page.evaluate(() => localStorage.getItem("multiplayer-ai:name"))).toBe("Dana");
  // The new room opens as the creator, with the stored token, without asking for a name.
  expect(calls.tools.find((c) => c.name === "join_session").body).toMatchObject({ session_id: ROOM, token: "mpai_creator" });
  await expect(page.getByLabel("Your name")).toHaveCount(0);
});

test("after creating, a Share this link panel shows the link, copies it, and can be closed", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await asReturning(page, { name: "Dana" });
  await mockApi(page, { onJoin: () => ({ json: asController() }), stream: streamOf(asController()), onTool: { create_session: () => created() } });
  await page.goto("/new");
  await fillStart(page);
  await page.getByRole("button", { name: "Start room" }).click();

  const panel = page.getByRole("dialog", { name: "Share this link" });
  await expect(panel).toBeVisible();
  const link = new URL(page.url()).origin + `/s/${ROOM}`;
  await expect(panel.getByLabel("Room link")).toHaveValue(link);
  await expect(panel.getByRole("button", { name: "Copy link" })).toBeFocused(); // easy to find: it is where the cursor already is

  await panel.getByRole("button", { name: "Copy link" }).click();
  await expect(panel.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

  await panel.getByRole("button", { name: "Done" }).click();
  await expect(panel).toHaveCount(0);
  // The header's Copy link button is still there afterwards.
  await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();

  // A reload does not show the panel again.
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Share this link" })).toHaveCount(0);
});

test("Escape closes the share panel", async ({ page }) => {
  await asReturning(page, { name: "Dana", token: "mpai_creator" });
  await mockApi(page, { onJoin: () => ({ json: asController() }), stream: streamOf(asController()) });
  await page.goto(`/s/${ROOM}?new=1`);
  await expect(page.getByRole("dialog", { name: "Share this link" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Share this link" })).toHaveCount(0);
});

test("/new: a problem with the form is shown next to it and the text is kept", async ({ page }) => {
  await asReturning(page, { name: "Dana" });
  await mockApi(page, {
    onJoin: () => ({ json: asController() }),
    onTool: { create_session: (b) => (b.creator_name === "agent" ? reply(400, "INVALID_NAME", '"agent" is reserved. Pick a different name.') : reply(400, "BAD_REQUEST", "Describe the task for the agent.")) }
  });
  await page.goto("/new");

  await fillStart(page, { task: "Plan the launch", name: "agent" });
  await page.getByRole("button", { name: "Start room" }).click();
  await expect(page.getByRole("alert")).toContainText('"agent" is reserved');
  await expect(page.getByLabel("Your name")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("What should the agent work on?")).toHaveValue("Plan the launch");
  await expect(page.getByRole("button", { name: "Start room" })).toBeEnabled();
});

test("/new: server down says so, keeps the text, and Try again works", async ({ page }) => {
  await asReturning(page, { name: "Dana" });
  let attempts = 0;
  await mockApi(page, {
    onJoin: () => ({ json: asController() }),
    stream: streamOf(asController()),
    onTool: {}
  });
  await page.route("**/api/tools/create_session", (route) => (++attempts === 1 ? route.abort("connectionrefused") : route.fulfill(created())));
  await page.goto("/new");
  await fillStart(page);
  await page.getByRole("button", { name: "Start room" }).click();

  await expect(page.getByRole("alert")).toContainText("Can't reach the server");
  await expect(page.getByRole("alert")).toContainText("Nothing you wrote is lost");
  await expect(page.getByLabel("What should the agent work on?")).toHaveValue("Plan the launch");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${ROOM}$`));
  expect(attempts).toBe(2);
});

for (const [label, response, expected] of [
  ["a gateway answering for a server that is down", { status: 502, contentType: "text/html", body: "<h1>Bad gateway</h1>" }, /Can't reach the server/],
  ["rate limiting, with the wait", reply(429, "RATE_LIMITED", "Too many rooms.", { retry_after: 600 }), /Wait about 10 minutes/],
  ["rate limiting without a wait given", reply(429, "RATE_LIMITED", "Too many rooms."), /Wait a few minutes/],
  ["the demo being at capacity", reply(503, "AT_CAPACITY", "At capacity."), /The demo is at capacity[\s\S]*Try again tomorrow/]
]) {
  test(`/new: ${label}`, async ({ page }) => {
    await asReturning(page, { name: "Dana" });
    await mockApi(page, { onJoin: () => ({ json: asController() }), onTool: { create_session: () => response } });
    await page.goto("/new");
    await fillStart(page);
    await page.getByRole("button", { name: "Start room" }).click();
    await expect(page.getByRole("alert")).toContainText(expected);
    await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled();
  });
}

// ── Joining, and the ways it fails ──────────────────────────────────

test("a link opened without access shows the join screen, and joining works", async ({ page }) => {
  await asReturning(page, { name: "Dana" });
  await mockApi(page, { onJoin: () => ({ json: { ...roomState(), token: "mpai_new" } }) });
  await page.goto(`/s/${ROOM}`);
  await expect(page.getByRole("heading", { name: "Enter the room" })).toBeVisible();
  await page.getByRole("button", { name: "Join session" }).click();
  await expect(page.getByLabel(/Comment to the room/)).toBeVisible();
});

const FAILURES = [
  ["the room doesn't exist", reply(404, "ROOM_NOT_FOUND", "This room doesn't exist."), "This room doesn't exist", "Start a room"],
  ["the room was archived (no access)", reply(410, "ROOM_ARCHIVED", "Archived."), "This room was archived", "Start a room"],
  ["the room has ended (no access)", reply(410, "ROOM_ENDED", "Ended."), "This room has ended", "Start a room"],
  ["the join is rate limited", reply(429, "RATE_LIMITED", "Slow down.", { retry_after: 120 }), "Too many attempts", "Try again"],
  ["the demo is at capacity", reply(503, "AT_CAPACITY", "At capacity."), "The demo is at capacity", "Try again"],
  ["the server fails unexpectedly", reply(500, "INTERNAL", "Something went wrong on the server. Try again in a moment."), "Something went wrong", "Try again"]
];

for (const [label, response, title, action] of FAILURES) {
  test(`joining: ${label}`, async ({ page }) => {
    await asReturning(page, { name: "Dana" });
    await mockApi(page, { onJoin: () => response });
    await page.goto(`/s/${ROOM}`);
    await page.getByRole("button", { name: "Join session" }).click();

    const screen = page.locator('[data-part="status-screen"]');
    await expect(screen.getByText(title, { exact: true })).toBeVisible();
    const next = screen.getByRole(action === "Start a room" ? "link" : "button", { name: action });
    await expect(next).toBeVisible();
    if (action === "Start a room") await expect(next).toHaveAttribute("href", "/new");
  });
}

test("joining: the server being down offers Retry, and Retry gets in", async ({ page }) => {
  await asReturning(page, { name: "Dana", token: "mpai_stored" });
  let joins = 0;
  await mockApi(page, { onJoin: () => ({ json: roomState() }), stream: streamOf(roomState()) });
  await page.route("**/api/tools/join_session", (route) => (++joins === 1 ? route.abort("connectionrefused") : route.fulfill({ json: roomState() })));
  await page.goto(`/s/${ROOM}`);

  await expect(page.getByText("Can't reach the server")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByLabel(/Comment to the room/)).toBeVisible();
  expect(joins).toBe(2);
});

// ── Ended and archived rooms ────────────────────────────────────────

for (const [state, extra, message] of [
  ["archived", { archive_after_days: 7 }, "This room was archived after 7 days without activity. You can read it, but nothing new can be posted."],
  ["ended", {}, "This room has ended. You can read it, but nothing new can be posted."]
]) {
  test(`a ${state} room opens read-only for people who were in it`, async ({ page }) => {
    await asReturning(page, { name: "Dana", token: "mpai_stored" });
    const room = { ...roomState(), room: { state, ...extra } };
    await mockApi(page, { onJoin: () => ({ json: room }), stream: streamOf(room) });
    await page.goto(`/s/${ROOM}?new=1`);

    await expect(page.locator('[data-part="room-notice"]')).toHaveText(message);
    await expect(page.locator('[data-kind="agent"]', { hasText: "Start with the checklist." })).toBeVisible(); // still readable
    await expect(page.getByLabel(/Comment to the room/)).toHaveCount(0);
    await expect(page.getByLabel(/Message the agent/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Take control" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy link" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Share this link" })).toHaveCount(0); // nothing to share
  });
}

// ── Accessibility: every new screen ─────────────────────────────────

for (const mode of MODES) {
  test(`axe: /new, with a problem and with a failure · ${mode}`, async ({ page }) => {
    await prime(page, { theme: "signal-room", mode });
    await asReturning(page, { name: "Dana" });
    await mockApi(page, { onJoin: () => ({ json: asController() }), onTool: { create_session: () => reply(503, "AT_CAPACITY", "At capacity.") } });
    await page.goto("/new");
    await expectNoViolations(page, `/new empty · ${mode}`);
    await fillStart(page);
    await page.getByRole("button", { name: "Start room" }).click();
    await expect(page.getByRole("alert")).toContainText("capacity");
    await expectNoViolations(page, `/new failure · ${mode}`);
  });

  test(`axe: the failure screen and the join screen with a taken name · ${mode}`, async ({ page }) => {
    await prime(page, { theme: "signal-room", mode });
    await asReturning(page, { name: "Dana" });
    let first = true;
    await mockApi(page, {
      onJoin: () => (first ? ((first = false), reply(409, "NAME_TAKEN", 'Someone in this room is already using the name "Dana".', { suggestion: "Dana 2" })) : reply(404, "ROOM_NOT_FOUND", "This room doesn't exist."))
    });
    await page.goto(`/s/${ROOM}`);
    await page.getByRole("button", { name: "Join session" }).click();
    await expect(page.getByRole("alert")).toContainText("already using");
    await expectNoViolations(page, `taken name · ${mode}`);
    await page.getByRole("button", { name: /Join as/ }).click();
    await expect(page.getByText("This room doesn't exist")).toBeVisible();
    await expectNoViolations(page, `failure screen · ${mode}`);
  });
}

for (const theme of THEMES) {
  for (const mode of MODES) {
    test(`axe: the share panel and a read-only room · ${theme} · ${mode}`, async ({ page }) => {
      await prime(page, { theme, mode });
      await asReturning(page, { name: "Dana", token: "mpai_stored" });
      await mockApi(page, { onJoin: () => ({ json: asController() }), stream: streamOf(asController()) });
      await page.goto(`/s/${ROOM}?new=1`);
      await expect(page.getByRole("dialog", { name: "Share this link" })).toBeVisible();
      await expectNoViolations(page, `share panel · ${theme} · ${mode}`);
    });

    test(`axe: an archived room · ${theme} · ${mode}`, async ({ page }) => {
      await prime(page, { theme, mode });
      await asReturning(page, { name: "Dana", token: "mpai_stored" });
      const room = { ...roomState(), room: { state: "archived", archive_after_days: 7 } };
      await mockApi(page, { onJoin: () => ({ json: room }), stream: streamOf(room) });
      await page.goto(`/s/${ROOM}`);
      await expect(page.locator('[data-part="room-notice"]')).toBeVisible();
      await expectNoViolations(page, `archived room · ${theme} · ${mode}`);
    });
  }
}
