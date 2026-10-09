// Run: node --test test/   (no network)
// The pieces of the reply renderer that decide what is a table and what is a link, in plain JavaScript so they can be tested
// here. How they are drawn (and that no markup is ever built from text) is tested in the browser tests.
import test from "node:test";
import assert from "node:assert/strict";
import { parseBlocks, TABLE_LIMITS } from "../../web/src/lib/markdownBlocks.js";
import { parseLink, safeHref } from "../../web/src/lib/links.js";

const table = (md) => parseBlocks(md).find((b) => b.type === "table");

test("a simple table has a header, alignments and rows", () => {
  const t = table("| Name | Qty | Note |\n|:--|--:|:-:|\n| apples | 3 | red |\n| pears | 10 | |");
  assert.deepEqual(t.header, ["Name", "Qty", "Note"]);
  assert.deepEqual(t.align, ["left", "right", "center"]);
  assert.deepEqual(t.rows, [["apples", "3", "red"], ["pears", "10", ""]]);
});

test("pipes at the ends are optional, and an escaped pipe stays in its cell", () => {
  const t = table("a | b\n--- | ---\nx \\| y | z");
  assert.deepEqual(t.header, ["a", "b"]);
  assert.deepEqual(t.rows, [["x | y", "z"]]);
});

test("a malformed row is made to fit: short rows are padded, long ones cut", () => {
  const t = table("| a | b |\n|---|---|\n| only |\n| 1 | 2 | 3 | 4 |\n|");
  assert.deepEqual(t.rows.slice(0, 2), [["only", ""], ["1", "2"]]);
  assert.ok(t.rows.every((r) => r.length === 2));
});

test("text that only looks a bit like a table is not one", () => {
  for (const md of ["a | b\nnot a separator", "| a | b |", "just | some | pipes in a sentence", "| a | b |\n|---|\n| 1 | 2 |", "|---|---|\n| 1 | 2 |", "a\n---"]) {
    assert.equal(table(md), undefined, JSON.stringify(md));
  }
  assert.equal(table("| a | b |\n|---|---|")?.rows.length, 0, "a header with a separator and no rows is a table with no rows");
});

test("a table ends at the first line that isn't a row, and what follows is read as usual", () => {
  const blocks = parseBlocks("| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter the table.\n- item");
  assert.deepEqual(blocks.map((b) => b.type), ["table", "p", "ul"]);
});

test("a table inside a code fence is code, not a table", () => {
  const blocks = parseBlocks("```\n| a | b |\n|---|---|\n| 1 | 2 |\n```");
  assert.deepEqual(blocks.map((b) => b.type), ["code"]);
});

test("a huge table is cut to the limits and says so, and is read quickly", () => {
  const cols = TABLE_LIMITS.columns + 10;
  const head = `| ${Array.from({ length: cols }, (_, i) => `h${i}`).join(" | ")} |`;
  const sep = `|${Array.from({ length: cols }, () => "---").join("|")}|`;
  const row = `| ${Array.from({ length: cols }, (_, i) => `c${i}`).join(" | ")} |`;
  const md = [head, sep, ...Array.from({ length: TABLE_LIMITS.rows + 500 }, () => row)].join("\n");
  const t0 = Date.now();
  const t = table(md);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(t.header.length, TABLE_LIMITS.columns);
  assert.equal(t.rows.length, TABLE_LIMITS.rows);
  assert.deepEqual([t.cutRows, t.cutColumns], [500, 10]);
  assert.ok(t.rows.every((r) => r.length === TABLE_LIMITS.columns));
});

test("cells keep their text as text: markup in them is just characters in a string", () => {
  const t = table("| <img src=x onerror=alert(1)> | [x](javascript:alert(1)) |\n|---|---|\n| <script>alert(1)</script> | **b** |");
  assert.equal(t.header[0], "<img src=x onerror=alert(1)>");
  assert.equal(t.rows[0][0], "<script>alert(1)</script>");
});

// ── links ─────────────────────────────────────────────────────────────

test("only http and https addresses become links, and the address is the browser's own reading of it", () => {
  assert.equal(safeHref("https://example.com/a?b=c#d"), "https://example.com/a?b=c#d");
  assert.equal(safeHref("http://example.com"), "http://example.com/");
  assert.equal(safeHref("HTTPS://EXAMPLE.com/Path"), "https://example.com/Path");
  for (const bad of [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x", "file:///etc/passwd", "ftp://example.com", "mailto:a@b.c",
    "//example.com", "/relative/path", "example.com", "", "https://", "http://", "https:///path", "https://exa mple.com", "https://example.com/\u0000", "https://example.com/‮", "https://user:pass@example.com", "blob:https://example.com/x", "about:blank", "javascript&colon;alert(1)", "https://ok.example\n.evil", 5, null, undefined, {}
  ]) assert.equal(safeHref(bad), null, JSON.stringify(bad));
});

test("a very long address is refused, not truncated", () => {
  assert.equal(safeHref(`https://example.com/${"a".repeat(3000)}`), null);
  assert.ok(safeHref(`https://example.com/${"a".repeat(1000)}`));
});

test("a link is [text](address) with an address that has no spaces; images and everything else are not links", () => {
  assert.deepEqual(parseLink("[docs](https://example.com/x) after", 0), { text: "docs", href: "https://example.com/x", end: 29 });
  assert.equal(parseLink("![alt](https://example.com/p.png)", 0), null);
  assert.equal(parseLink("[docs](javascript:alert(1))", 0), null);
  assert.equal(parseLink("[docs](https://example.com/a b)", 0), null);
  assert.equal(parseLink("[docs] (https://example.com)", 0), null);
  assert.equal(parseLink("[](https://example.com)", 0), null);
  assert.equal(parseLink("[docs](https://example.com", 0), null);
  assert.equal(parseLink("[a](https://example.com)", 1), null, "starts only at the bracket");
  assert.equal(parseLink(`[${"x".repeat(500)}](https://example.com)`, 0), null);
});

test("a link's text may contain brackets and one level of parentheses in the address", () => {
  assert.equal(parseLink("[a [b] c](https://example.com/x)", 0)?.text, "a [b] c");
  assert.equal(parseLink("[w](https://en.example.org/wiki/Thing_(disambiguation))", 0)?.href, "https://en.example.org/wiki/Thing_(disambiguation)");
});
