import { test, expect } from "./test-base.js";
import { ROOM, ROOM_B, NOW, roomState, sse, streamOf, mockApi, asReturning } from "./api-mocks.js";

// The real room route (/s/:id) with its real data layer, against a mocked API.
// What this proves: the browser holds a per-room token, sends it in request
// bodies and an Authorization header (never in a URL), reads live updates from
// the server's stream, resumes from the newest event id, and recovers when the
// server refuses a name or revokes access. The server side of each of these is
// covered by the server's own tests; nothing here talks to a real server.

test("a remembered name is only a suggestion: room B shows the prompt, prefilled, and nobody joins until they confirm", async ({ page }) => {
  // This browser remembers "Dana" and holds a token for room A only.
  await asReturning(page, { token: "mpai_roomA_token" });
  const calls = await mockApi(page, { onJoin: () => ({ json: { ...roomState(), token: "mpai_issuedtoken" } }) });
  await page.goto(`/s/${ROOM_B}`);

  await expect(page.getByLabel("Your name")).toHaveValue("Dana");
  await page.waitForTimeout(700); // long enough for a silent join to have happened
  expect(calls.tools.filter((c) => c.name === "join_session")).toHaveLength(0);
  expect(calls.streams).toHaveLength(0);

  await page.getByRole("button", { name: "Join session" }).click();
  await expect(page.getByLabel(/Comment to the room/)).toBeVisible();
  const joins = calls.tools.filter((c) => c.name === "join_session");
  expect(joins).toHaveLength(1);
  expect(joins[0].body).toEqual({ session_id: ROOM_B, name: "Dana" }); // room A's token is not sent to room B
});

test("confirming a name stores the issued token and opens an authenticated stream", async ({ page }) => {
  await asReturning(page);
  const calls = await mockApi(page, {
    onJoin: () => ({ json: { ...roomState(), token: "mpai_issuedtoken" } }),
    stream: () => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: sse(
        { type: "state", data: roomState() },
        { type: "event", id: 4, data: { id: 4, session_id: ROOM, kind: "agent_message", author: "agent", content: "Pushed over the stream.", reply_to: 2, created_at: NOW() } }
      )
    })
  });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: "Join session" }).click();

  await expect(page.locator('[data-kind="agent"]', { hasText: "Pushed over the stream." })).toBeVisible();
  expect(await page.evaluate((r) => localStorage.getItem(`multiplayer-ai:token:${r}`), ROOM)).toBe("mpai_issuedtoken");

  expect(calls.tools.find((c) => c.name === "join_session").body).toEqual({ session_id: ROOM, name: "Dana" });
  const stream = calls.streams[0];
  expect(stream.auth).toBe("Bearer mpai_issuedtoken");
  expect(stream.url).toContain("after=3"); // resumes from the newest event the join returned
  expect(stream.url).not.toContain("mpai_"); // the token is never in a URL
});

test("coming back with a stored token sends it, and sends comments as the token's owner", async ({ page }) => {
  await asReturning(page, { token: "mpai_stored" });
  const calls = await mockApi(page, { onJoin: () => ({ json: roomState() }) }); // no new token issued
  await page.goto(`/s/${ROOM}`);

  await expect(page.getByLabel(/Comment to the room/)).toBeVisible();
  await expect(page.getByLabel("Your name")).toHaveCount(0); // a token resumes without asking
  const resume = calls.tools.find((c) => c.name === "join_session").body;
  expect(resume).toMatchObject({ session_id: ROOM, token: "mpai_stored" });
  expect(resume.name).toBeUndefined(); // the remembered name is not used to resume

  await page.getByLabel(/Comment to the room/).fill("Looks right");
  await page.keyboard.press("Enter");
  await expect.poll(() => calls.tools.find((c) => c.name === "send_comment")).toBeTruthy();
  const sent = calls.tools.find((c) => c.name === "send_comment").body;
  expect(sent).toEqual({ session_id: ROOM, token: "mpai_stored", content: "Looks right" });
  expect("name" in sent).toBe(false); // who is sending comes from the token, not a name
});

test("a name already in the room is explained, with a one-click suggestion that works", async ({ page }) => {
  await asReturning(page, { name: "Maya" });
  const calls = await mockApi(page, {
    onJoin: (body) =>
      body.name === "Maya"
        ? { status: 409, json: { error: 'Someone in this room is already using the name "Maya". Pick another, for example "Maya 2".', code: "NAME_TAKEN", suggestion: "Maya 2" } }
        : { json: { ...roomState({ name: body.name, role: "watcher" }), token: "mpai_new" } },
    stream: streamOf(roomState({ name: "Maya 2", role: "watcher" })) // the stream agrees with the join
  });
  await page.goto(`/s/${ROOM}`);
  await expect(page.getByLabel("Your name")).toHaveValue("Maya");
  await page.getByRole("button", { name: "Join session" }).click();

  await expect(page.getByRole("alert")).toContainText('already using the name "Maya"');
  await expect(page.getByLabel("Your name")).toBeVisible();
  await page.getByRole("button", { name: /Join as .Maya 2./ }).click();

  await expect(page.getByText("Maya 2 (you)")).toBeVisible();
  const joins = calls.tools.filter((c) => c.name === "join_session");
  expect(joins.map((j) => j.body.name)).toEqual(["Maya", "Maya 2"]);
  expect(await page.evaluate(() => localStorage.getItem("multiplayer-ai:name"))).toBe("Maya 2");
});

