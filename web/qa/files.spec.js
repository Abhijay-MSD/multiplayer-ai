import { test, expect } from "./test-base.js";
import AxeBuilder from "@axe-core/playwright";
import { THEMES, MODES, prime, stubFonts } from "./helpers.js";
import { ROOM, NOW, mockApi, asReturning, sse } from "./api-mocks.js";

// The room's files in the browser, against a mocked API: the Files tab, viewing, copying and downloading, the host's
// history, restore and delete, attaching text files from the composer, and the host's switch for the agent. What the server
// does with names, content, sizes and who may do what is covered by the server's tests.

async function expectNoViolations(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

const person = (name, role, extra = {}) => ({ session_id: ROOM, name, role, last_seen: NOW(), is_host: false, ...extra });
function roomFor(me, { controller = "Maya", filesEnabled = true, withFilesFlag = true } = {}) {
  return {
    session: { id: ROOM, title: "Plan the launch", task: "Plan the launch", status: "active", step_count: 1, agent_working: false, control_policy: "ask", ...(withFilesFlag ? { files_enabled: filesEnabled } : {}) },
    room: { state: "open", archive_after_days: 7, sharing: false, control_policy: "ask" },
    participants: [person("Maya", controller === "Maya" ? "controller" : "watcher", { is_host: true }), ...(me === "Maya" ? [] : [person(me, controller === me ? "controller" : "watcher")])],
    events: [
      { id: 1, session_id: ROOM, kind: "join", author: "Maya", content: "Maya created the session.", created_at: NOW() },
      { id: 2, session_id: ROOM, kind: "directive", author: "Maya", content: "Plan the launch", created_at: NOW() },
      { id: 3, session_id: ROOM, kind: "status", author: "system", content: "Created notes.md, 21 bytes", created_at: NOW() },
      { id: 4, session_id: ROOM, kind: "agent_message", author: "agent", content: "I wrote notes.md.", reply_to: 2, created_at: NOW() }
    ],
    you: { name: me, role: controller === me ? "controller" : "watcher" }
  };
}
const streamFor = (state) => () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse({ type: "state", data: state }) });

const LIMITS = { maxFileBytes: 204800, maxFiles: 50, maxTotalBytes: 2097152 };
const FILE = (name, size, version, who = "agent", extra = {}) => ({ name, size, version, updated_by: who, on_behalf_of: who === "agent" ? "Maya" : null, updated_at: NOW(), ...extra });
const NOTES = FILE("notes.md", 21, 2);
const SCRIPT = "<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n# Heading";

