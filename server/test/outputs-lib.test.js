// Run: node --test test/   (no network)
// The web app's rules for "Outputs": which fenced blocks of an agent reply are offered for copying and download,
// what the file is called, and the bounds. It is plain JavaScript in web/src/lib, tested here with the server's runner.
import test from "node:test";
import assert from "node:assert/strict";
import { safeFileName, parseFenceInfo, extractOutputs, LIMITS, describeSize, downloadText } from "../../web/src/lib/outputs.js";

test("a file name is only letters, digits, dot, dash and underscore, with no path in it", () => {
  const cases = [
    ["../../etc/passwd", "passwd"],
    ["a/b\\c.js", "c.js"],
    ["src/app.js", "app.js"],
    ['"><img src=x onerror=alert(1)>.js', "_img_src_x_onerror_alert_1_.js"],
    [".htaccess", "htaccess"],
    ["..", null],
    ["...", null],
    ["", null],
    ["   ", null],
    ["name with spaces.txt", "name_with_spaces.txt"],
    ["tab\tand\nnewline\u0000nul.py", "tab_and_newline_nul.py"],
    ["trailing.dot.", "trailing.dot"],
    ["résumé.md", "r_sum_.md"]
  ];
  for (const [input, want] of cases) assert.equal(safeFileName(input), want, JSON.stringify(input));
});

test("a name that would be a reserved device name on Windows is changed", () => {
  for (const n of ["CON", "con.txt", "PRN.js", "aux", "NUL.md", "COM1.txt", "lpt9"]) assert.match(safeFileName(n), /^_/, n);
  assert.equal(safeFileName("console.js"), "console.js");
});

test("page-like and script-host extensions get .txt added, so the file is not something a browser renders when opened", () => {
  for (const n of ["page.html", "p.HTM", "x.xhtml", "logo.svg", "d.xml", "a.mhtml", "app.hta"]) {
    assert.match(safeFileName(n), /\.txt$/, n);
  }
  assert.equal(safeFileName("page.html"), "page.html.txt");
  assert.equal(safeFileName("main.py"), "main.py");
});

test("a long name is cut to 80 characters and keeps its extension", () => {
  const name = safeFileName(`${"a".repeat(300)}.json`);
  assert.equal(name.length, 80);
  assert.ok(name.endsWith(".json"));
});

