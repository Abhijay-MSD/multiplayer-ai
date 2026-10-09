import { test, expect } from "./test-base.js";
import AxeBuilder from "@axe-core/playwright";
import { THEMES, MODES, prime, stubFonts } from "./helpers.js";
import { ROOM, roomState, sse, mockApi, asReturning } from "./api-mocks.js";

// Setup (the first run) and Settings, against a mocked API. The server's side of these
// (the sign-in cookie, what is checked, what is stored) is covered by the server's tests.
// The key used here is made up.

const KEY = "gsk_made_up_key_for_browser_tests_0042";

async function expectNoViolations(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

const provider = (id, over = {}) => ({
  id,
  label: { groq: "Groq", gemini: "Gemini", claude: "Claude", compat: "OpenAI-compatible" }[id],
  default_model: { groq: "openai/gpt-oss-120b", gemini: "gemini-3.5-flash", claude: "claude-haiku-4-5-20251001", compat: null }[id],
  model: null,
  saved_model: null,
  ...(id === "compat" ? { base_url: null, saved_base_url: null, sends_key_to: null } : {}),
  key: { present: false, source: null, last4: null, saved: false, saved_last4: null },
  overrides: [],
  ...over
});
const view = (over = {}, providers = {}) => ({
  provider: "gemini",
  provider_source: "default",
  provider_override: null,
  configured: false,
  providers: ["groq", "gemini", "claude", "compat"].map((id) => provider(id, providers[id])),
  file: "/path/to/.multiplayer-ai/settings.json",
  problem: null,
  storage: { kind: "sqlite", file: "/path/to/.multiplayer-ai/multiplayer-ai.db", folder: "/path/to/.multiplayer-ai" },
  ...over
});
const withSavedGroq = () =>
  view({ provider: "groq", provider_source: "saved", configured: true }, { groq: { key: { present: true, source: "saved", last4: KEY.slice(-4), saved: true, saved_last4: KEY.slice(-4) } } });

/** Answers the admin routes. `handlers` maps "METHOD /path" to (body) => { status?, json }. */
async function mockAdmin(page, handlers = {}) {
  const calls = [];
  await page.route(/\/api\/(settings|data|status)/, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.postData() ? req.postDataJSON() : undefined;
    calls.push({ method: req.method(), path, body });
    const handler = handlers[`${req.method()} ${path}`];
    if (!handler) return route.fulfill({ status: 404, json: { error: "not mocked", code: "NOT_FOUND" } });
    const out = handler(body);
    return route.fulfill({ status: out.status ?? 200, headers: out.headers, json: out.json, body: out.body });
  });
  return calls;
}
const needsLink = { status: 401, json: { error: "Open Multiplayer AI from the link in the terminal.", code: "ADMIN_LINK_NEEDED" } };

// ── Setup ───────────────────────────────────────────────────────────

test("/setup: choose a provider, paste a key, test it, save it, and carry on to start a room; the key goes nowhere but the request body", async ({ page }) => {
  let saved = view();
  const calls = await mockAdmin(page, {
    "GET /api/settings": () => ({ json: saved }),
    "POST /api/settings/key/test": () => ({ json: { ok: true, model: "openai/gpt-oss-120b" } }),
    "PUT /api/settings": () => ({ json: (saved = view({ provider: "groq", provider_source: "saved" })) }),
    "PUT /api/settings/key": () => ({ json: (saved = withSavedGroq()) }),
    "GET /api/status": () => ({ json: { configured: true } })
  });
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Set up a model key" })).toBeVisible();

  await page.getByRole("radio", { name: "Groq" }).check();
  await expect(page.getByText("console.groq.com/keys")).toBeVisible();
  await expect(page.getByText("Your key will be sent to:")).toContainText("api.groq.com (https, port 443)");
  const field = page.getByLabel("API key");
  await expect(field).toHaveAttribute("type", "password");
  await expect(field).toHaveAttribute("autocomplete", "off");
  const test = page.getByRole("button", { name: "Test key" });
  const save = page.getByRole("button", { name: "Save and continue" });
  await expect(test).toBeDisabled();
  await expect(save).toBeDisabled();

  await field.fill(KEY);
  await test.click();
  await expect(page.getByRole("status")).toContainText("The key works.");
  expect(calls.find((c) => c.path === "/api/settings/key/test").body).toMatchObject({ provider: "groq", key: KEY });

  await save.click();
  await expect(page).toHaveURL(/\/new$/);
  expect(calls.find((c) => c.method === "PUT" && c.path === "/api/settings/key").body).toEqual({ provider: "groq", key: KEY });

  // The key is in no address, no storage, and not on the page that follows.
  expect(page.url()).not.toContain(KEY);
  expect(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]))).not.toContain(KEY);
  expect(await page.content()).not.toContain(KEY);
  for (const c of calls.filter((c) => c.method === "GET")) expect(c.path).not.toContain(KEY);
});

