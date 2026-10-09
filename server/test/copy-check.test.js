// Run: node --test test/   (no network)
// The copy check: banned phrases and AI product names fail it, except provider names in the
// two files listed in scripts/copy-exemptions.json, and only there.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkCopy, loadExemptions } from "../../scripts/check-copy.mjs";
import { tempDir, cleanup } from "./helpers/stores.js";

after(cleanup);

/** A small tree shaped like the repo: { "web/src/a.js": "text", ... } plus the exemptions list. */
function tree(files, exempt = ["web/src/lib/providers.js", "docs/providers.md"]) {
  const root = tempDir("multiplayer-ai-copy-");
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "copy-exemptions.json"), JSON.stringify({ provider_names: exempt }));
  return root;
}
const names = (root) => checkCopy({ root }).problems.map((p) => p.split("  ")[0]);

test("a provider name in an exempt file passes", () => {
  const root = tree({
    "web/src/lib/providers.js": 'export const label = "Gemini";\nconst other = "OpenAI-compatible";',
    "docs/providers.md": "Gemini, Mistral and Llama are named here.\n"
  });
  assert.deepEqual(checkCopy({ root }).problems, []);
});

test("the same names anywhere else fail, in web/src and in docs", () => {
  const root = tree({
    "web/src/lib/providers.js": 'export const label = "Gemini";',
    "web/src/components/Setup.jsx": "<p>Paste your Gemini key</p>",
    "web/src/marketing/Page.jsx": "Works with ChatGPT and Claude.",
    "docs/limits.md": "Uses OpenAI under the hood.\n",
    "docs/providers.md": "Gemini\n"
  });
  assert.deepEqual(names(root).sort(), ["docs/limits.md:1", "web/src/components/Setup.jsx:1", "web/src/marketing/Page.jsx:1", "web/src/marketing/Page.jsx:1"].sort());
});

test("it still fails when the name is in a file next to an exempt one, or in a differently-cased path", () => {
  const root = tree({
    "web/src/lib/providers.js": "ok",
    "web/src/lib/providers.jsx": "Gemini",
    "web/src/lib/providers-extra.js": "Gemini",
    "web/src/lib/Providers.js": "Gemini"
  });
  const found = names(root).map((n) => n.split(":")[0]).sort();
  // On a case-insensitive disk Providers.js and providers.js are one file; either way no name is excused except the exact exempt path.
  assert.ok(found.includes("web/src/lib/providers.jsx") && found.includes("web/src/lib/providers-extra.js"));
});

test("banned phrases are still caught inside an exempt file", () => {
  const root = tree({
    "web/src/lib/providers.js": "// A seamless way to unlock Gemini\n",
    "docs/providers.md": "x\n"
  });
  const problems = checkCopy({ root }).problems.join("\n");
  assert.match(problems, /web\/src\/lib\/providers\.js:1  banned phrase: "seamless"/);
  assert.match(problems, /banned phrase: "unlock"/);
  assert.doesNotMatch(problems, /AI brand name/, "the provider name itself is the one thing excused");
});

test("an entry for a file that does not exist is an error, so the list cannot go stale", () => {
  const root = tree({ "web/src/lib/providers.js": "x" }, ["web/src/lib/providers.js", "docs/providers.md"]);
  const { problems } = checkCopy({ root });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"docs\/providers\.md" does not exist; remove the entry/);
});

test("only exact file paths are accepted: no wildcards, folders, parent paths, absolute paths or files outside the scanned folders", () => {
  const root = tree({ "web/src/a.js": "x", "docs/b.md": "x", "server/c.js": "x" });
  for (const bad of ["web/src/*.js", "web/src/", "web/src", "../web/src/a.js", "/etc/passwd", "web/src/**", "docs/{b,c}.md", "server/c.js", "web\\src\\a.js", ""]) {
    fs.writeFileSync(path.join(root, "scripts", "copy-exemptions.json"), JSON.stringify({ provider_names: [bad] }));
    const { files, problems } = loadExemptions(root);
    assert.equal(files.size, 0, `"${bad}" must not exempt anything`);
    assert.equal(problems.length, 1, `"${bad}" must be reported`);
  }
});

test("a wildcard entry cannot be used to excuse a name anywhere", () => {
  const root = tree({ "web/src/Setup.jsx": "Gemini" }, ["web/src/*.jsx"]);
  const { problems } = checkCopy({ root });
  assert.ok(problems.some((p) => /Setup\.jsx:1  AI brand name/.test(p)));
  assert.ok(problems.some((p) => /not an exact file path/.test(p)));
});

test("a missing or unreadable exemptions file excuses nothing", () => {
  const root = tree({ "web/src/a.js": "Gemini" });
  fs.writeFileSync(path.join(root, "scripts", "copy-exemptions.json"), "{ not json");
  assert.ok(checkCopy({ root }).problems.some((p) => /not valid JSON/.test(p)));
  fs.rmSync(path.join(root, "scripts", "copy-exemptions.json"));
  assert.ok(checkCopy({ root }).problems.some((p) => /AI brand name/.test(p)));
});

test("the real repository passes, and the real exemption file lists exactly the two files", () => {
  assert.deepEqual(checkCopy().problems, []);
  const { files } = loadExemptions(path.resolve(import.meta.dirname, "../.."));
  assert.deepEqual([...files].sort(), ["docs/providers.md", "web/src/lib/providers.js"]);
});
