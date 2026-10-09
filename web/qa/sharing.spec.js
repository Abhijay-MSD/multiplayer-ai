import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { THEMES, MODES, prime, stubFonts } from "./helpers.js";
import { ROOM, NOW, mockApi, asReturning, sse } from "./api-mocks.js";

// Sharing in the browser, against a mocked API: the Sharing section of Settings, joining with the link, what a guest
// sees (and cannot do), and the host's panel. The server's side of all of this is covered by the server's tests.

const SECRET = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE";
const LAN_LINK = `http://192.168.1.50:3737/s/${ROOM}/join#k=${SECRET}`;
const WARNING = "This link uses plain http on your local network. Anyone on the same network who can capture traffic can read what's sent, including the room secret and people's access tokens. Use it only on a network you trust, like your home or your own hotspot. Don't use it on café, hotel, school or office Wi-Fi.";
const QR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2" width="12" height="12"><rect width="2" height="2" fill="#ffffff"/><path d="M0 0h1v1h-1z" fill="#000000"/></svg>';

async function expectNoViolations(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

const person = (name, role, extra = {}) => ({ session_id: ROOM, name, role, last_seen: NOW(), is_host: false, ...extra });
const roomFor = (me, { policy = "ask", controller = "Maya" } = {}) => ({
  session: { id: ROOM, title: "Plan the launch", task: "Plan the launch", status: "active", step_count: 1, agent_working: false, control_policy: policy },
  room: { state: "open", archive_after_days: 7, sharing: true, control_policy: policy },
  participants: [person("Maya", controller === "Maya" ? "controller" : "watcher", { is_host: true }), person(me, controller === me ? "controller" : "watcher")],
  events: [
    { id: 1, session_id: ROOM, kind: "join", author: "Maya", content: "Maya created the session.", created_at: NOW() },
    { id: 2, session_id: ROOM, kind: "directive", author: "Maya", content: "Plan the launch", created_at: NOW() },
    { id: 3, session_id: ROOM, kind: "agent_message", author: "agent", content: "Start with the checklist.", reply_to: 2, created_at: NOW() }
  ],
  you: { name: me, role: controller === me ? "controller" : "watcher" }
});
const streamFor = (state) => () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse({ type: "state", data: state }) });

const panelData = (over = {}) => ({
  room: { id: ROOM, title: "Plan the launch" },
  policy: "ask",
  counters: { guest_messages: 7, guest_cap: 20, room_steps: 12, room_cap: 50 },
  pending: [],
  people: [
    { name: "Maya", role: "controller", is_host: true, last_seen: NOW() },
    { name: "Dana", role: "watcher", is_host: false, last_seen: NOW() }
  ],
  share: { link: LAN_LINK, qr_svg: QR, sharing: true, needs_address: false, note: "Stay on this computer's own address (127.0.0.1 or localhost) to use these controls. Copy link copies the link for your guests on the network.", warning: WARNING },
  ...over
});

/** Answers /api/status and the host routes. `handlers` maps "METHOD /path" to (body) => json. */
async function mockHost(page, { status, handlers = {} } = {}) {
  const calls = [];
  await page.route("**/api/status", (route) => route.fulfill({ json: status ?? { configured: true, sharing: false, host: false } }));
  await page.route("**/api/host/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.postData() ? req.postDataJSON() : undefined;
    calls.push({ method: req.method(), path, body });
    const handler = handlers[`${req.method()} ${path}`];
    if (!handler) return route.fulfill({ status: 404, json: { error: "not mocked", code: "NOT_FOUND" } });
    const out = handler(body);
    return route.fulfill({ status: out.status ?? 200, json: out.json });
  });
  return calls;
}

async function hostRoom(page, { panel = panelData(), policy = "ask", handlers = {} } = {}) {
  const state = roomFor("Maya", { policy, controller: "Maya" });
  state.participants[0].is_host = true;
  await asReturning(page, { name: "Maya", token: "mpai_maya" });
  await mockApi(page, { onJoin: () => ({ json: state }), stream: streamFor(state) });
  const calls = await mockHost(page, {
    status: { configured: true, sharing: true, host: true },
    handlers: { [`GET /api/host/rooms/${ROOM}`]: () => ({ json: panel }), ...handlers }
  });
  return calls;
}

