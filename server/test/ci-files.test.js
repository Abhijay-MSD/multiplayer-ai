// Run: node --test test/   (no network)
// The CI workflow and the Dependabot file say what the docs say they do. The workflow has never run on GitHub; these
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
  // The secrets scan reads web/dist, so the build comes before it, and it reads the whole history.
  const order = stepsOf(jobs.checks).map((t) => t.match(/name: (.*)/)?.[1] ?? "");
  assert.ok(order.findIndex((n) => n.startsWith("Build")) < order.indexOf("Secrets scan"));
  assert.match(jobs.checks, /fetch-depth: 0/);
  assert.doesNotMatch(jobs.checks, /playwright|web\/qa/);
});

test("the older Node runs the server tests and nothing else; the rest runs on Node 24", () => {
  assert.match(jobs.checks, /node: \["22\.13\.0", "24"\]/);
  assert.match(jobs.checks, /runs-on: ubuntu-latest/);
  const steps = stepsOf(jobs.checks);
  const everywhere = ["Install the server", "Server tests"];
  for (const t of steps) {
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

test("it says at the top that it has not passed yet", () => {
  assert.match(ci.split("\n").slice(0, 5).join("\n"), /NOT PASSED YET/);
});

test("dependabot checks each package folder and the actions, weekly", () => {
  const d = read(".github/dependabot.yml");
  for (const dir of ["/server", "/web", "/web/qa", "/server/supabase-lib"]) assert.ok(d.includes(`directory: "${dir}"`), dir);
  assert.match(d, /package-ecosystem: "github-actions"/);
  assert.equal((d.match(/interval: "weekly"/g) ?? []).length, 5);
  assert.doesNotMatch(d, /auto-?merge/i);
});
