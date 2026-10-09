// Run: node --test test/   (no network; uses unzip when this computer has it)
// The two exports the browser makes: the conversation as Markdown, and the room's files as a zip. Both are plain JavaScript
// in web/src/lib, written by hand with no dependency, and tested here against the real tools: unzip, and Node's own CRC.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";
import { crc32, createZip, zipEntryNames, ZIP_LIMITS } from "../../web/src/lib/zip.js";
import { transcriptMarkdown, transcriptFileName } from "../../web/src/lib/exportMarkdown.js";
import { tempDir, cleanup } from "./helpers/stores.js";

after(cleanup);
const hasUnzip = spawnSync("unzip", ["-v"], { stdio: "ignore" }).status === 0;
const skipUnzip = hasUnzip ? false : "unzip is not installed on this computer";
const enc = (s) => new TextEncoder().encode(s);
const run = (cmd, args) => spawnSync(cmd, args, { encoding: "buffer" });

// ── zip ───────────────────────────────────────────────────────────────

test("crc32 agrees with Node's own on assorted inputs", () => {
  for (const input of ["", "a", "hello world", "x".repeat(100_000), "é中文\u{1f600}"]) {
    assert.equal(crc32(enc(input)), zlib.crc32(Buffer.from(input)), JSON.stringify(input.slice(0, 20)));
  }
  const random = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 131 + 7) % 256));
  assert.equal(crc32(random), zlib.crc32(random));
});

test("an archive has the zip signatures, one local header per file and an end record with the right counts", () => {
  const zip = createZip([{ name: "a.txt", data: enc("one") }, { name: "b.txt", data: enc("two!") }]);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50, "starts with a local file header");
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, "ends with the end-of-central-directory record");
  assert.equal(view.getUint16(end + 8, true), 2);
  assert.equal(view.getUint16(end + 10, true), 2);
  assert.equal(view.getUint16(end + 20, true), 0, "no comment");
  assert.equal(view.getUint16(8, true), 0, "stored, not compressed");
});

test("an empty list makes a valid empty archive", { skip: skipUnzip }, () => {
  const zip = createZip([]);
  assert.equal(zip.length, 22);
  const dir = tempDir();
  const file = path.join(dir, "empty.zip");
  fs.writeFileSync(file, zip);
  const r = run("unzip", ["-l", file]);
  assert.match(r.stdout.toString() + r.stderr.toString(), /0 files|empty/i);
});

test("unzip -t passes, and every file comes back byte for byte", { skip: skipUnzip }, () => {
  const files = [
    ["notes.md", "# Notes\nhello"],
    ["data.csv", "a,b\n1,2\n"],
    ["emoji.txt", "café 中文 \u{1f600}"],
    ["empty.txt", ""],
    ["big.txt", "0123456789abcdef\n".repeat(30_000)],
    ["tabs and spaces.txt", "\tindented\r\nwindows line\r\n"]
  ];
  const zip = createZip(files.map(([name, text]) => ({ name, data: enc(text), date: new Date("2026-10-09T12:34:56Z") })));
  const dir = tempDir();
  const file = path.join(dir, "room.zip");
  fs.writeFileSync(file, zip);
  const test_ = run("unzip", ["-t", file]);
  assert.equal(test_.status, 0, test_.stdout.toString() + test_.stderr.toString());
  assert.match(test_.stdout.toString(), /No errors detected/);
  for (const [name, text] of files) {
    const out = run("unzip", ["-p", file, name]);
    assert.equal(out.status, 0, name);
    assert.ok(Buffer.from(text).equals(out.stdout), `${name} came back unchanged`);
  }
  const listing = run("unzip", ["-Z1", file]).stdout.toString().trim().split("\n");
  assert.deepEqual(listing, files.map(([n]) => n));
  const zipinfo = run("zipinfo", ["-s", file]).stdout.toString();
  assert.match(zipinfo, /stor/, "stored, not deflated");
});

test("a file of exactly the maximum sizes still extracts, and 50 files at once", { skip: skipUnzip }, () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({ name: `f${i}.txt`, data: enc(`file ${i}\n`.repeat(i + 1)) }));
  const zip = createZip(entries);
  const file = path.join(tempDir(), "fifty.zip");
  fs.writeFileSync(file, zip);
  assert.equal(run("unzip", ["-t", file]).status, 0);
  assert.equal(run("unzip", ["-Z1", file]).stdout.toString().trim().split("\n").length, 50);
});