test("the fence's info text gives a language, or a file name, never anything else", () => {
  assert.deepEqual(parseFenceInfo(""), { language: null, fileName: null });
  assert.deepEqual(parseFenceInfo("js"), { language: "js", fileName: null });
  assert.deepEqual(parseFenceInfo("python"), { language: "python", fileName: null });
  assert.deepEqual(parseFenceInfo("main.py"), { language: null, fileName: "main.py" });
  assert.deepEqual(parseFenceInfo("js:src/app.js"), { language: "js", fileName: "app.js" });
  assert.deepEqual(parseFenceInfo("python title=a.py"), { language: "python", fileName: "a.py" });
  assert.deepEqual(parseFenceInfo("{.python}"), { language: "python", fileName: null });
  const hostile = parseFenceInfo('<img src=x onerror=alert(1)>');
  assert.ok(!hostile.language || /^[A-Za-z0-9+#._-]{1,24}$/.test(hostile.language));
  assert.ok(!hostile.fileName || /^[A-Za-z0-9._-]+$/.test(hostile.fileName));
  assert.ok((parseFenceInfo("x".repeat(500)).language ?? "").length <= 24);
});

const agent = (id, content) => ({ id, kind: "agent_message", author: "agent", content, created_at: `2026-10-08T10:0${id % 10}:00Z` });
const fence = (info, body) => "```" + info + "\n" + body + "\n```";

test("outputs come from agent replies only, newest reply first, reading order inside a reply", () => {
  const events = [
    agent(1, `first\n${fence("js", "one")}`),
    { id: 2, kind: "directive", author: "Maya", content: fence("js", "from a person") },
    { id: 3, kind: "comment", author: "Dana", content: fence("js", "from a comment") },
    agent(4, `${fence("py", "two")}\n\n${fence("py", "three")}`)
  ];
  const { items, total, shown } = extractOutputs(events);
  assert.deepEqual(items.map((o) => o.text), ["two", "three", "one"]);
  assert.equal(total, 3);
  assert.equal(shown, 3);
  assert.deepEqual(items.map((o) => o.eventId), [4, 4, 1]);
  assert.ok(items.every((o) => o.author === "agent"));
});

test("each output has a safe name, a language, a size and a flag for too large", () => {
  const big = "x".repeat(LIMITS.blockChars + 1);
  const { items } = extractOutputs([agent(1, `${fence("main.py", "print(1)")}\n${fence("", "plain")}\n${fence("json", "{}")}\n${fence("js", big)}`)]);
  const byText = Object.fromEntries(items.map((o) => [o.text.slice(0, 8), o]));
  assert.equal(byText["print(1)"].fileName, "main.py");
  assert.equal(byText["plain"].fileName, "output-1-2.txt");
  assert.equal(byText["{}"].fileName, "output-1-3.json");
  assert.equal(byText["xxxxxxxx"].fileName, "output-1-4.js");
  assert.equal(byText["xxxxxxxx"].tooLarge, true);
  assert.equal(byText["print(1)"].tooLarge, false);
  assert.ok(items.every((o) => /^[A-Za-z0-9._-]{1,80}$/.test(o.fileName)));
});

test("empty blocks are not outputs", () => {
  const { total } = extractOutputs([agent(1, `${fence("js", "")}\n${fence("js", "   ")}`)]);
  assert.equal(total, 0);
});

test("the list is bounded: only the newest 200 are listed, with the true total", () => {
  const events = Array.from({ length: 450 }, (_, i) => agent(i + 1, fence("txt", `block ${i + 1}`)));
  const { items, total, shown } = extractOutputs(events);
  assert.equal(total, 450);
  assert.equal(shown, LIMITS.listed);
  assert.equal(items.length, 200);
  assert.equal(items[0].text, "block 450");
  assert.equal(items.at(-1).text, "block 251");
});

test("a reply with thousands of blocks is handled quickly and still bounded", () => {
  const body = Array.from({ length: 8000 }, (_, i) => fence("txt", `b${i}`)).join("\n");
  const started = Date.now();
  const { items, total } = extractOutputs([agent(1, body)]);
  assert.equal(total, 8000);
  assert.equal(items.length, LIMITS.listed);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
});

test("a preview is short, whatever the block", () => {
  const long = Array.from({ length: 500 }, (_, i) => `line ${i} ${"y".repeat(200)}`).join("\n");
  const { items } = extractOutputs([agent(1, fence("txt", long))]);
  assert.ok(items[0].preview.length <= LIMITS.previewChars + 1);
  assert.ok(items[0].preview.split("\n").length <= LIMITS.previewLines);
  assert.equal(items[0].lines, 500);
});

test("sizes are described in words", () => {
  assert.equal(describeSize(1, 5), "1 line, 5 characters");
  assert.equal(describeSize(3, 1200), "3 lines, 1.2 KB");
  assert.equal(describeSize(10, 2_500_000), "10 lines, 2.4 MB");
});

test("downloadText cleans the name again itself, and hands the browser plain text only", () => {
  const made = [];
  const saved = { document: globalThis.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const anchor = { style: {}, click() { made.push({ download: this.download, href: this.href, rel: this.rel }); }, remove() {} };
  globalThis.document = { createElement: () => anchor, body: { appendChild() {} } };
  const blobs = [];
  URL.createObjectURL = (blob) => (blobs.push(blob), "blob:fake");
  URL.revokeObjectURL = () => {};
  try {
    const name = downloadText('../../x"><img src=x onerror=1>.html', "<script>1</script>");
    assert.match(name, /^[A-Za-z0-9._-]+$/);
    assert.equal(made[0].download, name);
    assert.equal(name.endsWith(".html.txt"), true);
    assert.equal(blobs[0].type, "text/plain;charset=utf-8");
    assert.equal(made[0].rel, "noopener");
    assert.equal(downloadText("..", "x"), "output.txt");
  } finally {
    globalThis.document = saved.document;
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
  }
});
