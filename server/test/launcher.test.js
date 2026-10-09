// Run: node --test test/   (no network; npm and the browser are replaced by stand-ins)
// npm start (scripts/start.mjs): the Node check, what it installs and builds and
// says it is doing, and when it opens the browser.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempDir, cleanup } from "./helpers/stores.js";
import { main, nodeProblem, needsInstall, needsBuild, installArgs, openCommand, openBrowser } from "../../scripts/start.mjs";
import { EventEmitter } from "node:events";
import { spawn as spawnReal } from "node:child_process";

after(cleanup);

/** A folder laid out like the repo: server/ and web/, each with a package.json and a lockfile. */
function repo({ installed = true, built = true, lock = true } = {}) {
  const root = tempDir("multiplayer-ai-repo-");
  for (const part of ["server", "web"]) {
    fs.mkdirSync(path.join(root, part));
    fs.writeFileSync(path.join(root, part, "package.json"), "{}");
    if (lock) fs.writeFileSync(path.join(root, part, "package-lock.json"), "{}");
  }
  fs.mkdirSync(path.join(root, "web", "src"));
  fs.writeFileSync(path.join(root, "web", "src", "main.jsx"), "x");
  fs.writeFileSync(path.join(root, "web", "index.html"), "x");
  const old = new Date(Date.now() - 60_000);
  for (const f of ["web/src/main.jsx", "web/index.html", "server/package.json", "web/package.json", "server/package-lock.json", "web/package-lock.json"]) {
    if (fs.existsSync(path.join(root, f))) fs.utimesSync(path.join(root, f), old, old);
  }
  if (installed) {
    for (const part of ["server", "web"]) {
      fs.mkdirSync(path.join(root, part, "node_modules"));
      fs.writeFileSync(path.join(root, part, "node_modules", ".package-lock.json"), "{}");
    }
  }
  if (built) {
    fs.mkdirSync(path.join(root, "web", "dist"));
    fs.writeFileSync(path.join(root, "web", "dist", "index.html"), "built");
  }
  return root;
}

let links = 0;
let configured = true; // whether the stand-in server has a model key set up
function harness(root, env = {}) {
  const lines = [];
  const commands = [];
  const opened = [];
  return {
    lines, commands, opened,
    options: {
      root, env,
      log: (l) => lines.push(l),
      run: (args, cwd) => (commands.push(`npm ${args.join(" ")} (${path.basename(cwd)})`), true),
      open: (url) => opened.push(url),
      stdin: null,
      startServer: async () => ({
        url: "http://127.0.0.1:3737",
        settings: { configured: () => configured },
        admin: { link: (target = "/") => `http://127.0.0.1:3737${target}${target.includes("?") ? "&" : "?"}admin=ONE-TIME-CODE-${++links}` }
      })
    }
  };
}

test("an old Node gets a readable message that says older versions are untested", () => {
  const msg = nodeProblem("22.12.0");
  assert.match(msg, /needs Node 22\.13 or newer/);
  assert.match(msg, /this is Node 22\.12\.0/);
  assert.match(msg, /Older versions are untested/);
  assert.match(msg, /nodejs\.org/);
  assert.equal(nodeProblem("24.0.0"), null);
  assert.equal(nodeProblem("26.1.0"), null);
});

// node:sqlite works without a flag from 22.13.0 and from 23.4.0 (checked by running node:22.12.0, node:22.13.0,
// node:23.3.0 and node:23.4.0 containers); before those the module does not exist.
test("the Node floor is the first release of each line where node:sqlite needs no flag", () => {
  for (const v of ["20.19.0", "22.5.0", "22.12.0", "22.12.99", "23.0.0", "23.3.0", "21.7.3"]) assert.match(nodeProblem(v) ?? "", /needs Node 22\.13 or newer/, v);
  for (const v of ["22.13.0", "22.13.1", "22.23.3", "23.4.0", "23.11.0", "24.0.0", "24.16.0", "25.0.0"]) assert.equal(nodeProblem(v), null, v);
  assert.match(nodeProblem("not a version") ?? "", /needs Node 22\.13 or newer/);
});