test("/setup: a key that fails the test says why in plain words, and can still be saved", async ({ page }) => {
  await mockAdmin(page, {
    "GET /api/settings": () => ({ json: view() }),
    "POST /api/settings/key/test": () => ({ json: { ok: false, code: "BAD_KEY", message: "The provider didn't accept this key. Check that you copied all of it, and that it is a key for this provider." } })
  });
  await page.goto("/setup");
  await page.getByRole("radio", { name: "Gemini" }).check();
  await page.getByLabel("API key").fill(KEY);
  await page.getByRole("button", { name: "Test key" }).click();
  await expect(page.getByRole("status")).toContainText("The key didn't work.");
  await expect(page.getByRole("status")).toContainText("didn't accept this key");
  await expect(page.getByRole("button", { name: "Save and continue" })).toBeEnabled();
});

test("/setup: Claude is a choice, says where the key goes, and the test names it", async ({ page }) => {
  const calls = await mockAdmin(page, {
    "GET /api/settings": () => ({ json: view() }),
    "POST /api/settings/key/test": () => ({ json: { ok: true, model: "claude-haiku-4-5-20251001" } })
  });
  await page.goto("/setup");
  await page.getByRole("radio", { name: "Claude" }).check();
  await expect(page.getByText("api.anthropic.com (https, port 443)")).toBeVisible();
  await expect(page.getByRole("link", { name: "console.anthropic.com" })).toBeVisible();
  await page.getByLabel("API key").fill(KEY);
  await page.getByRole("button", { name: "Test key" }).click();
  await expect(page.getByRole("status")).toContainText("claude-haiku-4-5-20251001");
  expect(calls.find((c) => c.path === "/api/settings/key/test").body).toMatchObject({ provider: "claude", key: KEY });
  expect(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]))).not.toContain(KEY);
});

test("/setup: the Claude choice is labelled experimental, and no other choice is", async ({ page }) => {
  await mockAdmin(page, { "GET /api/settings": () => ({ json: view() }) });
  await page.goto("/setup");
  const note = "Experimental: not yet tested against the real service.";
  await expect(page.getByRole("radio", { name: "Claude (experimental)" })).toBeVisible();
  for (const name of ["Groq", "Gemini", "OpenAI-compatible"]) await expect(page.getByRole("radio", { name })).not.toContainText("experimental");
  await expect(page.getByText(note)).toHaveCount(0);
  await page.getByRole("radio", { name: "Claude" }).check();
  await expect(page.getByText(note)).toBeVisible();
  await page.getByRole("radio", { name: "Groq" }).check();
  await expect(page.getByText(note)).toHaveCount(0);
});

test("/settings: when Claude is the provider, the experimental note is shown", async ({ page }) => {
  await mockAdmin(page, { "GET /api/settings": () => ({ json: view({ provider: "claude", provider_source: "saved", configured: true }) }) });
  await page.goto("/settings");
  await expect(page.getByText("Replies come from Claude.")).toBeVisible();
  await expect(page.getByText("Experimental: not yet tested against the real service.").first()).toBeVisible();
});

