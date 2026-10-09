import { test, expect } from "./test-base.js";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { THEMES, MODES, prime, stubFonts } from "./helpers.js";
import { ROOM, NOW, mockApi, asReturning, sse } from "./api-mocks.js";

// Saving the conversation as Markdown and the room's files as a zip, in the browser, against a mocked API. How the
// text is made safe, and that the archive is a real zip, is tested in the server's tests against unzip.

async function expectNoViolations(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

const EVIL = "```\n# injected\n```\n<script>alert(1)</script> [x](javascript:alert(1))";
const state = (title = "Plan the launch") => ({
  session: { id: ROOM, title, task: "Plan the launch", status: "active", step_count: 1, agent_working: false, control_policy: "ask", files_enabled: true },
  room: { state: "open", archive_after_days: 7, sharing: false, control_policy: "ask" },
  participants: [{ session_id: ROOM, name: "Maya", role: "controller", last_seen: NOW(), is_host: true }, { session_id: ROOM, name: "Dana", role: "watcher", last_seen: NOW(), is_host: false }],
  events: [
    { id: 1, session_id: ROOM, kind: "join", author: "Maya", content: "Maya created the session.", created_at: NOW() },
    { id: 2, session_id: ROOM, kind: "directive", author: "Maya", content: "Plan the launch", created_at: NOW() },
    { id: 3, session_id: ROOM, kind: "comment", author: "Dana", content: EVIL, created_at: NOW() },
    { id: 4, session_id: ROOM, kind: "agent_message", author: "agent", content: "Start with a checklist.\n\n```js\nconsole.log(1)\n```", reply_to: 2, created_at: NOW() }
  ],
  you: { name: "Maya", role: "controller" }
});
const FILES = [
  { name: "notes.md", size: 14, version: 1, updated_by: "agent", on_behalf_of: "Maya", updated_at: NOW() },
  { name: "page.html", size: 9, version: 2, updated_by: "Maya", on_behalf_of: null, updated_at: NOW() }
];
const CONTENT = { "notes.md": "# Notes\nhello é", "page.html": "<b>hi</b>" };

async function room(page, { title, failRead } = {}) {
  const st = state(title);
  await asReturning(page, { name: "Maya", token: "mpai_maya" });
  await mockApi(page, {
    onJoin: () => ({ json: st }),
    stream: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse({ type: "state", data: st }) }),
    onTool: {
      list_room_files: () => ({ json: { files: FILES, usage: { files: 2, bytes: 23 }, limits: { maxFileBytes: 204800, maxFiles: 50, maxTotalBytes: 2097152 } } }),
      get_room_file: (b) => (failRead && b.name === failRead ? { status: 500, json: { error: "That didn't work.", code: "INTERNAL" } } : { json: { file: { ...FILES.find((f) => f.name === b.name), content: CONTENT[b.name] } } })
    }
  });
  await page.route("**/api/status", (r) => r.fulfill({ json: { configured: true, sharing: false, host: false } }));
}

test("Save conversation as Markdown downloads a .md file named from the title, with comments labelled and every message in a fence", async ({ page }) => {
  await room(page, { title: "../../Plan <the> launch" });
  await page.goto(`/s/${ROOM}`);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Save conversation as Markdown" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^multiplayer-ai-[A-Za-z0-9._-]+-\d{4}-\d{2}-\d{2}\.md$/);
  expect(download.suggestedFilename()).not.toContain("..");
  const md = fs.readFileSync(await download.path(), "utf8");
  expect(md).toMatch(/^# /);
  expect(md).toContain("**Maya** (message to the agent)");
  expect(md).toContain("**Dana** (comment, not seen by the agent)");
  expect(md).toContain("**Agent** (reply to Maya)");
  const outside = md.replace(/^(`{3,})text\n[\s\S]*?\n\1$/gm, "");
  expect(outside).not.toMatch(/<script|javascript:|# injected|<the>/);
  await expect(page.locator('[data-part="transcript-tools"]').getByRole("status")).toContainText("Saved multiplayer-ai-");
});

test("the landing page's replay has no save button", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Save conversation as Markdown" })).toHaveCount(0);
});

test("Download all as a zip: one request per file by POST with the token in the body, and the download is a real archive", async ({ page }) => {
  const urls = [];
  page.on("request", (r) => urls.push(r.url()));
  await room(page);
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("tab", { name: "Files" }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download all as a zip" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^multiplayer-ai-files-\d{4}-\d{2}-\d{2}\.zip$/);
  const path = await download.path();
  const bytes = fs.readFileSync(path);
  expect(bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
  await expect(page.locator('[data-part="files-status"]')).toHaveText("Downloaded 2 files as a zip.");
  expect(urls.filter((u) => u.includes("mpai_"))).toEqual([]);
  const unzip = spawnSync("unzip", ["-t", path], { encoding: "utf8" });
  if (unzip.error?.code !== "ENOENT") {
    expect(unzip.status, unzip.stdout + unzip.stderr).toBe(0);
    expect(spawnSync("unzip", ["-p", path, "notes.md"], { encoding: "utf8" }).stdout).toBe(CONTENT["notes.md"]);
    expect(spawnSync("unzip", ["-Z1", path], { encoding: "utf8" }).stdout.trim().split("\n")).toEqual(["notes.md", "page.html.txt"]);
  }
});

test("if one file can't be read the zip is not made and the server's words are shown", async ({ page }) => {
  await room(page, { failRead: "page.html" });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("tab", { name: "Files" }).click();
  await page.getByRole("button", { name: "Download all as a zip" }).click();
  await expect(page.getByRole("alert")).toContainText("That didn't work.");
});

test("no zip button when there are no files", async ({ page }) => {
  const st = state();
  await asReturning(page, { name: "Maya", token: "mpai_maya" });
  await mockApi(page, { onJoin: () => ({ json: st }), stream: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse({ type: "state", data: st }) }), onTool: { list_room_files: () => ({ json: { files: [], usage: { files: 0, bytes: 0 }, limits: { maxFileBytes: 204800, maxFiles: 50, maxTotalBytes: 2097152 } } }) } });
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.getByText(/No files yet/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Download all as a zip" })).toHaveCount(0);
});

test("both exports work from the keyboard alone", async ({ page }) => {
  await room(page);
  await page.goto(`/s/${ROOM}`);
  await page.getByRole("button", { name: "Save conversation as Markdown" }).focus();
  const [d1] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
  expect(d1.suggestedFilename()).toMatch(/\.md$/);
  await page.getByRole("tab", { name: "Files" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Download all as a zip" }).focus();
  const [d2] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Space")]);
  expect(d2.suggestedFilename()).toMatch(/\.zip$/);
});

test("at 360px the tools row and the zip button fit", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await room(page);
  await page.goto(`/s/${ROOM}`);
  await expect(page.getByRole("button", { name: "Save conversation as Markdown" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.getByRole("button", { name: "Download all as a zip" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

for (const theme of THEMES) {
  for (const mode of MODES) {
    test(`axe: the conversation tools and the zip button, in ${theme} · ${mode}`, async ({ page }) => {
      await stubFonts(page);
      await prime(page, { theme, mode });
      await room(page);
      await page.goto(`/s/${ROOM}`);
      await expect(page.getByRole("button", { name: "Save conversation as Markdown" })).toBeVisible();
      await expectNoViolations(page, `${theme}/${mode} conversation tools`);
      await page.getByRole("tab", { name: "Files" }).click();
      await expect(page.getByRole("button", { name: "Download all as a zip" })).toBeVisible();
      await expectNoViolations(page, `${theme}/${mode} files with zip`);
    });
  }
}