test("the version check that every server entry point imports uses the same floor", async () => {
  const { nodeTooOld } = await import("../node-check.js");
  for (const v of ["22.12.0", "23.3.0", "20.0.0"]) assert.equal(nodeTooOld(v), true, v);
  for (const v of ["22.13.0", "23.4.0", "24.0.0"]) assert.equal(nodeTooOld(v), false, v);
  for (const v of ["20.19.0", "22.12.0", "22.13.0", "23.3.0", "23.4.0", "24.0.0", "25.1.0", "bad"]) assert.equal(nodeProblem(v) !== null, nodeTooOld(v), v);
});

test("nothing is installed, built or started on a Node that is too old", async () => {
  const h = harness(repo({ installed: false, built: false }));
  const real = Object.getOwnPropertyDescriptor(process.versions, "node");
  Object.defineProperty(process.versions, "node", { value: "20.11.0", configurable: true });
  try {
    const result = await main({ ...h.options, startServer: async () => assert.fail("must not start") });
    assert.deepEqual(result, { ok: false, reason: "node" });
  } finally {
    Object.defineProperty(process.versions, "node", real);
  }
  assert.deepEqual(h.commands, []);
  assert.match(h.lines.join("\n"), /needs Node 22\.13/);
});

test("on a fresh clone it installs each part with npm ci, builds, starts and opens the browser, saying each command first", async () => {
  const h = harness(repo({ installed: false, built: false }));
  const result = await main(h.options);
  assert.equal(result.ok, true);
  assert.deepEqual(h.commands, ["npm ci (server)", "npm ci (web)", "npm run build (web)"]);
  const text = h.lines.join("\n");
  assert.match(text, /→ npm ci {3}\(in server\/\)/);
  assert.match(text, /→ npm ci {3}\(in web\/\)/);
  assert.match(text, /→ npm run build {3}\(in web\/\)/);
  assert.match(text, /needs an internet connection/);
  assert.match(text, /Multiplayer AI is running at http:\/\/127\.0\.0\.1:3737/);
  assert.equal(h.opened.length, 1);
  assert.match(h.opened[0], /^http:\/\/127\.0\.0\.1:3737\/\?admin=ONE-TIME-CODE-\d+$/, "the browser is opened with the sign-in link");
  assert.match(text, /Sign-in link \(works once, for 5 minutes\)/);
  assert.ok(text.includes(h.opened[0]), "and the same link is printed, for anyone whose browser did not open");
  // every command line is printed before the command runs: the announcement for the first install precedes everything else
  assert.ok(text.indexOf("→ npm ci   (in server/)") < text.indexOf("→ npm ci   (in web/)"));
});

test("without a lockfile it uses npm install, since npm ci needs one", () => {
  const root = repo({ lock: false });
  assert.deepEqual(installArgs(path.join(root, "server")), ["install"]);
  assert.deepEqual(installArgs(path.join(repo(), "server")), ["ci"]);
});

test("when everything is installed and built, it runs no npm command at all", async () => {
  const h = harness(repo());
  const result = await main(h.options);
  assert.equal(result.ok, true);
  assert.deepEqual(h.commands, []);
});

test("it rebuilds when a source file is newer than the build, and not otherwise", () => {
  const root = repo();
  const web = path.join(root, "web");
  assert.equal(needsBuild(web), false);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(web, "src", "main.jsx"), later, later);
  assert.equal(needsBuild(web), true);
});

test("it reinstalls when the lockfile is newer than what was installed", () => {
  const root = repo();
  const server = path.join(root, "server");
  assert.equal(needsInstall(server), false);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(server, "package-lock.json"), later, later);
  assert.equal(needsInstall(server), true);
});

test("a failed install stops with a message and does not go on to build or start", async () => {
  const h = harness(repo({ installed: false, built: false }));
  const result = await main({ ...h.options, run: () => false, startServer: async () => assert.fail("must not start") });
  assert.deepEqual(result, { ok: false, reason: "install" });
  assert.match(h.lines.join("\n"), /Installing packages for server\/ failed/);
});

test("a failed build stops with a message", async () => {
  const h = harness(repo({ built: false }));
  const result = await main({ ...h.options, run: () => false, startServer: async () => assert.fail("must not start") });
  assert.deepEqual(result, { ok: false, reason: "build" });
});

test("NO_OPEN keeps the browser closed and says so", async () => {
  const h = harness(repo(), { NO_OPEN: "1" });
  await main(h.options);
  assert.deepEqual(h.opened, []);
  assert.match(h.lines.join("\n"), /NO_OPEN is set/);
});