test("/setup: choosing the provider that needs a model name shows the model field without opening anything, and the others keep it folded", async ({ page }) => {
  await mockAdmin(page, { "GET /api/settings": () => ({ json: view() }) });
  await page.goto("/setup");
  await expect(page.getByLabel("Model")).toBeHidden();
  await page.getByRole("radio", { name: "OpenAI-compatible" }).check();
  await expect(page.getByLabel("Model")).toBeVisible();
  await page.getByRole("radio", { name: "Groq" }).check();
  await expect(page.getByLabel("Model")).toBeHidden();
});

test("/setup: an OpenAI-compatible provider shows exactly where the key will be sent, refuses plain http, and needs a model", async ({ page }) => {
  await mockAdmin(page, {
    "GET /api/settings": () => ({ json: view() }),
    "POST /api/settings/base-url/check": (body) =>
      body.base_url.startsWith("https://")
        ? { json: { ok: true, display: "api.example.com (https, port 443)", host: "api.example.com", local: false } }
        : { json: { ok: false, message: "Plain http would send your key unprotected. Use an https address (http is allowed only for this computer, such as http://localhost:11434/v1)." } }
  });
  await page.goto("/setup");
  await page.getByRole("radio", { name: "OpenAI-compatible" }).check();
  const save = page.getByRole("button", { name: "Save and continue" });
  await expect(page.getByText("Enter the address to see where your key would be sent.")).toBeVisible();

  await page.getByLabel("Address").fill("http://api.example.com/v1");
  await expect(page.getByText("Plain http would send your key unprotected")).toBeVisible();
  await expect(save).toBeDisabled();

  await page.getByLabel("Address").fill("https://api.example.com/v1");
  await expect(page.getByText("Your key will be sent to:")).toContainText("api.example.com (https, port 443)");
  await page.getByLabel("API key").fill(KEY);
  await expect(save).toBeDisabled(); // no model yet
  await page.getByLabel("Model", { exact: true }).fill("some-model");
  await expect(save).toBeEnabled();
});

test("an environment variable that overrides a setting is named, and the key's last four characters are shown, never the key", async ({ page }) => {
  await mockAdmin(page, {
    "GET /api/settings": () =>
      ({
        json: view({ provider: "groq", provider_source: "env", provider_override: { field: "provider", variable: "PROVIDER" }, configured: true }, {
          groq: { key: { present: true, source: "env", last4: "0042", saved: false, saved_last4: null }, overrides: [{ field: "key", variable: "GROQ_API_KEY" }, { field: "model", variable: "GROQ_MODEL" }] }
        })
      })
  });
  await page.goto("/settings");
  await expect(page.getByText("PROVIDER", { exact: true })).toBeVisible();
  await expect(page.getByText("GROQ_API_KEY", { exact: true })).toBeVisible();
  await expect(page.getByText("GROQ_MODEL", { exact: true })).toBeVisible();
  await expect(page.getByText(/A key ending in 0042 is in use, from an environment variable/)).toBeVisible();
  expect(await page.content()).not.toContain(KEY);
});

test("without the terminal's sign-in link, Setup and Settings say to open Multiplayer AI from it", async ({ page }) => {
  await mockAdmin(page, { "GET /api/settings": () => needsLink });
  for (const route of ["/setup", "/settings"]) {
    await page.goto(route);
    await expect(page.getByText("Open Multiplayer AI from the terminal's link", { exact: true })).toBeVisible();
    await expect(page.getByText(/press Enter in the terminal for a new one/)).toBeVisible();
    await expect(page.getByLabel("API key")).toHaveCount(0);
  }
});

test("/signin-expired: says the link was used up or timed out, and what to do about it", async ({ page }) => {
  await page.goto("/signin-expired");
  await expect(page.getByText("That sign-in link has expired", { exact: true })).toBeVisible();
  await expect(page.getByText(/press Enter for a new one/)).toBeVisible();
  await expect(page.getByText(/SIGUSR2/)).toBeVisible();
});

test("on a different computer, Setup and Settings say they work only where Multiplayer AI runs", async ({ page }) => {
  await mockAdmin(page, { "GET /api/settings": () => ({ status: 403, json: { error: "x", code: "ADMIN_LOCAL_ONLY" } }) });
  await page.goto("/settings");
  await expect(page.getByText("Only on the computer running Multiplayer AI", { exact: true })).toBeVisible();
});

