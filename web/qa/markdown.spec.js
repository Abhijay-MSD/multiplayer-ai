import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { THEMES, MODES, prime, stubFonts } from "./helpers.js";
import { ROOM, NOW, mockApi, asReturning, sse } from "./api-mocks.js";

// Tables and links in the agent's replies, drawn in the browser. The rules for what is a table and what is a link are
// tested in the server's tests; this checks what is put on the page, and that markup in a reply is never made into elements.

async function expectNoViolations(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

async function replyRoom(page, reply) {
  const state = {
    session: { id: ROOM, title: "Plan", task: "Plan", status: "active", step_count: 1, agent_working: false },
    room: { state: "open", archive_after_days: 7, sharing: false },
    participants: [{ session_id: ROOM, name: "Maya", role: "controller", last_seen: NOW(), is_host: true }],
    events: [{ id: 1, session_id: ROOM, kind: "directive", author: "Maya", content: "Show me", created_at: NOW() }, { id: 2, session_id: ROOM, kind: "agent_message", author: "agent", content: reply, reply_to: 1, created_at: NOW() }],
    you: { name: "Maya", role: "controller" }
  };
  await asReturning(page, { name: "Maya", token: "mpai_maya" });
  await mockApi(page, { onJoin: () => ({ json: state }), stream: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse({ type: "state", data: state }) }) });
  await page.route("**/api/status", (r) => r.fulfill({ json: { configured: true, sharing: false, host: false } }));
  await page.goto(`/s/${ROOM}`);
  await expect(page.locator('[data-part="agent-body"]')).toBeVisible();
}
const body = (page) => page.locator('[data-part="agent-body"]');

const TABLE = "Here are the numbers:\n\n| Name | Qty | Note |\n|:--|--:|:-:|\n| apples | 3 | **red** |\n| pears | 10 | `ripe` |\n\nThat is all.";

test("a table is drawn as a table with a header row, aligned columns, and inline formatting in its cells", async ({ page }) => {
  await replyRoom(page, TABLE);
  const table = body(page).locator("table");
  await expect(table.locator("th")).toHaveText(["Name", "Qty", "Note"]);
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.locator("tbody tr").first().locator("td").nth(2).locator("strong")).toHaveText("red");
  await expect(table.locator("tbody tr").nth(1).locator("td").nth(2).locator("code")).toHaveText("ripe");
  expect(await table.locator("th").nth(1).evaluate((el) => getComputedStyle(el).textAlign)).toBe("right");
  expect(await table.locator("th").nth(2).evaluate((el) => getComputedStyle(el).textAlign)).toBe("center");
  await expect(body(page)).toContainText("That is all.");
  await expect(body(page).getByRole("region", { name: "Table" })).toBeVisible();
});

test("a malformed table is made to fit, and text that only looks like one stays text", async ({ page }) => {
  await replyRoom(page, "| a | b |\n|---|---|\n| only |\n| 1 | 2 | 3 |\n\nJust | some | pipes in a sentence.");
  await expect(body(page).locator("tbody tr")).toHaveCount(2);
  for (const row of await body(page).locator("tbody tr").all()) await expect(row.locator("td")).toHaveCount(2);
  await expect(body(page)).toContainText("Just | some | pipes in a sentence.");
  expect(await body(page).locator("table").count()).toBe(1);
});

test("a huge table is cut, and says how much isn't shown", async ({ page }) => {
  const cols = 25;
  const row = `| ${Array.from({ length: cols }, (_, i) => `c${i}`).join(" | ")} |`;
  const md = [`| ${Array.from({ length: cols }, (_, i) => `h${i}`).join(" | ")} |`, `|${Array.from({ length: cols }, () => "---").join("|")}|`, ...Array.from({ length: 700 }, () => row)].join("\n");
  const t0 = Date.now();
  await replyRoom(page, md);
  expect(Date.now() - t0).toBeLessThan(8000);
  await expect(body(page).locator("tbody tr")).toHaveCount(200);
  await expect(body(page).locator("th")).toHaveCount(20);
  await expect(body(page)).toContainText("The table is cut here: 500 more rows and 5 more columns not shown.");
});