test("pressing Enter in a terminal prints and opens a fresh link, each different", async () => {
    const stdin = Object.assign(new EventEmitter(), { isTTY: true, setEncoding() {}, resume() {} });
  const h = harness(repo());
  await main({ ...h.options, stdin });
  const first = h.opened[0];
  stdin.emit("data", "\n");
  assert.equal(h.opened.length, 2);
  assert.notEqual(h.opened[1], first);
  assert.match(h.lines.join("\n"), /New sign-in link/);
});

test("with NO_OPEN the link is printed but not opened, even for a fresh one", async () => {
    const stdin = Object.assign(new EventEmitter(), { isTTY: true, setEncoding() {}, resume() {} });
  const h = harness(repo(), { NO_OPEN: "1" });
  await main({ ...h.options, stdin });
  stdin.emit("data", "\n");
  assert.deepEqual(h.opened, []);
  assert.match(h.lines.join("\n"), /Open the link above yourself/);
});

test("a server that cannot start is reported as the problem it is", async () => {
  const h = harness(repo());
  const result = await main({ ...h.options, startServer: async () => { throw new Error("Multiplayer AI can't start; 1 problem in the environment:\n  - PORT: bad"); } });
  assert.deepEqual(result, { ok: false, reason: "start" });
  assert.match(h.lines.join("\n"), /PORT: bad/);
  assert.deepEqual(h.opened, []);
});

test("the browser is opened with the command each platform has", () => {
  assert.deepEqual(openCommand("http://x", "darwin"), ["open", ["http://x"]]);
  assert.deepEqual(openCommand("http://x", "linux"), ["xdg-open", ["http://x"]]);
  assert.equal(openCommand("http://x", "win32")[0], "cmd");
});


// ── the five ways starting can go wrong, each said in words ──────────

const reset = () => { configured = true; };

test("no model key yet: the terminal says so and the browser is opened on Setup, not the home page", async () => {
  configured = false;
  try {
    const h = harness(repo());
    await main(h.options);
    const text = h.lines.join("\n");
    assert.match(text, /No model key is set up yet\. The link below opens Setup/);
    assert.match(h.opened[0], /^http:\/\/127\.0\.0\.1:3737\/setup\?next=%2Fnew&admin=ONE-TIME-CODE-\d+$/);
  } finally {
    reset();
  }
});

test("with a key set up the link goes to the home page and nothing is said about a key", async () => {
  const h = harness(repo());
  await main(h.options);
  assert.doesNotMatch(h.lines.join("\n"), /No model key/);
  assert.match(h.opened[0], /^http:\/\/127\.0\.0\.1:3737\/\?admin=/);
});

test("a fresh link after pressing Enter follows whether a key has been set up since", async () => {
  configured = false;
  try {
    const stdin = Object.assign(new EventEmitter(), { isTTY: true, setEncoding() {}, resume() {} });
    const h = harness(repo());
    await main({ ...h.options, stdin });
    configured = true;
    stdin.emit("data", "\n");
    await new Promise((r) => setTimeout(r, 0));
    assert.match(h.opened[0], /\/setup/);
    assert.doesNotMatch(h.opened[1], /\/setup/);
  } finally {
    reset();
  }
});

test("a browser that could not be opened is reported with the reason and the link to use by hand", async () => {
  const h = harness(repo());
  await main({ ...h.options, open: async () => ({ ok: false, reason: "xdg-open isn't installed here" }) });
  const text = h.lines.join("\n");
  assert.match(text, /Couldn't open a browser automatically \(xdg-open isn't installed here\)/);
  assert.match(text, /Open this link yourself; it works once, for 5 minutes:\n {2}http:\/\/127\.0\.0\.1:3737\/\?admin=/);
  assert.doesNotMatch(text, /Opened your browser/);
});

test("a browser that opened says so, once", async () => {
  const h = harness(repo());
  await main({ ...h.options, open: async () => ({ ok: true }) });
  assert.equal(h.lines.join("\n").match(/Opened your browser/g).length, 1);
});