/** A room page with the files API mocked. `files` is the current list; `contents` maps name to text. */
async function filesRoom(page, { me = "Dana", controller = "Maya", host = false, files = [NOTES, FILE("data.csv", 12, 1, "Maya")], contents = {}, versions = {}, filesEnabled = true, withFilesFlag = true, panelFiles } = {}) {
  const state = roomFor(me, { controller, filesEnabled, withFilesFlag });
  const calls = { tools: [], host: [] };
  const live = { files: [...files] };
  await asReturning(page, { name: me, token: "mpai_" + me.toLowerCase() });
  await mockApi(page, {
    onJoin: () => ({ json: state }),
    stream: streamFor(state),
    onTool: {
      list_room_files: (body) => (calls.tools.push({ name: "list_room_files", body }), { json: { files: live.files, usage: { files: live.files.length, bytes: live.files.reduce((n, f) => n + f.size, 0) }, limits: LIMITS } }),
      get_room_file: (body) => {
        calls.tools.push({ name: "get_room_file", body });
        const f = live.files.find((x) => x.name === body.name);
        if (!f) return { status: 404, json: { error: "There is no such file in this room.", code: "FILE_NOT_FOUND" } };
        return { json: { file: { ...f, version: body.version ?? f.version, content: contents[body.name] ?? `text of ${body.name}` } } };
      },
      file_versions: (body) => (calls.tools.push({ name: "file_versions", body }), { json: { versions: versions[body.name] ?? [{ version: 2, size: 21, author: "agent", on_behalf_of: "Maya", created_at: NOW() }, { version: 1, size: 5, author: "Maya", on_behalf_of: null, created_at: NOW() }] } }),
      attach_file: (body) => {
        calls.tools.push({ name: "attach_file", body });
        if (body.name.includes("bad")) return { status: 400, json: { error: "That file name has a character that isn't allowed. A file name can use letters, digits, spaces, dots, dashes and underscores, up to 64 characters.", code: "BAD_FILE_NAME" } };
        live.files.push(FILE(body.name, body.content.length, 1, me));
        return { json: { file: FILE(body.name, body.content.length, 1, me), created: true } };
      }
    }
  });
  await page.route("**/api/status", (route) => route.fulfill({ json: { configured: true, sharing: false, host } }));
  await page.route("**/api/host/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.postData() ? req.postDataJSON() : undefined;
    calls.host.push({ method: req.method(), path, body });
    if (req.method() === "GET" && path === `/api/host/rooms/${ROOM}`) {
      return route.fulfill({ json: { room: { id: ROOM, title: "Plan the launch" }, policy: "ask", counters: { guest_messages: 0, guest_cap: 20, room_steps: 1, room_cap: 50 }, pending: [], people: [{ name: "Maya", role: "controller", is_host: true, last_seen: NOW() }], files: panelFiles ?? { available: true, enabled: filesEnabled, count: live.files.length, bytes: 33, limits: LIMITS }, share: { link: `http://127.0.0.1:3737/s/${ROOM}/join#k=abc`, qr_svg: null, sharing: false, needs_address: false, note: "x", warning: null } } });
    }
    if (path.endsWith("/files/delete")) live.files = live.files.filter((f) => f.name !== body.name);
    if (path.endsWith("/files/restore")) live.files = live.files.map((f) => (f.name === body.name ? { ...f, version: f.version + 1 } : f));
    return route.fulfill({ json: { room: { id: ROOM }, policy: "ask", counters: { guest_messages: 0, guest_cap: 20, room_steps: 1, room_cap: 50 }, pending: [], people: [], files: { available: true, enabled: true, count: live.files.length, bytes: 33, limits: LIMITS }, share: { link: "http://127.0.0.1:3737/x", qr_svg: null, sharing: false, needs_address: false, note: "x", warning: null } } });
  });
  return { calls, live };
}
const openFiles = async (page) => {
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.getByRole("heading", { name: "Files in this room" })).toBeVisible();
};

test("a copy with files shows a Files tab; a room without the flag (Supabase) does not", async ({ page }) => {
  await filesRoom(page);
  await page.goto(`/s/${ROOM}`);
  await expect(page.getByRole("tab", { name: "Files" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Conversation" })).toHaveAttribute("aria-selected", "true");
});

test("no Files tab and no attach button when the copy has no files", async ({ page }) => {
  await filesRoom(page, { me: "Maya", controller: "Maya", withFilesFlag: false });
  await page.goto(`/s/${ROOM}`);
  await expect(page.getByRole("textbox", { name: /Message the agent/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Files" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Attach text files" })).toHaveCount(0);
});

test("the Files tab lists each file with size, version, who changed it and when, and says what the agent may do", async ({ page }) => {
  await filesRoom(page);
  await openFiles(page);
  const items = page.locator('[data-part="file-item"]');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("notes.md");
  await expect(items.nth(0)).toContainText("21 bytes · version 2 · changed by the agent, for Maya at");
  await expect(items.nth(1)).toContainText("data.csv");
  await expect(items.nth(1)).toContainText("changed by Maya");
  await expect(page.locator('[data-part="files-usage"]')).toHaveText(/2 of 50 files · 33 bytes of 2\.0 MB/);
  await expect(page.getByText("The agent can read and write them while it answers the person steering.")).toBeVisible();
});

test("an empty room says so, for a guest and for the controller", async ({ page }) => {
  await filesRoom(page, { files: [] });
  await openFiles(page);
  await expect(page.locator('[data-part="files-empty"]')).toContainText("Files appear here when the agent writes one or the person steering attaches one.");
});

test("the agent being off is said in plain words", async ({ page }) => {
  await filesRoom(page, { filesEnabled: false });
  await openFiles(page);
  await expect(page.getByText("The agent is not using files in this room.")).toBeVisible();
});

test("a file opens as plain text: markup in it is shown as characters, nothing is injected, and nothing is run", async ({ page }) => {
  let dialog = false;
  page.on("dialog", (d) => ((dialog = true), d.dismiss()));
  await filesRoom(page, { contents: { "notes.md": SCRIPT } });
  await openFiles(page);
  await page.getByRole("button", { name: "Open notes.md" }).click();
  const text = page.getByLabel("Contents of notes.md");
  await expect(text).toHaveText(SCRIPT);
  expect(await text.locator("*").count()).toBe(0);
  expect(await page.locator("img[src='x']").count()).toBe(0);
  expect(dialog).toBe(false);
});

test("Copy puts the file's text on the clipboard, and Download saves it as plain text under a safe name", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await filesRoom(page, { files: [FILE("page.html", 5, 1, "Maya"), NOTES], contents: { "page.html": "<b>hi</b>" } });
  await openFiles(page);
  await page.getByRole("button", { name: "Open page.html" }).click();
  await page.getByRole("button", { name: "Copy page.html" }).click();
  await expect(page.locator('[data-part="files-status"]')).toHaveText("Copied page.html.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("<b>hi</b>");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download page.html" }).click()]);
  expect(download.suggestedFilename()).toBe("page.html.txt");
  const fs = await import("node:fs");
  expect(fs.readFileSync(await download.path(), "utf8")).toBe("<b>hi</b>");
});

