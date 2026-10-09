// Run: node --test test/   (no network)
// The words in .env.example and in the docs match what the code does: every setting the code reads is listed,
// every setting listed is read, and every link in the README and docs points at something that exists.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function* files(dir, exts) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "test", "dist", ".results", "qa"].includes(e.name)) continue;
      yield* files(rel, exts);
    } else if (exts.includes(path.extname(e.name))) yield rel;
  }
}

// Read by the code, but not something a person sets: set by the program itself, by a test, or by the platform.
const NOT_FOR_PEOPLE = new Set([
  "PATH", "PATHEXT", "OSTYPE", "NODE_OPTIONS",
  "MULTIPLAYER_AI_CONTAINER", // set by the Docker image, and only honoured inside a real container
  "MULTIPLAYER_AI_NO_DOTENV", // tests and the launcher's own checks
  "MULTIPLAYER_AI_LIVE_SUPABASE", // opt-in live Supabase test
  "MULTIPLAYER_AI_TEST_CLIENT_IMAGE", // a test
  "MULTIPLAYER_AI_HTTP", // the MCP server's own switch for also serving HTTP (also --http)
  "MULTIPLAYER_AI_PUBLIC_PORT", // where the port is published, set by the image's run command
  "VITE_API_BASE" // dev server only
]);

function variablesRead() {
  const found = new Set();
  const pattern = /(?:process\.env|\benv)\.([A-Z][A-Z0-9_]{2,})\b|env\[["']([A-Z][A-Z0-9_]{2,})["']\]/g;
  for (const dir of ["server", "scripts"]) {
    for (const rel of files(dir, [".js", ".mjs"])) {
      if (rel.includes("supabase-lib")) continue;
      for (const m of read(rel).matchAll(pattern)) found.add(m[1] ?? m[2]);
    }
  }
  for (const name of Object.keys(DEFAULTS)) found.add(name);
  return found;
}

const documented = () => new Set([...read(".env.example").matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));

test(".env.example lists every setting the code reads that a person might set", () => {
  const listed = documented();
  const missing = [...variablesRead()].filter((n) => !listed.has(n) && !NOT_FOR_PEOPLE.has(n)).sort();
  assert.deepEqual(missing, [], `read by the code but not in .env.example: ${missing.join(", ")}`);
});

test(".env.example lists nothing the code never reads", () => {
  const read_ = variablesRead();
  const text = [...files("server", [".js", ".mjs"]), ...files("scripts", [".mjs", ".js"]), "web/vite.config.js"].filter((r) => !r.includes("supabase-lib")).map(read).join("\n");
  const stale = [...documented()].filter((n) => !read_.has(n) && !new RegExp(`["'\`]${n}["'\`]|\\b${n}\\b`).test(text)).sort();
  assert.deepEqual(stale, [], `in .env.example but never mentioned by the code: ${stale.join(", ")}`);
});

// The anchor GitHub makes for each heading: lower case, punctuation dropped, spaces to hyphens.
const headingSlugs = (file) =>
  new Set([...fs.readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "").matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].map((m) =>
    m[1].toLowerCase().replace(/[`*_]/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s/g, "-")
  ));

test("every relative link in the README, CONTRIBUTING, SECURITY and docs points at a file (and a heading) that exists", () => {
  const pages = ["README.md", "CONTRIBUTING.md", "SECURITY.md", ...fs.readdirSync(path.join(ROOT, "docs"), { recursive: true }).filter((f) => f.endsWith(".md")).map((f) => path.join("docs", f))];
  const broken = [];
  for (const page of pages) {
    const text = read(page).replace(/```[\s\S]*?```/g, ""); // not links in code samples
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const file = decodeURIComponent(target.split("#")[0]);
      if (!file) continue;
      const full = path.resolve(path.dirname(path.join(ROOT, page)), file);
      if (!fs.existsSync(full)) broken.push(`${page} -> ${target}`);
      else if (target.includes("#") && full.endsWith(".md") && !headingSlugs(full).has(target.split("#")[1])) broken.push(`${page} -> ${target} (no such heading)`);
    }
  }
  assert.deepEqual(broken, []);
});

test("every command the README and CONTRIBUTING tell people to run exists as a script", () => {
  const rootScripts = JSON.parse(read("package.json")).scripts;
  const webScripts = JSON.parse(read("web/package.json")).scripts;
  const serverScripts = JSON.parse(read("server/package.json")).scripts;
  const text = read("README.md") + read("CONTRIBUTING.md");
  for (const m of text.matchAll(/npm run ([a-z:-]+)/g)) {
    const name = m[1];
    assert.ok(name in rootScripts || name in webScripts, `npm run ${name} is not a script in the root or web package`);
  }
  assert.ok("test" in serverScripts && "start" in rootScripts && "check:copy" in rootScripts);
  for (const f of ["scripts/start.mjs", "scripts/scan-secrets.mjs", "scripts/check-copy.mjs", "Dockerfile", ".github/workflows/ci.yml", ".github/ISSUE_TEMPLATE/bug_report.md"]) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is mentioned in the docs but missing`);
  }
});

test("the ports and defaults the docs state are the ones in the code", () => {
  const docker = read("docs/docker.md") + read("README.md");
  assert.match(docker, /127\.0\.0\.1:3737:3737/);
  assert.match(read("server/local.js") + read("server/http.js") + read("scripts/start.mjs"), /3737/);
  assert.equal(DEFAULTS.GUEST_STEP_CAP_PER_ROOM, 20, "the README and docs/sharing.md say 20");
  assert.equal(DEFAULTS.INVITE_FAILURES_PER_10_MIN, 50, "docs/sharing.md says 50");
  assert.match(read("docs/sharing.md"), /20 by default/);
});

test("the README and docs/providers.md both say the Claude choice is experimental", () => {
  const phrase = "not yet tested against the real service";
  assert.ok(read("README.md").includes(phrase), "README.md");
  assert.ok(read("docs/providers.md").includes(phrase), "docs/providers.md");
});

test("the draft legal pages are gone and nothing links to them", () => {
  assert.ok(!fs.existsSync(path.join(ROOT, "docs/legal")));
  for (const f of ["README.md", "docs/privacy.md", "SECURITY.md", "CONTRIBUTING.md"]) assert.ok(!/docs\/legal|\]\(legal\//.test(read(f)), f);
});