// ── Settings ────────────────────────────────────────────────────────

test("/settings: where things are kept, with the plain statement of what the file protects and what it does not", async ({ page }) => {
  await mockAdmin(page, { "GET /api/settings": () => ({ json: withSavedGroq() }) });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("/path/to/.multiplayer-ai", { exact: true })).toBeVisible();
  await expect(page.getByText("/path/to/.multiplayer-ai/settings.json")).toBeVisible();
  await expect(page.getByText(/keeps other accounts on this computer out\. It does not protect against anyone who can use your account/)).toBeVisible();
  const privacy = page.getByText(/Your rooms and settings are stored on this computer only\./);
  await expect(privacy).toContainText("The only thing that leaves it is what Multiplayer AI sends to the provider you chose");
  await expect(privacy).toContainText("The page loads its fonts and everything else from Multiplayer AI itself");
  await expect(privacy).not.toContainText("Google");
  await expect(privacy).toContainText("nothing is sent to any other host");
  await expect(page.getByText(`ending in ${KEY.slice(-4)}`).first()).toBeVisible();
});

test("/settings: deleting the saved key needs the exact phrase; a wrong phrase leaves the button off", async ({ page }) => {
  let current = withSavedGroq();
  const calls = await mockAdmin(page, {
    "GET /api/settings": () => ({ json: current }),
    "DELETE /api/settings/key": () => ({ json: (current = view({ provider: "groq", provider_source: "saved" })) })
  });
  await page.goto("/settings");
  const confirm = page.getByLabel("Type “delete key” to confirm");
  const button = page.getByRole("button", { name: "Delete saved key" });
  await expect(button).toBeDisabled();
  await confirm.fill("Delete key");
  await expect(button).toBeDisabled();
  await confirm.fill("delete key");
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByText("The saved Groq key was deleted.")).toBeVisible();
  expect(calls.find((c) => c.method === "DELETE").body).toEqual({ provider: "groq", confirm: "delete key" });
  await expect(page.getByRole("button", { name: "Delete saved key" })).toHaveCount(0); // nothing saved any more
});

test("/settings: deleting every room needs its own phrase, says plainly when an agent is mid-reply, and reports what it deleted", async ({ page }) => {
  let attempt = 0;
  const calls = await mockAdmin(page, {
    "GET /api/settings": () => ({ json: withSavedGroq() }),
    "POST /api/data/delete-rooms": () =>
      ++attempt === 1
        ? { status: 409, json: { error: "An agent is replying right now. Wait for it to finish, then try again.", code: "AGENT_WORKING" } }
        : { json: { deleted_rooms: 3, removed_backups: 1 } }
  });
  await page.goto("/settings");
  const button = page.getByRole("button", { name: "Delete all rooms" });
  const confirm = page.getByLabel("Type “delete all rooms” to confirm");
  await confirm.fill("delete key");
  await expect(button).toBeDisabled(); // the other action's phrase does not count
  await confirm.fill("delete all rooms");
  await button.click();
  await expect(page.getByRole("alert").filter({ hasText: "Wait for it to finish" })).toBeVisible();
  await button.click();
  await expect(page.getByText("Deleted 3 rooms and 1 backup copy.")).toBeVisible();
  expect(calls.filter((c) => c.path === "/api/data/delete-rooms").map((c) => c.body)).toEqual([{ confirm: "delete all rooms" }, { confirm: "delete all rooms" }]);
});

test("/settings: Download an export hands the browser a file", async ({ page }) => {
  await mockAdmin(page, {
    "GET /api/settings": () => ({ json: withSavedGroq() }),
    "POST /api/data/export": () => ({
      headers: { "content-disposition": 'attachment; filename="multiplayer-ai-export-2026-10-08.json"' },
      body: '{"format":"multiplayer-ai-export","version":1,"rooms":[]}'
    })
  });
  await page.goto("/settings");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download an export" }).click()]);
  expect(download.suggestedFilename()).toBe("multiplayer-ai-export-2026-10-08.json");
  await expect(page.getByText("Saved as multiplayer-ai-export-2026-10-08.json in your downloads.")).toBeVisible();
});

