// Run: node --test test/   (no network)
// scripts/scan-secrets.mjs looks for things shaped like keys in tracked files, in git history, and in the built web
// app, and reports only where (file, line, pattern name), never what. These tests build a throwaway repository
// with made-up values assembled here at run time, so this file holds nothing shaped like a key.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempDir, cleanup } from "./helpers/stores.js";

after(cleanup);
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/scan-secrets.mjs");
const filler = (n, ch = "a") => ch.repeat(n);
const SECRETS = {
  groq: `gsk${"_"}${filler(52, "A")}`,
  google: `AIza${filler(35, "b")}`,
  supabaseSecret: `sb${"_"}secret${"_"}${filler(30, "c")}`,
  supabasePublishable: `sb${"_"}publishable${"_"}${filler(30, "d")}`,
  jwt: `eyJ${filler(20, "e")}.eyJ${filler(20, "f")}.${filler(20, "g")}`,
  openaiStyle: `sk${"-"}${filler(40, "h")}`
};

const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t" + "@" + "example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
function repo() {
  const dir = tempDir("scan-");
  git(dir, "init", "-q");
  return dir;
}
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const commit = (dir, msg) => (git(dir, "add", "-A"), git(dir, "commit", "-q", "-m", msg));
const scan = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
const everything = (r) => r.stdout + r.stderr;

test("a clean repository passes", () => {
  const dir = repo();
  write(dir, "a.js", "const x = 1;\n// task-force, risk-free and a made_up_gsk_key are not keys\n");
  commit(dir, "clean");
  const r = scan(dir);
  assert.equal(r.status, 0, everything(r));
  assert.match(r.stdout, /No key-shaped strings found/);
});

test("each pattern is found in a tracked file, by file, line and pattern name, and the value is never printed", () => {
  const dir = repo();
  const names = Object.keys(SECRETS);
  write(dir, "src/keys.txt", names.map((n, i) => `line ${i + 1}: ${SECRETS[n]}`).join("\n") + "\n");
  commit(dir, "oops");
  const r = scan(dir);
  assert.equal(r.status, 1);
  const out = everything(r);
  for (const [i, pattern] of ["gsk_", "AIza", "sb_secret_", "sb_publishable_", "eyJ", "sk-"].entries()) {
    assert.match(out, new RegExp(`tracked file +src/keys\\.txt:${i + 1} +${pattern.replace(/[-_]/g, "\\$&")}`), `${pattern} on line ${i + 1}`);
  }
  for (const secret of Object.values(SECRETS)) assert.ok(!out.includes(secret), "the value is not printed");
  for (const secret of Object.values(SECRETS)) assert.ok(!out.includes(secret.slice(6, 24)), "nor any part of it");
});

test("a key that was committed and later removed is still found, in history, with the commit", () => {
  const dir = repo();
  write(dir, "config.txt", `token=${SECRETS.groq}\n`);
  commit(dir, "add");
  const first = git(dir, "rev-parse", "--short", "HEAD").trim();
  write(dir, "config.txt", "token=\n");
  commit(dir, "remove");
  const r = scan(dir);
  assert.equal(r.status, 1);
  const out = everything(r);
  assert.match(out, new RegExp(`history +${first} +config\\.txt:1 +gsk_`));
  assert.doesNotMatch(out, /tracked file/, "it is not in the current files");
  assert.ok(!out.includes(SECRETS.groq));
});

test("the built web app is scanned too, and a missing build is said, not skipped silently", () => {
  const dir = repo();
  write(dir, "a.js", "x\n");
  commit(dir, "c");
  const none = scan(dir);
  assert.equal(none.status, 0);
  assert.match(none.stdout, /web\/dist: not built, so not scanned/);

  write(dir, "web/dist/assets/index-abc.js", `var a=1;\nvar k="${SECRETS.google}";\n`);
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(everything(r), /built app +web\/dist\/assets\/index-abc\.js:2 +AIza/);
  assert.ok(!everything(r).includes(SECRETS.google));
});

test("untracked and ignored files are not part of the tracked-file scan, binaries are skipped", () => {
  const dir = repo();
  write(dir, ".gitignore", "secret.local\n");
  write(dir, "secret.local", `${SECRETS.groq}\n`);
  write(dir, "image.png", Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(SECRETS.groq)]).toString("latin1"));
  commit(dir, "c");
  const r = scan(dir);
  assert.equal(r.status, 0, everything(r));
});

// ── known made-up values ─────────────────────────────────────────────

const allow = (dir, entries) => write(dir, "scripts/scan-secrets-allow.json", JSON.stringify(entries));