// ── Settings > Sharing ──────────────────────────────────────────────

const sharingView = (over = {}) => ({
  available: true, unavailable_reason: null, container: false, active: false, address: null, shareName: null, port: 3737, url: null, notice: null,
  candidates: [{ interface: "en0", address: "192.168.1.50", kind: "private", virtual: false }],
  warning: WARNING, guest_cap_default: 20, control_default: "ask", ...over
});

async function mockSettingsPage(page, view, handlers = {}) {
  const calls = [];
  const prov = (id) => ({
    id, label: { groq: "Groq", gemini: "Gemini", compat: "OpenAI-compatible" }[id],
    default_model: { groq: "openai/gpt-oss-120b", gemini: "gemini-3.5-flash", compat: null }[id], model: null, saved_model: null,
    ...(id === "compat" ? { base_url: null, saved_base_url: null, sends_key_to: null } : {}),
    key: { present: false, source: null, last4: null, saved: false, saved_last4: null }, overrides: []
  });
  await page.route("**/api/settings", (route) =>
    route.fulfill({ json: { provider: "gemini", provider_source: "default", provider_override: null, configured: false, providers: ["groq", "gemini", "compat"].map(prov), file: "/path/to/.multiplayer-ai/settings.json", problem: null, storage: { kind: "sqlite", file: "/x/multiplayer-ai.db", folder: "/path/to/.multiplayer-ai" } } })
  );
  await page.route("**/api/host/sharing", async (route) => {
    const req = route.request();
    const body = req.postData() ? req.postDataJSON() : undefined;
    calls.push({ method: req.method(), body });
    if (req.method() === "GET") return route.fulfill({ json: view });
    const next = handlers[req.method()]?.(body);
    return route.fulfill({ status: next?.status ?? 200, json: next?.json ?? view });
  });
  return calls;
}

