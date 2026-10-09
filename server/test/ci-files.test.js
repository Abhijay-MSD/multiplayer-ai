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

test("every job has a timeout, and a newer push on the same branch cancels the older run", () => {
  assert.match(ci, /^concurrency:\n {2}group: .*github\.ref.*\n {2}cancel-in-progress: true/m);
  const jobs = ci.split(/^jobs:\n/m)[1].split(/^ {2}[a-z][\w-]*:\n/m).slice(1);
  assert.ok(jobs.length >= 1);
  for (const j of jobs) assert.match(j, /timeout-minutes: \d+/);
});

test("it runs on Linux and macOS, on the lowest Node it claims and on 24", () => {
  assert.match(ci, /os: \[ubuntu-latest, macos-latest\]/);
  assert.match(ci, /node: \["22\.13\.0", "24"\]/);
});

test("it says at the top that it has not run yet", () => {
  assert.match(ci.split("\n").slice(0, 5).join("\n"), /NOT RUN/);
});

test("dependabot checks each package folder and the actions, weekly", () => {
  const d = read(".github/dependabot.yml");
  for (const dir of ["/server", "/web", "/web/qa", "/server/supabase-lib"]) assert.ok(d.includes(`directory: "${dir}"`), dir);
  assert.match(d, /package-ecosystem: "github-actions"/);
  assert.equal((d.match(/interval: "weekly"/g) ?? []).length, 5);
  assert.doesNotMatch(d, /auto-?merge/i);
});