test("a download never goes to an address: no token in a URL, and the content is requested by POST", async ({ page }) => {
  const urls = [];
  page.on("request", (r) => urls.push(r.url()));
  await filesRoom(page, { me: "Dana" });
  await openFiles(page);
  await page.getByRole("button", { name: "Open notes.md" }).click();
  await expect(page.getByLabel("Contents of notes.md")).toBeVisible();
  expect(urls.filter((u) => u.includes("mpai_"))).toEqual([]);
  expect(urls.some((u) => /\/api\/tools\/get_room_file/.test(u))).toBe(true);
});

test("a guest can view and download, and sees no history, restore, delete or attach", async ({ page }) => {
  await filesRoom(page, { me: "Dana", host: false });
  await openFiles(page);
  await expect(page.getByRole("button", { name: "Open notes.md" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^History of/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Delete / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Attach text files" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Conversation" }).click();
  await expect(page.getByRole("button", { name: "Attach text files" })).toHaveCount(0);
});

test("the host sees history and can restore an older version, with the host's own route", async ({ page }) => {
  const { calls } = await filesRoom(page, { me: "Maya", controller: "Maya", host: true });
  await openFiles(page);
  await page.getByRole("button", { name: "History of notes.md" }).click();
  const history = page.getByRole("group", { name: "History of notes.md" });
  await expect(history).toContainText("Version 2 · 21 bytes · the agent, for Maya");
  await expect(history).toContainText("Version 1 · 5 bytes · Maya");
  await expect(history.getByRole("button", { name: "Restore version 2 of notes.md" })).toHaveCount(0);
  await history.getByRole("button", { name: "View version 1 of notes.md" }).click();
  expect(calls.tools.find((c) => c.name === "get_room_file" && c.body.version === 1)).toBeTruthy();
  await page.getByRole("button", { name: "Close" }).first().click();
  await page.getByRole("button", { name: "History of notes.md" }).click();
  await page.getByRole("button", { name: "Restore version 1 of notes.md" }).click();
  await expect(page.locator('[data-part="files-status"]')).toHaveText("Restored notes.md to version 1.");
  expect(calls.host.find((c) => c.path.endsWith("/files/restore")).body).toEqual({ name: "notes.md", version: 1 });
});

test("the host deletes a file only after confirming, and keeping it changes nothing", async ({ page }) => {
  const { calls } = await filesRoom(page, { me: "Maya", controller: "Maya", host: true });
  await openFiles(page);
  await page.getByRole("button", { name: "Delete data.csv" }).click();
  await expect(page.getByRole("group", { name: "Delete data.csv?" })).toContainText("Delete data.csv and its older versions? This can't be undone.");
  await page.getByRole("button", { name: "Keep it" }).click();
  expect(calls.host.some((c) => c.path.endsWith("/files/delete"))).toBe(false);
  await page.getByRole("button", { name: "Delete data.csv" }).click();
  await page.getByRole("button", { name: "Delete file" }).click();
  await expect(page.locator('[data-part="files-status"]')).toHaveText("Deleted data.csv.");
  expect(calls.host.find((c) => c.path.endsWith("/files/delete")).body).toEqual({ name: "data.csv" });
  await expect(page.locator('[data-part="file-item"]')).toHaveCount(1);
});

test("the controller attaches a text file with the button; the name and text go to the server, and the line says so", async ({ page }) => {
  const { calls } = await filesRoom(page, { me: "Maya", controller: "Maya", host: true });
  await page.goto(`/s/${ROOM}`);
  await page.locator('input[type="file"]').setInputFiles({ name: "plan.md", mimeType: "text/markdown", buffer: Buffer.from("# Plan\nStep one\n") });
  await expect(page.getByText("Attached plan.md.")).toBeVisible();
  expect(calls.tools.find((c) => c.name === "attach_file").body).toMatchObject({ name: "plan.md", content: "# Plan\nStep one\n" });
});

test("a file dropped on the message bar is attached", async ({ page }) => {
  const { calls } = await filesRoom(page, { me: "Maya", controller: "Maya", host: true });
  await page.goto(`/s/${ROOM}`);
  const handle = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["dropped text"], "dropped.txt", { type: "text/plain" }));
    return dt;
  });
  await page.locator('[data-part="composer"]').dispatchEvent("drop", { dataTransfer: handle });
  await expect(page.getByText("Attached dropped.txt.")).toBeVisible();
  expect(calls.tools.find((c) => c.name === "attach_file").body).toMatchObject({ name: "dropped.txt", content: "dropped text" });
});