test("Settings > Sharing: this computer only by default, the plain-http warning, what can't be detected, the Mac prompt, and no internet mode", async ({ page }) => {
  await mockSettingsPage(page, sharingView());
  await page.goto("/settings");
  const section = page.locator('[data-part="sharing-settings"]');
  await expect(section.getByText(/never remembered/)).toBeVisible();
  await expect(section.getByText(/Sharing over the internet isn't supported yet/)).toBeVisible();
  await expect(section.getByRole("radio", { name: "This computer only" })).toBeChecked();
  await expect(section.getByText(/whether this is a café, hotel, school or office network/)).toBeVisible();
  await expect(section.getByText(/macOS may ask whether to allow incoming connections/)).toBeVisible();
  await expect(section.getByRole("button", { name: "Turn sharing on" })).toBeDisabled();
});

test("Settings > Sharing: choose Same Wi-Fi and an address, see the warning, turn it on, then off", async ({ page }) => {
  let view = sharingView();
  const calls = await mockSettingsPage(page, view, {
    PUT: (body) => ({ json: (view = body.mode === "wifi" ? sharingView({ active: true, address: body.address, url: `http://${body.address}:3737` }) : sharingView()) })
  });
  await page.goto("/settings");
  const section = page.locator('[data-part="sharing-settings"]');
  await section.getByRole("radio", { name: "Same Wi-Fi" }).check();
  await expect(section.getByText(WARNING)).toBeVisible();
  await expect(section.getByLabel("Network address to share on")).toHaveValue("192.168.1.50");
  await section.getByRole("button", { name: "Turn sharing on" }).click();
  await expect(section.getByText(/Sharing is on at http:\/\/192\.168\.1\.50:3737/)).toBeVisible();
  expect(calls.find((c) => c.method === "PUT").body).toEqual({ mode: "wifi", address: "192.168.1.50" });
  await section.getByRole("button", { name: "Turn sharing off" }).click();
  await expect(section.getByRole("button", { name: "Turn sharing on" })).toBeVisible();
  expect(calls.filter((c) => c.method === "PUT").at(-1).body).toEqual({ mode: "local" });
});

test("Settings > Sharing: an unusual address needs a deliberate yes and says why", async ({ page }) => {
  const odd = { interface: "utun3", address: "100.100.1.2", kind: "cgnat", virtual: true, warning: "This address is in the range used for shared carrier networks and some VPNs (100.64.x.x), not a home network." };
  const calls = await mockSettingsPage(page, sharingView({ candidates: [odd] }), { PUT: () => ({ json: sharingView({ active: true, address: odd.address, url: "http://100.100.1.2:3737" }) }) });
  await page.goto("/settings");
  const section = page.locator('[data-part="sharing-settings"]');
  await section.getByRole("radio", { name: "Same Wi-Fi" }).check();
  await expect(section.getByText(/shared carrier networks/)).toBeVisible();
  const on = section.getByRole("button", { name: "Turn sharing on" });
  await expect(on).toBeDisabled();
  await section.getByLabel("I understand, and I want to share on this address").check();
  await on.click();
  expect(calls.find((c) => c.method === "PUT").body).toEqual({ mode: "wifi", address: "100.100.1.2", acknowledge: true });
});

test("Settings > Sharing: a closed listener (the address went away) is shown as a notice", async ({ page }) => {
  await mockSettingsPage(page, sharingView({ notice: "The network address 192.168.1.50 went away (the network changed or disconnected), so sharing was turned off. Turn sharing on again to choose an address." }));
  await page.goto("/settings");
  await expect(page.getByRole("alert").filter({ hasText: "went away" })).toBeVisible();
});

test("Settings > Sharing: in a container the host types the address people use", async ({ page }) => {
  const calls = await mockSettingsPage(page, sharingView({ container: true, active: true, candidates: [], shareName: null }), {
    PUT: (body) => ({ json: sharingView({ container: true, active: true, candidates: [], shareName: body.share_address }) })
  });
  await page.goto("/settings");
  const section = page.locator('[data-part="sharing-settings"]');
  await expect(section.getByText(/running in a container, so it counts as shared/)).toBeVisible();
  await section.getByLabel("Address people will use").fill("192.168.1.20");
  await section.getByRole("button", { name: "Save address" }).click();
  await expect(section.getByText(/Guests open http:\/\/192\.168\.1\.20:3737/)).toBeVisible();
  expect(calls.find((c) => c.method === "PUT").body).toEqual({ share_address: "192.168.1.20" });
});

test("Settings > Sharing: with Supabase storage it says plainly that sharing needs the local data file", async ({ page }) => {
  await mockSettingsPage(page, sharingView({ available: false, unavailable_reason: "Sharing needs the local data file. It isn't available with Supabase storage." }));
  await page.goto("/settings");
  await expect(page.getByText("Sharing needs the local data file. It isn't available with Supabase storage.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn sharing on" })).toHaveCount(0);
});

// ── a guest ─────────────────────────────────────────────────────────

test("a guest opening the link joins with its secret in the request body, and the secret leaves the address bar", async ({ page }) => {
  const state = roomFor("Sam");
  const calls = await mockApi(page, { onJoin: () => ({ json: { ...state, token: "mpai_sam" } }), stream: streamFor(state) });
  await mockHost(page, { status: { configured: true, sharing: true, host: false } });
  await page.addInitScript(() => localStorage.setItem("multiplayer-ai:name", "Sam"));
  await page.goto(`/s/${ROOM}/join#k=${SECRET}`);
  await page.getByRole("button", { name: /join|enter|continue/i }).first().click();
  await expect(page.getByText("Plan the launch").first()).toBeVisible();
  const join = calls.tools.find((c) => c.name === "join_session");
  expect(join.body.invite).toBe(SECRET);
  expect(page.url()).not.toContain(SECRET);
  expect(page.url()).not.toContain("#");
  expect(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]))).not.toContain(SECRET);
  expect(await page.evaluate(() => document.referrer + location.href)).not.toContain(SECRET);
});