test("a listed made-up value passes but is still shown; the same pattern anywhere else still fails", () => {
  const dir = repo();
  write(dir, "t/fixture.test.js", `const k = "${SECRETS.google}";\n`);
  allow(dir, [{ file: "t/fixture.test.js", pattern: "AIza", reason: "a made-up value used by a test" }]);
  commit(dir, "c");
  const ok = scan(dir);
  assert.equal(ok.status, 0, everything(ok));
  assert.match(ok.stdout, /allowed +t\/fixture\.test\.js:1 +AIza +\(a made-up value used by a test\)/);
  assert.ok(!everything(ok).includes(SECRETS.google));

  write(dir, "other.txt", `${SECRETS.google}\n`);
  commit(dir, "again");
  const bad = scan(dir);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /tracked file +other\.txt:1 +AIza/);
});

test("an allow entry must be exact and must still match something", () => {
  const dir = repo();
  write(dir, "a.js", "x\n");
  allow(dir, [{ file: "gone.js", pattern: "gsk_", reason: "was a fixture" }]);
  commit(dir, "c");
  const stale = scan(dir);
  assert.equal(stale.status, 1);
  assert.match(everything(stale), /scan-secrets-allow\.json: gone\.js gsk_ matches nothing; remove the entry/);

  allow(dir, [{ file: "*.js", pattern: "gsk_", reason: "wildcards are not allowed" }]);
  commit(dir, "d");
  const wild = scan(dir);
  assert.equal(wild.status, 1);
  assert.match(everything(wild), /must be an exact path, with no wildcard/);

  allow(dir, [{ file: "a.js", pattern: "gsk_" }]);
  commit(dir, "e");
  assert.match(everything(scan(dir)), /needs a reason/);
});

// ── a shallow clone cannot show history ────────────────────────────────
// actions/checkout fetches one commit unless told otherwise. A scan of that one commit says "nothing in history" about history it never saw.

/** A copy of `dir` holding only its newest commit, the way actions/checkout makes one by default. */
function shallowCopy(dir) {
  const into = path.join(tempDir("scan-shallow-"), "clone");
  git(dir, "clone", "-q", "--depth", "1", `file://${dir}`, into);
  assert.equal(git(into, "rev-parse", "--is-shallow-repository").trim(), "true", "the copy really is shallow");
  return into;
}

test("a shallow clone is refused: it says history was not scanned and how to get it, instead of passing", () => {
  const dir = repo();
  write(dir, "config.txt", `token=${SECRETS.groq}\n`);
  commit(dir, "add");
  write(dir, "config.txt", "token=\n");
  commit(dir, "remove");
  assert.equal(scan(dir).status, 1, "a full clone finds the key in history");

  const shallow = shallowCopy(dir);
  const r = scan(shallow);
  const out = everything(r);
  assert.equal(r.status, 1, `it must not pass: ${out}`);
  assert.match(out, /shallow/i);
  assert.match(out, /history was not scanned/i);
  assert.match(out, /fetch-depth: 0/, "and says what to set in GitHub Actions");
  assert.match(out, /git fetch --unshallow/, "and what to run anywhere else");
  assert.doesNotMatch(out, /No key-shaped strings found/, "it does not also say everything is fine");
  assert.ok(!out.includes(SECRETS.groq));
});

test("a shallow clone with nothing in it is refused too, not only one that hides a key", () => {
  const dir = repo();
  write(dir, "a.js", "x\n");
  commit(dir, "one");
  write(dir, "a.js", "y\n");
  commit(dir, "two");
  const r = scan(shallowCopy(dir));
  assert.equal(r.status, 1, everything(r));
  assert.match(everything(r), /shallow/i);
});

test("after git fetch --unshallow the same clone is scanned, history included", () => {
  const dir = repo();
  write(dir, "config.txt", `token=${SECRETS.groq}\n`);
  commit(dir, "add");
  write(dir, "config.txt", "token=\n");
  commit(dir, "remove");
  const shallow = shallowCopy(dir);
  assert.equal(scan(shallow).status, 1);
  git(shallow, "fetch", "-q", "--unshallow");
  const r = scan(shallow);
  assert.equal(r.status, 1);
  assert.match(everything(r), /history +[0-9a-f]+ +config\.txt:1 +gsk_/, "now it sees the old commit, and reports the key it holds");
  assert.doesNotMatch(everything(r), /shallow/i);

  const clean = repo();
  write(clean, "a.js", "x\n");
  commit(clean, "one");
  write(clean, "a.js", "y\n");
  commit(clean, "two");
  const c = shallowCopy(clean);
  git(c, "fetch", "-q", "--unshallow");
  assert.equal(scan(c).status, 0, "a clean repository passes once it is complete");
});