test("when the server revokes access the stream ends, the token is dropped, and the person is asked before joining again", async ({ page }) => {
  await asReturning(page, { token: "mpai_old" });
  const calls = await mockApi(page, {
    onJoin: (_body, n) => ({ json: n === 1 ? roomState() : { ...roomState(), token: "mpai_fresh" } }),
    stream: (n) => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: sse({ type: "state", data: roomState() }, ...(n === 1 ? [{ type: "revoked", data: {} }] : []))
    })
  });
  await page.goto(`/s/${ROOM}`);

  await expect(page.getByRole("alert")).toContainText("Your access to this room ended");
  await expect(page.getByLabel("Your name")).toHaveValue("Dana");
  expect(await page.evaluate((r) => localStorage.getItem(`multiplayer-ai:token:${r}`), ROOM)).toBeNull();
  await page.waitForTimeout(500);
  expect(calls.tools.filter((c) => c.name === "join_session")).toHaveLength(1); // no silent rejoin

  await page.getByRole("button", { name: "Join session" }).click();
  await expect.poll(() => calls.tools.filter((c) => c.name === "join_session").length).toBe(2);
  expect(calls.tools.filter((c) => c.name === "join_session")[1].body.token).toBeUndefined();
  await expect.poll(() => page.evaluate((r) => localStorage.getItem(`multiplayer-ai:token:${r}`), ROOM)).toBe("mpai_fresh");
});

test("if the server refuses a take-control, its explanation is shown and the room stays usable", async ({ page }) => {
  await asReturning(page, { token: "mpai_stored" });
  const message = "Maya is driving and is here. Ask them to hand control to you, or post a comment to the room.";
  // The button is enabled only when the controller looks away; the server can still
  // disagree (they came back a moment ago), and its explanation is shown.
  const away = roomWithController({ seenAgoMs: 5 * 60_000 });
  const calls = await mockApi(page, {
    onJoin: () => ({ json: away }),
    stream: streamOf(away),
    onTool: { take_control: () => ({ status: 403, json: { error: message, code: "CONTROL_HELD" } }) }
  });
  await page.goto(`/s/${ROOM}`);

  await page.getByRole("complementary").getByRole("button", { name: "Take control" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Maya is driving and is here" })).toBeVisible();
  expect(calls.tools.find((c) => c.name === "take_control").body).toEqual({ session_id: ROOM, token: "mpai_stored" });
  await expect(page.getByLabel(/Comment to the room/)).toBeVisible();
});

test("the server being unreachable is said plainly", async ({ page }) => {
  await asReturning(page, { token: "mpai_stored" });
  await page.route("**/api/**", (route) => route.abort("connectionrefused"));
  await page.goto(`/s/${ROOM}`);
  await expect(page.getByText(/Can't reach the server/)).toBeVisible();
});

// ── The watcher's "Take control" button follows the server's rule ──

// Maya is the controller; `seenAgoMs` is how long ago she was last seen, or
// `none: true` for a room where nobody holds the seat.
const roomWithController = ({ seenAgoMs = 0, none = false } = {}) => {
  const state = roomState();
  state.participants = state.participants.map((p) =>
    p.name === "Maya"
      ? { ...p, role: none ? "watcher" : "controller", last_seen: new Date(Date.now() - seenAgoMs).toISOString() }
      : p
  );
  return state;
};

test("Take control is disabled, with the reason shown, while the controller is here", async ({ page }) => {
  await asReturning(page, { token: "mpai_stored" });
  const here = roomWithController();
  const calls = await mockApi(page, { onJoin: () => ({ json: here }), stream: streamOf(here) });
  await page.goto(`/s/${ROOM}`);

  const railButton = page.getByRole("complementary").getByRole("button", { name: "Take control" });
  await expect(railButton).toBeDisabled();
  await expect(page.getByText("Maya is here and steering").first()).toBeVisible();
  await expect(railButton).toHaveAccessibleDescription("Maya is here and steering");
  // The same affordance in the composer's hint is disabled too.
  await expect(page.locator('[data-part="composer-hint"]').getByRole("button", { name: "Take control" })).toBeDisabled();
  await expect(page.locator('[data-part="composer-hint"]')).toContainText("Maya is here and steering");
  expect(calls.tools.some((c) => c.name === "take_control")).toBe(false);
});

test("Take control is enabled once the controller is away, and sends the request", async ({ page }) => {
  await asReturning(page, { token: "mpai_stored" });
  const away = roomWithController({ seenAgoMs: 5 * 60_000 });
  const calls = await mockApi(page, {
    onJoin: () => ({ json: away }),
    stream: streamOf(away),
    onTool: { take_control: () => ({ json: { controller: "Dana" } }) }
  });
  await page.goto(`/s/${ROOM}`);

  const railButton = page.getByRole("complementary").getByRole("button", { name: "Take control" });
  await expect(railButton).toBeEnabled();
  await expect(page.getByText("is here and steering")).toHaveCount(0);
  await railButton.click();
  await expect.poll(() => calls.tools.find((c) => c.name === "take_control")?.body).toEqual({ session_id: ROOM, token: "mpai_stored" });
});

test("Take control is enabled when nobody has control", async ({ page }) => {
  await asReturning(page, { token: "mpai_stored" });
  const nobody = roomWithController({ none: true });
  await mockApi(page, { onJoin: () => ({ json: nobody }), stream: streamOf(nobody) });
  await page.goto(`/s/${ROOM}`);

  await expect(page.getByRole("complementary").getByRole("button", { name: "Take control" })).toBeEnabled();
  await expect(page.getByText("is here and steering")).toHaveCount(0);
  await expect(page.locator('[data-part="composer-hint"]')).toContainText("Nobody is controller");
});