test("openBrowser reports a missing command, a failing command, a working one, and a thrown error", async (t) => {
  // openBrowser's own timer is unref'd, so nothing else keeps the loop alive while the "still running" case waits; Node 22's
  // test runner then cancels the test as "event loop already resolved". Hold the loop open for the length of this test.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const child = (emit) => () => {
    const c = Object.assign(new EventEmitter(), { unref() {} });
    setImmediate(() => emit(c));
    return c;
  };
  const missing = await openBrowser("http://x", { platform: "linux", spawnImpl: child((c) => c.emit("error", Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }))) });
  assert.deepEqual(missing, { ok: false, reason: "xdg-open isn't installed here" });
  const failing = await openBrowser("http://x", { platform: "linux", spawnImpl: child((c) => c.emit("exit", 3)) });
  assert.deepEqual(failing, { ok: false, reason: "xdg-open exited with code 3" });
  assert.deepEqual(await openBrowser("http://x", { platform: "darwin", spawnImpl: child((c) => c.emit("exit", 0)) }), { ok: true });
  assert.deepEqual(await openBrowser("http://x", { platform: "darwin", spawnImpl: () => Object.assign(new EventEmitter(), { unref() {} }), waitMs: 20 }), { ok: true }, "still running after a moment counts as opened");
  const thrown = await openBrowser("http://x", { spawnImpl: () => { throw new Error("EPERM"); } });
  assert.deepEqual(thrown, { ok: false, reason: "EPERM" });
});

test("openBrowser really does fail cleanly when the command does not exist", async () => {
  const result = await openBrowser("http://x", { platform: "linux", spawnImpl: (cmd, args, opts) => spawnReal("definitely-not-a-command-multiplayer-ai", args, opts) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /isn't installed here|failed/);
});

test("when stdin is not a terminal the Enter handler is never installed, and an odd stdin cannot crash anything", async () => {
  for (const stdin of [
    null,
    undefined,
    { isTTY: false, on() { assert.fail("must not listen"); } },
    { isTTY: undefined, on() { assert.fail("must not listen"); } },
    new (await import("node:stream")).PassThrough()
  ]) {
    const h = harness(repo());
    const result = await main({ ...h.options, stdin });
    assert.equal(result.ok, true);
  }
});

test("a terminal that errors or closes is ignored, and Enter still works afterwards", async () => {
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setEncoding() {}, resume() {} });
  const h = harness(repo());
  await main({ ...h.options, stdin });
  assert.doesNotThrow(() => stdin.emit("error", Object.assign(new Error("EIO"), { code: "EIO" })));
  assert.doesNotThrow(() => stdin.emit("end"));
  stdin.emit("data", "\n");
  assert.equal(h.opened.length, 2);
});

// ── npm start -- --share=wifi ────────────────────────────────────────

import { shareFromArgs } from "../../scripts/start.mjs";

test("--share=wifi and --share wifi are read; nothing given is nothing; anything else is refused by name", () => {
  assert.deepEqual(shareFromArgs([]), {});
  assert.deepEqual(shareFromArgs(["--share=wifi"]), { value: "wifi" });
  assert.deepEqual(shareFromArgs(["--share", "wifi"]), { value: "wifi" });
  assert.deepEqual(shareFromArgs(["--share=local"]), { value: "local" });
  assert.deepEqual(shareFromArgs(["--other", "--share=wifi"]), { value: "wifi" });
  for (const bad of [["--share=internet"], ["--share=tunnel"], ["--share="], ["--share"], ["--share", "everywhere"], ["--share=WIFI"]]) {
    const r = shareFromArgs(bad);
    assert.match(r.error, /--share must be wifi or local/, JSON.stringify(bad));
    assert.match(r.error, /internet isn't supported/);
  }
});

test("the launcher passes the choice to the server as MULTIPLAYER_AI_SHARE for this run, and a bad choice stops before anything is installed", async () => {
  const env = {};
  const h = harness(repo(), env);
  await main({ ...h.options, argv: ["--share=wifi"] });
  assert.equal(env.MULTIPLAYER_AI_SHARE, "wifi");

  const bad = harness(repo({ installed: false }), {});
  const result = await main({ ...bad.options, argv: ["--share=internet"], startServer: async () => assert.fail("must not start") });
  assert.deepEqual(result, { ok: false, reason: "share" });
  assert.deepEqual(bad.commands, []);
  assert.match(bad.lines.join("\n"), /internet isn't supported/);
});
