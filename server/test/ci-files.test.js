// Run: node --test test/   (no network)
// The CI workflow and the Dependabot file say what the docs say they do. The workflow has passed on GitHub; these
// tests only check what can be checked by reading the files.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const ci = read(".github/workflows/ci.yml");

test("the workflow can only read the repository, with the permission set for the whole workflow", () => {
  assert.match(ci, /^permissions:\n {2}contents: read\n/m);
  assert.doesNotMatch(ci, /contents: write|pull-requests: write|id-token/);
});

// The jobs, by name, each as the text of its block.
const jobs = Object.fromEntries(
  [...ci.split(/^jobs:\n/m)[1].matchAll(/^ {2}([a-z][\w-]*):\n((?: {4}.*\n|\n)*)/gm)].map((m) => [m[1], m[2]])
);
// The steps of a job, each as the text of its block.
const stepsOf = (job) => job.split(/^ {6}- /m).slice(1).map((t) => "- " + t);
const stepNamed = (job, name) => stepsOf(job).find((t) => t.startsWith(`- name: ${name}\n`) || t.startsWith(`- name: ${name} (`));

test("every job has a timeout, and a newer push on the same branch cancels the older run", () => {
  assert.match(ci, /^concurrency:\n {2}group: .*github\.ref.*\n {2}cancel-in-progress: true/m);
  assert.deepEqual(Object.keys(jobs), ["checks", "browser"]);
  for (const [name, j] of Object.entries(jobs)) assert.match(j, /timeout-minutes: \d+/, name);
});

test("it runs on a push to main and on every pull request, and on nothing else", () => {
  assert.match(ci, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n/m);
  assert.doesNotMatch(ci, /^ {2}(schedule|workflow_dispatch|pull_request_target):/m);
});

test("the cheap checks come first, in a job of their own, so a browser test cannot hide them", () => {
  assert.ok(ci.indexOf("\n  checks:\n") < ci.indexOf("\n  browser:\n"), "the checks job is above the browser job");
  assert.doesNotMatch(jobs.checks + jobs.browser, /^ {4}needs:/m, "neither job waits for the other");
  for (const name of ["Server tests", "Copy check", "Secrets scan", "Audit"]) {
    assert.ok(stepNamed(jobs.checks, name), `${name} is a step of the checks job`);
    assert.equal(stepNamed(jobs.browser, name), undefined, `${name} is not repeated in the browser job`);
  }
  assert.match(stepNamed(jobs.checks, "Audit"), /npm audit --audit-level=high --prefix server\n\s+npm audit --audit-level=high --prefix web/);
  assert.match(stepNamed(jobs.checks, "Secrets scan"), /scripts\/scan-secrets\.mjs/);
  assert.match(stepNamed(jobs.checks, "Copy check"), /npm run check:copy/);
  // The secrets scan reads the whole history, so the job fetches all of it (the scan refuses a shallow clone).
  assert.match(jobs.checks, /fetch-depth: 0/);
  assert.doesNotMatch(jobs.checks, /playwright|web\/qa/);
});

const names = () => stepsOf(jobs.checks).map((t) => t.match(/name: (.*)/)?.[1] ?? "");
const at = (name) => {
  const i = names().findIndex((n) => n === name || n.startsWith(`${name} (`));
  assert.ok(i >= 0, `${name} is a step of the checks job`);
  return i;
};

test("the checks that need no install come first, then the installs and the build, then the server tests, then the audit", () => {
  const cheap = ["Copy check", "Secrets scan"];
  const installs = ["Install the server", "Install the web app"];
  for (const c of cheap) for (const i of installs) assert.ok(at(c) < at(i), `${c} comes before ${i}, so a banned phrase or a key is reported without waiting for npm`);
  assert.ok(at("Build the web app") > at("Install the web app"), "the build comes after the web app's packages are installed");
  for (const before of [...installs, "Build the web app"]) {
    assert.ok(at(before) < at("Server tests"), `${before} comes before the server tests: the smoke test and the agent test need web/node_modules and fail without them`);
  }
  assert.ok(at("Server tests") < at("Audit"), "the audit comes last, after the tests");
});

test("the secrets scan runs again on the built app once it is built, so web/dist is still scanned in CI", () => {
  const again = stepsOf(jobs.checks).filter((t) => /scripts\/scan-secrets\.mjs/.test(t));
  assert.equal(again.length, 2, "once before the installs, once after the build");
  assert.ok(at("Secrets scan of the built app") > at("Build the web app"));
});