test("a link that is wrong or missing leads to a plain explanation, not a blank page", async ({ page }) => {
  await mockApi(page, { onJoin: () => ({ status: 403, json: { error: "This room needs the link the host shared. Ask the host for it.", code: "INVITE_REQUIRED" } }) });
  await mockHost(page);
  await page.addInitScript(() => localStorage.setItem("multiplayer-ai:name", "Sam"));
  await page.goto(`/s/${ROOM}/join`);
  await page.getByRole("button", { name: /join|enter|continue/i }).first().click();
  await expect(page.getByText("This room needs its link", { exact: true })).toBeVisible();
  await expect(page.getByText(/the whole link, including the long code after the # sign/)).toBeVisible();
});

test("a guest in a shared room asks the host for control, then waits; there is no Copy link and no host controls", async ({ page }) => {
  const state = roomFor("Sam");
  const calls = await mockApi(page, {
    onJoin: () => ({ json: state }),
    stream: streamFor(state),
    onTool: { take_control: () => ({ json: { pending: true, request_id: "r1", expires_at: new Date(Date.now() + 300000).toISOString() } }) }
  });
  await mockHost(page, { status: { configured: true, sharing: true, host: false } });
  await asReturning(page, { name: "Sam", token: "mpai_sam" });
  await page.goto(`/s/${ROOM}`);
  const ask = page.getByRole("button", { name: "Ask the host for control" }).first();
  await expect(ask).toBeEnabled();
  await expect(page.getByRole("button", { name: "Copy link" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Host controls/ })).toHaveCount(0);
  await ask.click();
  await expect(page.getByRole("button", { name: "Waiting for the host…" }).first()).toBeDisabled();
  await expect(page.getByText("Waiting for the host to answer").first()).toBeVisible();
  expect(calls.tools.find((c) => c.name === "take_control").body).toMatchObject({ session_id: ROOM, token: "mpai_sam" });
});

test("when the host has locked control, the guest's button is off and says why", async ({ page }) => {
  const state = roomFor("Sam", { policy: "locked" });
  await mockApi(page, { onJoin: () => ({ json: state }), stream: streamFor(state) });
  await mockHost(page, { status: { configured: true, sharing: true, host: false } });
  await asReturning(page, { name: "Sam", token: "mpai_sam" });
  await page.goto(`/s/${ROOM}`);
  await expect(page.getByRole("button", { name: "Ask the host for control" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Take control" }).first()).toBeDisabled();
  await expect(page.getByText("The host has locked control").first()).toBeVisible();
});

test("when the policy is 'allow freely' a guest sees the usual button and the usual reason", async ({ page }) => {
  const state = roomFor("Sam", { policy: "free" });
  await mockApi(page, { onJoin: () => ({ json: state }), stream: streamFor(state) });
  await mockHost(page, { status: { configured: true, sharing: true, host: false } });
  await asReturning(page, { name: "Sam", token: "mpai_sam" });
  await page.goto(`/s/${ROOM}`);
  await expect(page.getByRole("button", { name: "Take control" }).first()).toBeDisabled();
  await expect(page.getByText("Maya is here and steering").first()).toBeVisible();
});

test("/new for a guest of a shared app says to ask the host, and shows no form", async ({ page }) => {
  await mockHost(page, { status: { configured: true, sharing: true, host: false } });
  await page.goto("/new");
  await expect(page.getByRole("heading", { name: "Ask the host to start a room" })).toBeVisible();
  await expect(page.getByLabel("What should the agent work on?")).toHaveCount(0);
});

test("/new for the host of a shared app is the usual form", async ({ page }) => {
  await mockHost(page, { status: { configured: true, sharing: true, host: true } });
  await page.goto("/new");
  await expect(page.getByLabel("What should the agent work on?")).toBeVisible();
});

// ── the host ────────────────────────────────────────────────────────

test("the host opens the panel: the guest link with its QR code, the warning, counters, and a note to stay on localhost", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await hostRoom(page);
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: /Host controls/ }).click();
  const panel = page.locator('[data-part="host-panel"]');
  await expect(panel.getByLabel("Link for guests")).toHaveValue(LAN_LINK);
  await expect(panel.getByRole("img", { name: /QR code/ })).toBeVisible();
  await expect(panel.getByText(WARNING)).toBeVisible();
  await expect(panel.getByText(/Stay on this computer's own address/)).toBeVisible();
  await expect(panel.getByText("Guests: 7 of 20 · Room: 12 of 50")).toBeVisible();
  await panel.getByRole("button", { name: "Copy link" }).click();
  await expect(panel.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(LAN_LINK);
  // the header's own Copy link button copies the same link
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Copy link" }).first().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(LAN_LINK);
});

test("the host changes the policy, raises the limit, makes a new link and removes a person", async ({ page }) => {
  const calls = await hostRoom(page, {
    handlers: {
      [`PUT /api/host/rooms/${ROOM}/policy`]: (b) => ({ json: panelData({ policy: b.policy }) }),
      [`PUT /api/host/rooms/${ROOM}/guest-cap`]: (b) => ({ json: panelData({ counters: { guest_messages: 7, guest_cap: b.cap, room_steps: 12, room_cap: 50 } }) }),
      [`POST /api/host/rooms/${ROOM}/rotate-link`]: () => ({ json: panelData({ share: { ...panelData().share, link: LAN_LINK.replace("AbCd", "ZyXw") } }) }),
      [`POST /api/host/rooms/${ROOM}/remove`]: () => ({ json: panelData({ people: [{ name: "Maya", role: "controller", is_host: true, last_seen: NOW() }] }) })
    }
  });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: /Host controls/ }).click();
  const panel = page.locator('[data-part="host-panel"]');
  await panel.getByRole("radio", { name: "Locked" }).click();
  await expect(panel.getByRole("radio", { name: "Locked" })).toBeChecked();
  await expect(panel.getByText("Only you change who is steering.")).toBeVisible();
  await panel.getByLabel("Messages guests may send").fill("40");
  await panel.getByRole("button", { name: "Save limit" }).click();
  await expect(panel.getByText("Guests: 7 of 40 · Room: 12 of 50")).toBeVisible();
  await panel.getByRole("button", { name: "Make a new link" }).click();
  await expect(panel.getByLabel("Link for guests")).toHaveValue(/ZyXw/);
  await panel.getByRole("button", { name: "Remove Dana" }).click();
  await expect(panel.getByRole("button", { name: "Remove Dana" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /Remove Maya/ })).toHaveCount(0);
  expect(calls.map((c) => `${c.method} ${c.path.replace(ROOM, ":id")}`)).toEqual(expect.arrayContaining([
    "PUT /api/host/rooms/:id/policy", "PUT /api/host/rooms/:id/guest-cap", "POST /api/host/rooms/:id/rotate-link", "POST /api/host/rooms/:id/remove"
  ]));
  expect(calls.find((c) => c.path.endsWith("/policy")).body).toEqual({ policy: "locked" });
  expect(calls.find((c) => c.path.endsWith("/guest-cap")).body).toEqual({ cap: 40 });
  expect(calls.find((c) => c.path.endsWith("/remove")).body).toEqual({ name: "Dana" });
});

test("a request for control shows as a prompt even with the panel closed; approving it clears it", async ({ page }) => {
  let panel = panelData({ pending: [{ id: "r1", kind: "take", name: "Dana", to: null, expires_at: new Date(Date.now() + 300000).toISOString() }] });
  const calls = await hostRoom(page, {
    panel,
    handlers: { [`POST /api/host/rooms/${ROOM}/control/r1`]: () => ({ json: (panel = panelData()) }) }
  });
  await page.goto(`/s/${ROOM}`);
  const prompt = page.locator('[data-part="host-prompt"]');
  await expect(prompt.getByText("Dana wants control")).toBeVisible();
  await expect(page.getByRole("button", { name: "Host controls (1)" })).toBeVisible();
  await prompt.getByRole("button", { name: "Approve" }).click();
  await expect(prompt).toHaveCount(0);
  expect(calls.find((c) => c.path.endsWith("/control/r1")).body).toEqual({ decision: "approve" });
});

test("denying, and a handoff request, are worded for what they are", async ({ page }) => {
  const calls = await hostRoom(page, {
    panel: panelData({ pending: [{ id: "h1", kind: "handoff", name: "Sam", to: "Dana", expires_at: new Date(Date.now() + 300000).toISOString() }] }),
    handlers: { [`POST /api/host/rooms/${ROOM}/control/h1`]: () => ({ json: panelData() }) }
  });
  await page.goto(`/s/${ROOM}`);
  const prompt = page.locator('[data-part="host-prompt"]');
  await expect(prompt.getByText("Sam wants to hand control to Dana")).toBeVisible();
  await prompt.getByRole("button", { name: "Deny" }).click();
  expect(calls.find((c) => c.path.endsWith("/control/h1")).body).toEqual({ decision: "deny" });
});

test("names and link text from other people are shown as text, never as markup", async ({ page }) => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  await hostRoom(page, {
    panel: panelData({
      pending: [{ id: "x1", kind: "take", name: evil, to: null, expires_at: new Date(Date.now() + 300000).toISOString() }],
      people: [{ name: "Maya", role: "controller", is_host: true, last_seen: NOW() }, { name: evil, role: "watcher", is_host: false, last_seen: NOW() }]
    })
  });
  await page.goto(`/s/${ROOM}`);
  await expect(page.locator('[data-part="host-prompt"]').getByText(`${evil} wants control`)).toBeVisible();
  await page.getByRole("button", { name: /Host controls/ }).click();
  await expect(page.getByRole("button", { name: `Remove ${evil}` })).toBeVisible();
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.locator('[data-part="host-panel"] img[src="x"]').count()).toBe(0);
});

test("when sharing is off, the host's panel gives a link for this computer, no QR code, and says how to share", async ({ page }) => {
  await hostRoom(page, { panel: panelData({ share: { link: `http://127.0.0.1:3737/s/${ROOM}/join#k=${SECRET}`, qr_svg: null, sharing: false, needs_address: false, note: "This link only works on this computer. Turn on Same Wi-Fi in Settings to share it.", warning: null } }) });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: /Host controls/ }).click();
  const panel = page.locator('[data-part="host-panel"]');
  await expect(panel.getByText("This link only works on this computer. Turn on Same Wi-Fi in Settings to share it.")).toBeVisible();
  await expect(panel.getByRole("img")).toHaveCount(0);
  await expect(panel.getByText("plain http")).toHaveCount(0);
});