test("markup, scripts and links in table cells are text, not elements", async ({ page }) => {
  let dialog = false;
  page.on("dialog", (d) => ((dialog = true), d.dismiss()));
  await replyRoom(page, "| <img src=x onerror=alert(1)> | [x](javascript:alert(1)) |\n|---|---|\n| <script>alert(1)</script> | <a href=\"javascript:alert(1)\">hi</a> |");
  expect(await page.locator("img[src='x']").count()).toBe(0);
  expect(await body(page).locator("script").count()).toBe(0);
  expect(await body(page).locator("a").count()).toBe(0);
  await expect(body(page).locator("th").first()).toHaveText("<img src=x onerror=alert(1)>");
  await expect(body(page).locator("td").first()).toHaveText("<script>alert(1)</script>");
  expect(dialog).toBe(false);
});

test("an http or https link is a real link: new tab, noopener noreferrer nofollow, and the full address on hover", async ({ page }) => {
  await replyRoom(page, "See [the docs](https://example.com/docs?a=1#top) and [plain http](http://example.org/x) for more.");
  const links = body(page).locator("a");
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute("href", "https://example.com/docs?a=1#top");
  await expect(links.first()).toHaveAttribute("target", "_blank");
  await expect(links.first()).toHaveAttribute("rel", "noopener noreferrer nofollow");
  await expect(links.first()).toHaveAttribute("title", "https://example.com/docs?a=1#top");
  await expect(links.first()).toHaveText("the docs");
  await expect(links.nth(1)).toHaveAttribute("href", "http://example.org/x");
});

test("links with another kind of address, images and raw HTML are text and nothing else", async ({ page }) => {
  let dialog = false;
  page.on("dialog", (d) => ((dialog = true), d.dismiss()));
  await replyRoom(page, [
    "[a](javascript:alert(1))", "[b](JaVaScRiPt:alert(1))", "[c](data:text/html,<script>alert(1)</script>)", "[d](file:///etc/passwd)", "[e](//example.com)", "[f](/relative)", "[g](example.com)", "[h](ftp://example.com)",
    "![img](https://example.com/p.png)", "<a href=\"https://example.com\">raw</a>", "<img src=x onerror=alert(1)>", "[i](https://user:pw@example.com/)"
  ].join("\n\n"));
  expect(await body(page).locator("a").count()).toBe(0);
  expect(await body(page).locator("img").count()).toBe(0);
  await expect(body(page)).toContainText("[a](javascript:alert(1))");
  await expect(body(page)).toContainText("![img](https://example.com/p.png)");
  await expect(body(page)).toContainText('<a href="https://example.com">raw</a>');
  expect(dialog).toBe(false);
});

test("a link inside a link's text isn't nested, and a link works inside bold and in a list and a table cell", async ({ page }) => {
  await replyRoom(page, "**[bold link](https://example.com/b)**\n\n- item [in list](https://example.com/l)\n\n| h |\n|---|\n| [in cell](https://example.com/c) |\n\n[outer [inner](https://example.com/i) text](https://example.com/o)");
  const links = body(page).locator("a");
  expect(await links.count()).toBeGreaterThanOrEqual(4);
  await expect(body(page).locator("strong a")).toHaveAttribute("href", "https://example.com/b");
  await expect(body(page).locator("li a")).toHaveAttribute("href", "https://example.com/l");
  await expect(body(page).locator("td a")).toHaveAttribute("href", "https://example.com/c");
  expect(await body(page).locator("a a").count()).toBe(0);
});

test("a very long address or label doesn't break the layout", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await replyRoom(page, `[${"w".repeat(150)}](https://example.com/${"a".repeat(900)})\n\n${TABLE}\n\n| ${"x".repeat(300)} | b |\n|---|---|\n| 1 | 2 |`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("a table can be scrolled to and read from the keyboard", async ({ page }) => {
  await replyRoom(page, TABLE);
  const region = body(page).getByRole("region", { name: "Table" });
  await region.focus();
  await expect(region).toBeFocused();
});

for (const theme of THEMES) {
  for (const mode of MODES) {
    test(`axe: a reply with a table and links, in ${theme} · ${mode}`, async ({ page }) => {
      await stubFonts(page);
      await prime(page, { theme, mode });
      await replyRoom(page, `${TABLE}\n\nRead [the docs](https://example.com/docs) or [more](http://example.org/more).`);
      await expectNoViolations(page, `${theme}/${mode} markdown`);
    });
  }
}