test("a file that isn't text is refused here with a plain message and never sent", async ({ page }) => {
  const { calls } = await filesRoom(page, { me: "Maya", controller: "Maya", host: true });
  await page.goto(`/s/${ROOM}`);
  await page.locator('input[type="file"]').setInputFiles([
    { name: "photo.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]) },
    { name: "nul.txt", mimeType: "text/plain", buffer: Buffer.from("a\u0000b") }
  ]);
  await expect(page.getByText("photo.png isn't a text file, so it wasn't attached. Only text can be attached.")).toBeVisible();
  await expect(page.getByText("nul.txt isn't a text file, so it wasn't attached. Only text can be attached.")).toBeVisible();
  expect(calls.tools.filter((c) => c.name === "attach_file")).toEqual([]);
});

test("a file over the size limit is refused before it is sent, once the limit is known", async ({ page }) => {
  const { calls } = await filesRoom(page, { me: "Maya", controller: "Maya", host: true });
  await openFiles(page); // loading the list tells the page the limit
  await page.getByRole("tab", { name: "Conversation" }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: "big.txt", mimeType: "text/plain", buffer: Buffer.alloc(210 * 1024, "a") });
  await expect(page.getByText(/big\.txt is 210\.0 KB, more than the 200\.0 KB a file can be here, so it wasn't attached\./)).toBeVisible();
  expect(calls.tools.filter((c) => c.name === "attach_file")).toEqual([]);
});

test("a name the server won't take can be changed and attached again", async ({ page }) => {
  const { calls } = await filesRoom(page, { me: "Maya", controller: "Maya", host: true });
  await page.goto(`/s/${ROOM}`);
  await page.locator('input[type="file"]').setInputFiles({ name: "bad report (1).txt", mimeType: "text/plain", buffer: Buffer.from("numbers") });
  const group = page.getByRole("group", { name: "Rename bad report (1).txt" });
  await expect(group).toContainText("can't be attached under that name");
  await expect(group.getByRole("textbox")).toHaveValue("bad report _1_.txt");
  await group.getByRole("textbox").fill("report-1.txt");
  await group.getByRole("button", { name: "Attach" }).click();
  await expect(page.getByText("Attached report-1.txt.")).toBeVisible();
  expect(calls.tools.filter((c) => c.name === "attach_file").map((c) => c.body.name)).toEqual(["bad report (1).txt", "report-1.txt"]);
});

test("the host's panel has the switch for the agent's use of files, and it calls the host's route", async ({ page }) => {
  const { calls } = await filesRoom(page, { me: "Maya", controller: "Maya", host: true });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: "Host controls" }).click();
  const box = page.getByRole("checkbox", { name: "Agent can use files" });
  await expect(box).toBeChecked();
  await expect(page.getByText(/It can't delete files, make folders, run code or reach the internet\./)).toBeVisible();
  await box.click();
  expect(calls.host.find((c) => c.method === "PUT" && c.path.endsWith("/files")).body).toEqual({ enabled: false });
});

test("the host's panel hides the switch when this copy has no files", async ({ page }) => {
  await filesRoom(page, { me: "Maya", controller: "Maya", host: true, panelFiles: { available: false, enabled: false, count: 0, bytes: 0, limits: LIMITS } });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: "Host controls" }).click();
  await expect(page.getByRole("heading", { name: "Host controls" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Agent can use files" })).toHaveCount(0);
});

test("keyboard only: the tabs move with the arrow keys, a file opens with Enter, and everything is reachable", async ({ page }) => {
  await filesRoom(page, { me: "Maya", controller: "Maya", host: true });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("tab", { name: "Conversation" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Files" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true"); // the arrow keys choose, as they do for the other tabs
  await expect(page.getByRole("heading", { name: "Files in this room" })).toBeVisible();
  await page.getByRole("button", { name: "Open notes.md" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Contents of notes.md")).toBeVisible();
  await page.getByLabel("Contents of notes.md").focus();
  await expect(page.getByLabel("Contents of notes.md")).toBeFocused();
  await page.getByRole("button", { name: "History of notes.md" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("group", { name: "History of notes.md" })).toBeVisible();
});

test("at 360px nothing scrolls sideways, the list and the viewer fit, and the attach controls wrap", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await filesRoom(page, { me: "Maya", controller: "Maya", host: true, files: [FILE("a-very-long-file-name-that-goes-on-and-on-and-on-forever.markdown", 2048, 12, "Maya"), NOTES], contents: { "a-very-long-file-name-that-goes-on-and-on-and-on-forever.markdown": "x".repeat(400) } });
  await openFiles(page);
  await page.getByRole("button", { name: /^Open a-very-long/ }).click();
  await expect(page.getByLabel(/^Contents of a-very-long/)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole("tab", { name: "Conversation" }).click();
  await expect(page.getByRole("button", { name: "Attach text files" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

for (const theme of THEMES) {
  for (const mode of MODES) {
    test(`axe: the Files tab with a file open, and the composer with attach, in ${theme} · ${mode}`, async ({ page }) => {
      await stubFonts(page);
      await prime(page, { theme, mode });
      await filesRoom(page, { me: "Maya", controller: "Maya", host: true });
      await openFiles(page);
      await page.getByRole("button", { name: "Open notes.md" }).click();
      await page.getByRole("button", { name: "History of data.csv" }).click();
      await expect(page.getByLabel("Contents of notes.md")).toBeVisible();
      await expectNoViolations(page, `${theme}/${mode} files`);
      await page.getByRole("tab", { name: "Conversation" }).click();
      await expect(page.getByRole("button", { name: "Attach text files" })).toBeVisible();
      await expectNoViolations(page, `${theme}/${mode} composer`);
    });
  }
}

test("with reduced motion nothing in the files tab animates", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await filesRoom(page);
  await openFiles(page);
  const animated = await page.evaluate(() => [...document.querySelectorAll('[data-part="files"], [data-part="files"] *')].filter((el) => getComputedStyle(el).animationName !== "none").length);
  expect(animated).toBe(0);
});