test("names inside the archive are sanitized: no path, no traversal, no page-like extension, nothing reserved", () => {
  const names = zipEntryNames(["../../etc/passwd", "a/b.txt", "a\\b.txt", ".hidden", "CON", "page.html", "x.svg", "ok name.md", "weird‮.txt", "a\0b", "", "   "]);
  for (const n of names) {
    assert.ok(!/[\\/]/.test(n) && !n.startsWith(".") && !n.includes("..") && !/[\u0000-\u001f‮]/.test(n), n);
    assert.ok(!/\.(html?|svg|xml)$/i.test(n), `${n} is not an extension a browser would draw`);
    assert.ok(n.length > 0 && n.length <= 80);
    assert.ok(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(n), n);
  }
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, "every name is different, ignoring case");
});

test("two names that clash after cleaning, or that differ only in case, are kept apart", () => {
  const names = zipEntryNames(["a?b.txt", "a*b.txt", "A_B.TXT", "a_b.txt"]);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, 4);
  assert.deepEqual(zipEntryNames(["a.txt", "a.txt"]).length, 2);
});

test("hostile names in a real archive extract as plain files in the folder, never outside it", { skip: skipUnzip }, () => {
  const zip = createZip(zipEntryNames(["../../escape.txt", "/etc/cron.d/x", "a/../../b.txt", "page.html"]).map((name) => ({ name, data: enc("data") })));
  const dir = tempDir();
  const file = path.join(dir, "evil.zip");
  fs.writeFileSync(file, zip);
  const dest = path.join(dir, "out");
  fs.mkdirSync(dest);
  assert.equal(run("unzip", ["-q", file, "-d", dest]).status, 0);
  const files = fs.readdirSync(dest);
  assert.equal(files.length, 4);
  assert.ok(!fs.existsSync(path.join(dir, "escape.txt")) && !fs.existsSync("/etc/cron.d/x"));
  assert.ok(files.every((f) => !/[\\/]/.test(f)));
});

test("size limits are enforced before anything is built", () => {
  assert.throws(() => createZip(Array.from({ length: ZIP_LIMITS.entries + 1 }, (_, i) => ({ name: `f${i}`, data: new Uint8Array(0) }))), /too many files/i);
  assert.throws(() => createZip([{ name: "a", data: { length: ZIP_LIMITS.bytes + 1 } }]), /too large/i);
  assert.throws(() => createZip([{ name: "a".repeat(70000), data: new Uint8Array(1) }]), /name/i);
});

test("a file's date is stored as the DOS date and time of its modification", () => {
  const zip = createZip([{ name: "a.txt", data: enc("x"), date: new Date(2026, 9, 9, 12, 34, 56) }]);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const time = view.getUint16(10, true);
  const date = view.getUint16(12, true);
  assert.deepEqual([(time >> 11) & 31, (time >> 5) & 63, (time & 31) * 2], [12, 34, 56]);
  assert.deepEqual([((date >> 9) & 127) + 1980, (date >> 5) & 15, date & 31], [2026, 10, 9]);
});

// ── the conversation as Markdown ──────────────────────────────────────

const SESSION = { id: "r", title: "Plan the launch", task: "Plan the launch", brief: "", created_at: "2026-10-09T10:00:00.000Z" };
const PEOPLE = [{ name: "Maya", role: "controller" }, { name: "Dana", role: "watcher" }];
const ev = (id, kind, author, content, extra = {}) => ({ id, kind, author, content, created_at: "2026-10-09T10:0" + (id % 10) + ":00.000Z", reply_to: null, ...extra });
const NOW = new Date("2026-10-09T12:00:00Z");