test("a short window opens the host panel at its top, so the link and QR code are what the host sees first", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await hostRoom(page);
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: /Host controls/ }).click();
  const panel = page.locator('[data-part="host-panel"]');
  await expect(panel).toBeVisible();
  const inView = async (loc) => (await loc.boundingBox()).y >= 0 && (await loc.boundingBox()).y + (await loc.boundingBox()).height <= 560;
  await expect(page.getByRole("heading", { name: "Host controls" })).toBeInViewport();
  await expect(panel.getByLabel("Link for guests")).toBeInViewport();
  expect(await panel.evaluate((el) => el.scrollTop)).toBe(0);
  expect(await inView(panel.getByLabel("Link for guests"))).toBe(true);
  await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
});

test("the host panel fits a 360px screen without sideways scrolling and can be used by keyboard alone", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const soon = new Date(Date.now() + 300000).toISOString();
  await hostRoom(page, { panel: panelData({ pending: ["a", "b", "c"].map((n, k) => ({ id: `r${k}`, kind: "take", name: `Guest ${n}`, to: null, expires_at: soon })) }) });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: /Host controls/ }).focus();
  await page.keyboard.press("Enter");
  const panel = page.locator('[data-part="host-panel"]');
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    wide: [...document.querySelectorAll("body *")]
      .filter((el) => getComputedStyle(el).visibility !== "hidden" && el.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5 && !el.closest("aside"))
      .slice(0, 5).map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`)
  }));
  expect(overflow).toEqual({ scroll: 0, wide: [] });
  await expect(page.getByRole("button", { name: "Close" })).toBeFocused(); // focus moves into the panel
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

// ── accessibility, every theme and mode ──────────────────────────────

for (const theme of THEMES) {
  for (const mode of MODES) {
    test(`axe: sharing settings, host panel and prompt, guest view · ${theme} · ${mode}`, async ({ page }) => {
      await stubFonts(page);
      await prime(page, { theme, mode });
      await mockSettingsPage(page, sharingView({ active: true, address: "192.168.1.50", url: "http://192.168.1.50:3737", notice: "The network address went away." }));
      await page.goto("/settings");
      await expect(page.locator('[data-part="sharing-settings"]')).toBeVisible();
      await expectNoViolations(page, `settings sharing · ${theme} · ${mode}`);

      await hostRoom(page, { panel: panelData({ pending: [{ id: "r1", kind: "take", name: "Dana", to: null, expires_at: new Date(Date.now() + 300000).toISOString() }] }) });
      await page.goto(`/s/${ROOM}`);
      await expect(page.locator('[data-part="host-prompt"]')).toBeVisible();
      await expectNoViolations(page, `host prompt · ${theme} · ${mode}`);
      await page.getByRole("button", { name: /Host controls/ }).click();
      await expect(page.locator('[data-part="host-panel"]')).toBeVisible();
      await expectNoViolations(page, `host panel · ${theme} · ${mode}`);
    });
  }
}