test("the two checks that run before any install import nothing but Node's own modules and git, so they really need no install", () => {
  for (const file of ["scripts/check-copy.mjs", "scripts/scan-secrets.mjs"]) {
    const imports = [...read(file).matchAll(/^import .* from "([^"]+)";?$/gm)].map((m) => m[1]);
    assert.ok(imports.length > 0, file);
    for (const spec of imports) assert.match(spec, /^node:/, `${file} imports ${spec}, which is not a Node module`);
    assert.doesNotMatch(read(file), /\brequire\(|import\(/, `${file} loads nothing else`);
  }
});

test("the tests that need the installed web app fail loudly, never skip, and say that CI installs and builds first", () => {
  for (const file of ["server/test/smoke.test.js", "server/test/agent-e2e.test.js"]) {
    const src = read(file);
    const msg = src.match(/assert\.ok\(fs\.existsSync\(path\.join\(ROOT, (?:dir|d)\)\), `([^`]*)`/)?.[1];
    assert.ok(msg, `${file} asserts that web/node_modules exists`);
    assert.match(msg, /npm ci/);
    assert.match(msg, /CI installs and builds before it runs the server tests/, file);
    assert.doesNotMatch(src, /\{ ?skip|t\.skip\(|\.skip\(/, `${file} has no skip`);
  }
});

test("both Nodes install, build and run the server tests; the copy check, the secrets scans and the audit run on Node 24 only", () => {
  assert.match(jobs.checks, /node: \["22\.13\.0", "24"\]/);
  assert.match(jobs.checks, /runs-on: ubuntu-latest/);
  const everywhere = ["Install the server", "Install the web app", "Build the web app", "Server tests"];
  for (const t of stepsOf(jobs.checks)) {
    const name = t.match(/name: (.*)/)?.[1];
    if (!name) continue; // actions/checkout, actions/setup-node
    if (everywhere.includes(name)) assert.doesNotMatch(t, /^\s+if:/m, `${name} runs on both Nodes`);
    else assert.match(t, /^\s+if: matrix\.node == '24'$/m, `${name} runs on Node 24 only`);
  }
});

test("the browser suite runs once on Linux and once on macOS, on Node 24 only", () => {
  assert.match(jobs.browser, /os: \[ubuntu-latest, macos-latest\]/);
  assert.match(jobs.browser, /runs-on: \$\{\{ matrix\.os \}\}/);
  assert.doesNotMatch(jobs.browser, /^\s+node:/m, "no Node version matrix");
  assert.doesNotMatch(jobs.browser, /22\.13/);
  assert.match(jobs.browser, /node-version: "24"/);
  assert.match(stepNamed(jobs.browser, "Browser tests"), /working-directory: web\/qa\n\s+run: npm test/);
  assert.match(stepNamed(jobs.browser, "Install the browser (Linux)"), /runner\.os == 'Linux'[\s\S]*playwright install --with-deps chromium/);
  assert.match(stepNamed(jobs.browser, "Install the browser (macOS)"), /runner\.os == 'macOS'[\s\S]*playwright install chromium/);
});

test("the test output is kept for 7 days, only when something failed, and it is the folder Playwright writes to", () => {
  const uploads = ci.match(/uses: actions\/upload-artifact@/g) ?? [];
  assert.equal(uploads.length, 1);
  const up = stepsOf(jobs.browser).find((t) => t.includes("actions/upload-artifact"));
  assert.ok(up, "the upload is in the browser job");
  assert.match(up, /^\s+if: failure\(\)$/m);
  assert.doesNotMatch(up, /always\(\)/);
  assert.match(up, /path: web\/qa\/\.results\n/);
  assert.match(up, /retention-days: 7\n/);
  assert.match(up, /name: .*\$\{\{ matrix\.os \}\}/, "one artifact per operating system, so the two do not collide");
  assert.match(read("web/qa/playwright.config.js"), /outputDir: "\.\/\.results"/);
});

test("it says at the top what is true: it runs on every push to main and every pull request, it has passed on GitHub, and what is not exercised", () => {
  const top = ci.split("\n").slice(0, 10).join("\n");
  assert.doesNotMatch(top, /NOT PASSED YET|has not passed|never ran|has not run on GitHub/i);
  assert.match(top, /every push to main and every pull request/);
  assert.match(top, /has passed on GitHub/);
  assert.match(top, /four jobs/);
  assert.match(top, /tags, not commit SHAs/);
  assert.match(top, /upload-artifact runs only when a browser test fails/);
});

// ── Dependabot ──────────────────────────────────────────────────────

// Reads the small part of YAML that .github/dependabot.yml uses: comments, "key: value", nested keys, "- " list items (a list item
// may start a map), quoted strings, numbers, and one-line [a, b] lists. Nothing else: anything it does not understand throws, so a
// change to the file that the tests could no longer read fails loudly instead of passing by accident.
function parseYaml(text) {
  const lines = text
    .split("\n")
    .map((raw) => ({ raw, indent: raw.match(/^ */)[0].length, body: raw.replace(/\s+#.*$/, "").trim() }))
    .filter((l) => l.body && !l.body.startsWith("#"));
  const scalar = (v) => {
    if (/^\[.*\]$/.test(v)) return v.slice(1, -1).trim() === "" ? [] : v.slice(1, -1).split(",").map((x) => scalar(x.trim()));
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v.slice(1, -1);
    if (/^-?\d+$/.test(v)) return Number(v);
    if (v === "true" || v === "false") return v === "true";
    if (/^[\w./@*-]+$/.test(v)) return v;
    throw new Error(`cannot read: ${v}`);
  };
  let i = 0;
  const block = (indent) => {
    if (lines[i].body.startsWith("- ")) {
      const list = [];
      while (i < lines.length && lines[i].indent === indent && lines[i].body.startsWith("- ")) {
        // "- key: value" is a map whose first key sits two columns in; turn the dash into spaces and read it as a map.
        lines[i] = { ...lines[i], indent: indent + 2, body: lines[i].body.slice(2) };
        list.push(lines[i].body.includes(": ") || lines[i].body.endsWith(":") ? block(indent + 2) : scalar(lines[i++].body));
      }
      return list;
    }
    const map = {};
    while (i < lines.length && lines[i].indent === indent) {
      const m = lines[i].body.match(/^([\w./@"*-]+):(?: (.*))?$/);
      if (!m) throw new Error(`cannot read: ${lines[i].raw}`);
      i++;
      map[m[1].replace(/"/g, "")] = m[2] !== undefined ? scalar(m[2]) : i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : null;
    }
    return map;
  };
  const out = block(lines[0].indent);
  assert.equal(i, lines.length, "the whole file was read");
  return out;
}

const dependabotText = read(".github/dependabot.yml");
const dependabot = parseYaml(dependabotText);
const entries = dependabot.updates;
const npmEntries = entries.filter((e) => e["package-ecosystem"] === "npm");
const dirsWithPackages = () => {
  const found = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (!d.isDirectory() || ["node_modules", ".git", "dist", "dist-qa", ".results"].includes(d.name)) continue;
      const rel = path.posix.join(dir, d.name);
      if (fs.existsSync(path.join(ROOT, rel, "package.json"))) found.push(rel);
      walk(rel);
    }
  };
  if (fs.existsSync(path.join(ROOT, "package.json"))) found.push(".");
  walk(".");
  // A folder with no packages to update (the root one only has scripts) has nothing for Dependabot to do.
  return found.filter((rel) => {
    const pkg = JSON.parse(read(path.posix.join(rel, "package.json")));
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
  });
};

test("the dependabot file parses, and says version 2 with five entries", () => {
  assert.equal(dependabot.version, 2);
  assert.equal(entries.length, 5);
  for (const e of entries) {
    assert.ok(e["package-ecosystem"] && e.directory && e.schedule, JSON.stringify(e));
  }
});

test("dependabot covers every folder that has packages, and the actions", () => {
  const covered = npmEntries.map((e) => e.directory).sort();
  assert.deepEqual(covered, dirsWithPackages().map((d) => "/" + d).sort());
  for (const dir of ["/server", "/web", "/web/qa", "/server/supabase-lib"]) assert.ok(covered.includes(dir), dir);
  const actions = entries.filter((e) => e["package-ecosystem"] === "github-actions");
  assert.deepEqual(actions.map((e) => e.directory), ["/"]);
  assert.equal(new Set(entries.map((e) => `${e["package-ecosystem"]} ${e.directory}`)).size, entries.length, "no folder twice");
});

test("dependabot asks once a month, for at most two pull requests at a time per entry, and never merges", () => {
  for (const e of entries) {
    assert.equal(e.schedule.interval, "monthly", e.directory);
    assert.equal(e["open-pull-requests-limit"], 2, e.directory);
  }
  assert.doesNotMatch(dependabotText, /auto-?merge/i);
});

test("dependabot ignores major versions in every ecosystem", () => {
  for (const e of entries) {
    const rule = (e.ignore ?? []).find((r) => r["dependency-name"] === "*");
    assert.ok(rule, `${e["package-ecosystem"]} ${e.directory} ignores majors for every dependency`);
    assert.deepEqual(rule["update-types"], ["version-update:semver-major"], e.directory);
  }
});

test("dependabot does not offer minor versions of @google/generative-ai, which is 0.x", () => {
  const withIt = npmEntries.filter((e) => {
    const pkg = JSON.parse(read(path.posix.join(e.directory, "package.json")));
    return "@google/generative-ai" in { ...pkg.dependencies, ...pkg.devDependencies };
  });
  assert.ok(withIt.length >= 1);
  assert.match(JSON.parse(read("server/package.json")).dependencies["@google/generative-ai"], /^\^?0\./, "the package is still 0.x; if it is not, this rule can go");
  for (const e of withIt) {
    const rule = (e.ignore ?? []).find((r) => r["dependency-name"] === "@google/generative-ai");
    assert.ok(rule, e.directory);
    assert.ok(rule["update-types"].includes("version-update:semver-minor"), e.directory);
  }
});

test("dependabot moves react and react-dom together, in every folder that has them", () => {
  const withReact = npmEntries.filter((e) => {
    const pkg = JSON.parse(read(path.posix.join(e.directory, "package.json")));
    return "react" in { ...pkg.dependencies, ...pkg.devDependencies } || "react-dom" in { ...pkg.dependencies, ...pkg.devDependencies };
  });
  assert.deepEqual(withReact.map((e) => e.directory), ["/web"]);
  for (const e of withReact) {
    const groups = Object.values(e.groups ?? {});
    const g = groups.find((x) => x.patterns.includes("react"));
    assert.ok(g, e.directory);
    assert.deepEqual([...g.patterns].sort(), ["react", "react-dom"], "react and react-dom, and nothing else, in one group");
  }
});