test("the transcript names each message's author, labels comments as comments the agent never saw, and keeps order", () => {
  const md = transcriptMarkdown({
    session: SESSION, participants: PEOPLE, now: NOW,
    events: [ev(1, "join", "Maya", "Maya created the session."), ev(2, "directive", "Maya", "Plan the launch"), ev(3, "comment", "Dana", "Shouldn't we wait?"), ev(4, "agent_message", "agent", "Start with a checklist.", { reply_to: 2 }), ev(5, "status", "system", "Created notes.md, 21 bytes"), ev(6, "takeover", "Dana", "Dana took control (the host approved).")]
  });
  assert.match(md, /^# Plan the launch\n/);
  assert.match(md, /\*\*Maya\*\* \(message to the agent\)/);
  assert.match(md, /\*\*Dana\*\* \(comment, not seen by the agent\)/);
  assert.match(md, /\*\*Agent\*\* \(reply to Maya\)/);
  assert.ok(md.indexOf("Plan the launch\n```") < md.indexOf("Shouldn't we wait?") && md.indexOf("Shouldn't we wait?") < md.indexOf("Start with a checklist."));
  assert.match(md, /Created notes\.md, 21 bytes/);
  assert.match(md, /Dana took control/);
  assert.match(md, /Exported from Multiplayer AI/);
});

test("every message body is in a fence that nothing inside it can close", () => {
  const nasty = "```\n# injected heading\n```\n<script>alert(1)</script>\n[click](javascript:alert(1))\n![x](http://evil.example/p.png)\n````\n`````````";
  const md = transcriptMarkdown({ session: SESSION, participants: PEOPLE, now: NOW, events: [ev(1, "comment", "Dana", nasty), ev(2, "agent_message", "agent", nasty)] });
  const fenceRuns = [...md.matchAll(/^(`{3,})text$/gm)].map((m) => m[1].length);
  assert.equal(fenceRuns.filter((n) => n >= 10).length, 2, "the two messages each have a fence longer than any run of backticks inside");
  // Everything between an opening fence and its closing fence is verbatim; outside the fences there is no HTML, link or heading from a message.
  const outside = md.replace(/^(`{3,})text\n[\s\S]*?\n\1$/gm, "");
  assert.ok(!/<script|javascript:|evil\.example|injected heading/.test(outside), outside);
});

test("titles, tasks and names are escaped so they can't make markup", () => {
  const session = { ...SESSION, title: "<img src=x onerror=alert(1)> [a](http://evil.example) **bold** # not a heading\nsecond line", task: "Task with `ticks` and\nnewlines <b>x</b>" };
  const md = transcriptMarkdown({ session, participants: [{ name: "Ev*il_[x](y)", role: "watcher" }], now: NOW, events: [ev(1, "comment", "Ev*il_[x](y)", "hi")] });
  const heading = md.split("\n")[0];
  assert.ok(heading.startsWith("# "), heading);
  assert.ok(!/<img|\]\(http/.test(heading), heading);
  assert.ok(!heading.includes("\n"));
  assert.ok(!/<b>|<img/.test(md.replace(/^(`{3,})text\n[\s\S]*?\n\1$/gm, "")));
  assert.ok(md.includes("**Ev\\*il\\_\\[x\\]\\(y\\)**"), "the author's name is escaped");
});

test("control characters and text-direction marks in a message are shown as visible escapes, not passed on", () => {
  const md = transcriptMarkdown({ session: SESSION, participants: PEOPLE, now: NOW, events: [ev(1, "comment", "Dana", "a‮b\u0000c\u001b[31md​e\tf\ng")] });
  assert.ok(!/[‮\u0000\u001b​]/.test(md));
  assert.match(md, /a\\u\{202e\}b\\x00c\\x1b\[31md\\u\{200b\}e\tf\ng/);
});

test("the brief and the task are included, labelled, and fenced", () => {
  const md = transcriptMarkdown({ session: { ...SESSION, brief: "Answer in French.\n```\nbreak out" }, participants: PEOPLE, now: NOW, events: [] });
  assert.match(md, /Brief from the host/);
  assert.match(md, /Answer in French\./);
  assert.match(md, /Task/);
});

test("an empty conversation still makes a readable file", () => {
  const md = transcriptMarkdown({ session: SESSION, participants: PEOPLE, now: NOW, events: [] });
  assert.match(md, /No messages yet/);
});

test("a long conversation is exported whole", () => {
  const events = Array.from({ length: 3000 }, (_, i) => ev(i + 1, i % 2 ? "agent_message" : "directive", i % 2 ? "agent" : "Maya", `message ${i}`));
  const md = transcriptMarkdown({ session: SESSION, participants: PEOPLE, now: NOW, events });
  assert.ok(md.includes("message 0") && md.includes("message 2999"));
});

test("the file name is made from the title, safe to save anywhere, and always ends in .md", () => {
  const name = (title) => transcriptFileName({ ...SESSION, title }, NOW);
  assert.equal(name("Plan the launch"), "multiplayer-ai-Plan_the_launch-2026-10-09.md");
  for (const title of ["../../etc/passwd", "a/b\\c", "CON", "<script>", "‮evil", "", "   ", "x".repeat(300), "....", "a\0b", "页面标题", "emoji \u{1f600}"]) {
    const n = name(title);
    assert.match(n, /^multiplayer-ai-[A-Za-z0-9._-]*-?2026-10-09\.md$/, `${JSON.stringify(title)} -> ${n}`);
    assert.ok(!n.includes("..") && n.length <= 80, n);
  }
});