// ── Starting a room without a key, and rooms that were deleted ───────

test("/new: with no key set up it says so plainly and sends the person to Setup, instead of showing a form that can't work", async ({ page }) => {
  await mockAdmin(page, { "GET /api/status": () => ({ json: { configured: false } }) });
  await page.goto("/new");
  await expect(page.getByRole("heading", { name: "No model key yet" })).toBeVisible();
  await expect(page.getByText(/set one up; it takes about a minute/)).toBeVisible();
  await expect(page.getByLabel("What should the agent work on?")).toHaveCount(0);
  await page.getByRole("link", { name: "Set up a key" }).click();
  await expect(page).toHaveURL(/\/setup\?next=\/new$/);
});

test("/new: a refused start (NO_KEY from the server, for a stale tab) shows the same message", async ({ page }) => {
  await mockAdmin(page, { "GET /api/status": () => ({ json: { configured: true } }) });
  await mockApi(page, { onTool: { create_session: () => ({ status: 409, json: { error: "No model key is set up on this computer yet.", code: "NO_KEY" } }) } });
  await page.goto("/new");
  await page.getByLabel("What should the agent work on?").fill("Plan the launch");
  await page.getByLabel("Your name").fill("Dana");
  await page.getByRole("button", { name: "Start room" }).click();
  await expect(page.getByRole("heading", { name: "No model key yet" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Set up a key" })).toBeVisible();
});

test("/new: when the server can't be asked, the form is shown as before", async ({ page }) => {
  await page.route("**/api/status", (route) => route.abort());
  await page.goto("/new");
  await expect(page.getByLabel("What should the agent work on?")).toBeVisible();
});

test("an open room whose rooms were all deleted says so, clearly, and offers a new room", async ({ page }) => {
  await asReturning(page, { name: "Dana", token: "mpai_dana" });
  await mockApi(page, {
    onJoin: () => ({ json: roomState() }),
    stream: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse({ type: "state", data: roomState() }, { type: "deleted", data: {} }) })
  });
  await page.goto(`/s/${ROOM}`);
  await expect(page.getByText("The rooms were deleted", { exact: true })).toBeVisible();
  await expect(page.getByText(/can't be recovered/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Start a room" })).toBeVisible();
  expect(await page.evaluate((r) => localStorage.getItem(`multiplayer-ai:token:${r}`), ROOM)).toBeNull();
});

// ── accessibility, every theme and mode ──────────────────────────────

for (const theme of THEMES) {
  for (const mode of MODES) {
    test(`axe: setup, settings and the no-key start screen · ${theme} · ${mode}`, async ({ page }) => {
      await stubFonts(page);
      await prime(page, { theme, mode });
      await mockAdmin(page, {
        "GET /api/settings": () => ({ json: withSavedGroq() }),
        "GET /api/status": () => ({ json: { configured: false } }),
        "POST /api/settings/key/test": () => ({ json: { ok: false, code: "BAD_KEY", message: "The provider didn't accept this key." } })
      });
      await page.goto("/setup");
      await expect(page.getByRole("heading", { name: "Set up a model key" })).toBeVisible();
      await page.getByLabel("API key").fill(KEY);
      await page.getByRole("button", { name: "Test key" }).click();
      await expect(page.getByRole("status")).toBeVisible();
      await expectNoViolations(page, `setup · ${theme} · ${mode}`);

      await page.goto("/settings");
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
      await expectNoViolations(page, `settings · ${theme} · ${mode}`);

      await page.goto("/new");
      await expect(page.getByRole("heading", { name: "No model key yet" })).toBeVisible();
      await expectNoViolations(page, `no key · ${theme} · ${mode}`);

      await page.goto("/signin-expired");
      await expect(page.getByText("That sign-in link has expired", { exact: true })).toBeVisible();
      await expectNoViolations(page, `sign-in expired · ${theme} · ${mode}`);
    });
  }
}
