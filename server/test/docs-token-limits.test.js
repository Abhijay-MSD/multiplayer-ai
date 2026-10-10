// Run: node --test test/   (no network)
// What the docs say about token limits has to stay honest: a limit on a reply's length belongs to the provider, the model and the
// account, so it must be looked up, and none of this has been run against a real provider.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../providers/defaults.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

for (const file of ["docs/limits.md", "docs/providers.md"]) {
  test(`${file} says token limits depend on the provider, the model and the account, and must be looked up`, () => {
    const text = read(file).replace(/\s+/g, " ");
    assert.match(text, /token limits depend on the provider, the model and your account/i);
    assert.match(text, /look (them|it) up in the provider's own documentation/i);
  });

  test(`${file} says this has not been tested against real providers`, () => {
    const text = read(file).replace(/\s+/g, " ");
    assert.match(text, /None of this has been tested against real providers/);
  });

  test(`${file} gives the default cap that the code uses, and no other number for it`, () => {
    const text = read(file);
    assert.ok(text.includes(String(DEFAULT_MAX_OUTPUT_TOKENS)), `${file} says ${DEFAULT_MAX_OUTPUT_TOKENS}`);
    assert.doesNotMatch(text, /\b4096\b/, "the old default is gone");
  });
}

test(".env.example gives the same default", () => {
  assert.ok(read(".env.example").includes(`${DEFAULT_MAX_OUTPUT_TOKENS} tokens`));
});
