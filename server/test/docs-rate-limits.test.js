// Run: node --test test/   (no network)
// What the docs say about a provider limiting how fast a key can be used has to stay honest: a per-minute limit belongs to the
// provider, the model and the account; one long task can exceed it because every call resends the room's context; long work is
// better asked for in smaller pieces; and the reading of the provider's wait is tested only against stand-ins.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SHORT_WAIT_SECONDS, CATEGORY_MESSAGES, rateLimitLine } from "../providers/failure.js";
import { CONTINUE_TEXT } from "../agent/length.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const doc = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\s+/g, " ");

for (const file of ["docs/limits.md", "docs/providers.md"]) {
  test(`${file}: per-minute limits depend on the provider, the model and the account, and must be looked up`, () => {
    const text = doc(file);
    assert.match(text, /per-minute limits depend on the provider, the model and your account/i);
    assert.match(text, /look them up in the provider's own documentation/i);
  });

  test(`${file}: one long task can pass a per-minute limit, because every call sends the room's context again`, () => {
    const text = doc(file);
    assert.match(text, /a single long task can pass a per-minute limit/i);
    assert.match(text, /every (model )?call sends the room's context again/i);
  });

  test(`${file}: ask for long work in smaller pieces`, () => {
    assert.match(doc(file), /ask for long work in smaller pieces/i);
  });

  test(`${file}: the reading of the provider's wait is tested only against stand-ins`, () => {
    assert.match(doc(file), /tested only against stand-ins/i);
  });
}

test("docs/limits.md says what the room is told, in the exact words, and what the button does", () => {
  const text = doc("docs/limits.md");
  assert.ok(text.includes(rateLimitLine(30).replace("30", "N")) || text.includes(rateLimitLine(2).replace("2 seconds", "N seconds")), "the sentence with a wait");
  assert.ok(text.includes(CATEGORY_MESSAGES.NO_QUOTA), "the sentence without one");
  assert.match(text, new RegExp(`${SHORT_WAIT_SECONDS} seconds or less`));
  assert.match(text, /daily or monthly limit/i);
  assert.match(text, /billing or credit/i);
  assert.ok(text.includes(CONTINUE_TEXT));
  assert.match(text, /counts down/i);
  assert.match(text, /only the controller/i);
  assert.match(text, /does not (add|make) any (automatic )?retr/i);
});

test("docs/providers.md says the room never gets the provider's words, and the terminal gets them with identifiers hidden", () => {
  const text = doc("docs/providers.md");
  assert.match(text, /never (puts|shows|repeats) the provider's own text[^.]*in the room/i);
  assert.match(text, /\[org hidden\]/);
  assert.match(text, /\[query hidden\]/);
});
