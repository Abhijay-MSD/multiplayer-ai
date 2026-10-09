// Run: node --test test/   (no network)
import test from "node:test";
import assert from "node:assert/strict";
import { escapeForLog, hasUnsafeChars } from "../safe-text.js";

test("unsafe characters are named, and everything else is left alone", () => {
  assert.equal(escapeForLog("Sam\x1b[2J"), "Sam\\x1b[2J");
  assert.equal(escapeForLog("a\r\nb\tc\x00\x7f"), "a\\x0d\\x0ab\\x09c\\x00\\x7f");
  assert.equal(escapeForLog("\x9b31m\x85"), "\\x9b31m\\x85");
  assert.equal(escapeForLog("x\u202ey\u2066z\u200f\u061c"), "x\\u{202e}y\\u{2066}z\\u{200f}\\u{061c}");
  assert.equal(escapeForLog("a\u2028b\u2029c\u200bd\ufeff"), "a\\u{2028}b\\u{2029}c\\u{200b}d\\u{feff}");
  assert.equal(escapeForLog("lone \ud800 surrogate"), "lone \\u{d800} surrogate");
  assert.equal(escapeForLog("Zoë 李雷 🙂 C:\\temp O'Neil — ok"), "Zoë 李雷 🙂 C:\\temp O'Neil — ok");
});

test("the result never holds an unsafe character, whatever went in", () => {
  let all = "";
  for (let c = 0; c < 0x3000; c++) if (c < 0xd800 || c > 0xdfff) all += String.fromCodePoint(c);
  all += "\ud800\udc00x\udfff";
  assert.equal(hasUnsafeChars(escapeForLog(all)), false);
  assert.equal(hasUnsafeChars(all), true);
});

test("it accepts what is not text, and an error's message", () => {
  assert.equal(escapeForLog(undefined), "");
  assert.equal(escapeForLog(null), "");
  assert.equal(escapeForLog(42), "42");
  assert.equal(escapeForLog({ toString: () => "a\x1bb" }), "a\\x1bb");
  assert.equal(escapeForLog(new Error("bad \x1b[31m")), "bad \\x1b[31m");
});

test("escaping twice changes nothing more", () => {
  const once = escapeForLog("a\x1b\u202eb");
  assert.equal(escapeForLog(once), once);
});

test("hasUnsafeChars is not fooled by a previous match (no sticky regex state)", () => {
  for (let i = 0; i < 5; i++) assert.equal(hasUnsafeChars("a\x1bb"), true);
  for (let i = 0; i < 5; i++) assert.equal(hasUnsafeChars("ab"), false);
});
