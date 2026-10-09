// Run: node --test test/   (no network)
// What a room file may be called and what it may hold. The names are an allowlist, and no path is ever built from one
// (files live in the database), so these rules are about what people see and what a download is saved as.
import test from "node:test";
import assert from "node:assert/strict";
import { checkFileName, checkFileContent, fileNameKey, MAX_NAME_LENGTH } from "../files/names.js";

const refused = (name) => {
  const r = checkFileName(name);
  assert.equal(r.ok, false, `expected ${JSON.stringify(name)} to be refused`);
  assert.equal(r.code, "BAD_FILE_NAME");
  assert.ok(r.message.length > 0);
  return r;
};

test("ordinary names are accepted exactly as written", () => {
  for (const name of ["notes.md", "My Plan v2.txt", "data_1-final.csv", "a", "A.TXT", "x".repeat(MAX_NAME_LENGTH), "README", "v1.2.3.json"]) {
    const r = checkFileName(name);
    assert.equal(r.ok, true, name);
    assert.equal(r.name, name);
  }
});

test("hostile names are refused: traversal, separators, nulls and control characters", () => {
  for (const name of [
    "../etc/passwd", "..", ".", "...", "a/b", "/abs", "a\\b", "..\\..\\x", "C:\\x", "a\0b", "\0", "a\nb", "a\rb", "a\tb", "a\x1bb", "a\x7fb",
    "a..b", "%2e%2e", "%2e%2e%2fx", "a:b", "a*b", "a?b", "a<b", "a>b", "a|b", 'a"b', "~root", "a;b", "a&b", "$(x)", "`x`", "a'b", "a%b"
  ]) refused(name);
});

test("bidirectional overrides, zero-width and format characters, and look-alike letters are refused", () => {
  for (const name of [
    "\u202etxt.exe", "a\u202ab", "a\u2066b", "a\u200bb", "a\u200db", "a\u2060b", "a\ufeffb", "a\u00adb", "a\u00a0b", "a\u2028b", "a\u2029b",
    "\u0430pple.txt", "\u0391lpha.txt", "caf\u00e9.txt", "na\u0131ve.txt", "\uff41.txt", "\u{1d41a}.txt", "emoji\u{1f600}.txt", "a\u0301.txt", "\u4e2d\u6587.txt"
  ]) refused(name);
});

test("leading dots, trailing dots or spaces, and leading spaces are refused", () => {
  for (const name of [".hidden", ".git", "notes.", "notes ", " notes", "notes. ", "a.. "]) refused(name);
});

test("names Windows reserves are refused with or without an extension, in any case", () => {
  for (const name of ["CON", "con", "Con.txt", "PRN", "AUX.md", "NUL", "nul.txt", "COM1", "com9.txt", "LPT1", "lpt9.csv", "CONIN$"]) refused(name);
  for (const name of ["CONSOLE.txt", "COM0.txt", "COM10.txt", "console", "nullable.md", "LPT.txt"]) assert.equal(checkFileName(name).ok, true, name);
});

test("empty, too long, and anything that is not a string are refused", () => {
  for (const name of ["", " ", "x".repeat(MAX_NAME_LENGTH + 1), "x".repeat(10_000), undefined, null, 5, {}, [], ["a"], true, { toString: () => "a" }]) refused(name);
});

test("names that differ only in letter case have the same key", () => {
  assert.equal(fileNameKey("Notes.MD"), fileNameKey("notes.md"));
  assert.notEqual(fileNameKey("notes.md"), fileNameKey("notes2.md"));
  assert.equal(checkFileName("Notes.MD").key, "notes.md");
});

test("the message for a refused name does not repeat the name", () => {
  const r = checkFileName("\u202eevil\u202e<script>.txt");
  assert.equal(r.ok, false);
  assert.ok(!r.message.includes("evil") && !r.message.includes("script") && !/[\u202e<>]/.test(r.message));
});

test("content must be text: valid UTF-8, no NUL, a string", () => {
  assert.equal(checkFileContent("hello\nworld \u00e9 \u4e2d\u6587 \u{1f600}\ttab").ok, true);
  assert.equal(checkFileContent("").ok, true, "an empty file is allowed");
  assert.equal(checkFileContent("a\0b").ok, false);
  assert.equal(checkFileContent("a\ud800b").ok, false, "a lone surrogate is not valid UTF-8");
  assert.equal(checkFileContent("\udfff").ok, false);
  for (const v of [undefined, null, 5, {}, [], Buffer.from("x")]) assert.equal(checkFileContent(v).ok, false);
  const bad = checkFileContent("a\0b");
  assert.equal(bad.code, "BAD_FILE_CONTENT");
  assert.match(bad.message, /text/i);
});
