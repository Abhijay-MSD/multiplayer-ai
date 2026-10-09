// Run: node --test test/   (no network beyond this computer)
// Getting a new sign-in link: Enter in a terminal, SIGUSR2 anywhere (macOS and Linux). When
// stdin is not a terminal nothing is installed on it, and nothing a stdin does can stop Multiplayer AI.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachFreshLinkHandlers, signInTarget } from "../signin-prompt.js";
import { tempDir, cleanup } from "./helpers/stores.js";

const children = [];
after(async () => {
  for (const c of children) c.kill("SIGKILL");
  await cleanup();
});
const POSIX = process.platform !== "win32";

const tty = () => Object.assign(new EventEmitter(), { isTTY: true, setEncoding() {}, resume() {}, pause() {} });
const rig = (extra = {}) => {
  const shown = [];
  let n = 0;
  const signals = new EventEmitter();
  const detach = attachFreshLinkHandlers({ link: () => `link-${++n}`, onLink: (l) => shown.push(l), signals, ...extra });
  return { shown, signals, detach };
};

test("Enter in a terminal shows a new link each time", () => {
  const stdin = tty();
  const { shown } = rig({ stdin });
  stdin.emit("data", "\n");
  stdin.emit("data", "\n");
  assert.deepEqual(shown, ["link-1", "link-2"]);
});

test("a stdin that is not a terminal gets no handler at all", () => {
  for (const stdin of [null, undefined, {}, { isTTY: false, on() { assert.fail("must not listen"); } }, { isTTY: undefined, on() { assert.fail("must not listen"); } }, new PassThrough()]) {
    assert.doesNotThrow(() => rig({ stdin }).detach());
  }
});

test("a stdin that errors, closes or ends is ignored and does not stop the handlers", () => {
  const stdin = tty();
  const { shown } = rig({ stdin });
  assert.doesNotThrow(() => stdin.emit("error", Object.assign(new Error("EIO"), { code: "EIO" })));
  assert.doesNotThrow(() => stdin.emit("end"));
  assert.doesNotThrow(() => stdin.emit("close"));
  stdin.emit("data", "\n");
  assert.deepEqual(shown, ["link-1"]);
});

test("a failure while making a link is reported and does not throw out of the handler", () => {
  const stdin = tty();
  const lines = [];
  const real = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try {
    attachFreshLinkHandlers({ stdin, signals: new EventEmitter(), link: () => { throw new Error("no server"); }, onLink: () => {} });
    assert.doesNotThrow(() => stdin.emit("data", "\n"));
  } finally {
    console.error = real;
  }
  assert.match(lines.join("\n"), /could not make a new sign-in link: no server/);
});

test("SIGUSR2 shows a new link whether or not there is a terminal", { skip: !POSIX }, () => {
  const { shown, signals } = rig({ stdin: null });
  signals.emit("SIGUSR2");
  assert.deepEqual(shown, ["link-1"]);
});

test("on Windows, where there is no such signal, none is asked for, and a platform that refuses is tolerated", () => {
  const asked = [];
  const signals = { on: (s) => asked.push(s) };
  attachFreshLinkHandlers({ stdin: null, link: () => "x", onLink: () => {}, signals, platform: "win32" });
  assert.deepEqual(asked, []);
  const refusing = { on() { throw new Error("ENOSYS"); } };
  assert.doesNotThrow(() => attachFreshLinkHandlers({ stdin: null, link: () => "x", onLink: () => {}, signals: refusing, platform: "linux" }));
});

test("detaching removes both handlers", () => {
  const stdin = tty();
  const { shown, signals, detach } = rig({ stdin });
  detach();
  stdin.emit("data", "\n");
  signals.emit("SIGUSR2");
  assert.deepEqual(shown, []);
});

test("a link leads to Setup while no key is set up, and to the home page once one is", () => {
  assert.equal(signInTarget({ configured: () => false }), "/setup?next=%2Fnew");
  assert.equal(signInTarget({ configured: () => true }), "/");
  assert.equal(signInTarget(undefined), "/");
});

// ── the real process, with stdin that is not a terminal ──────────────

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function launch(stdio) {
  const child = spawn(process.execPath, ["local.js"], {
    cwd: SERVER_DIR,
    env: { PATH: process.env.PATH, HOME: tempDir("multiplayer-ai-home-"), MULTIPLAYER_AI_NO_DOTENV: "1", MULTIPLAYER_AI_DATA_DIR: path.join(tempDir(), "d") },
    stdio
  });
  children.push(child);
  const run = { child, out: "", err: "", exited: null };
  child.stdout.on("data", (d) => (run.out += d));
  child.stderr.on("data", (d) => (run.err += d));
  child.on("exit", (code, signal) => (run.exited = { code, signal }));
  return run;
}
const until = async (cond, ms = 10000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

for (const [label, stdio, after_] of [
  ["ignored", ["ignore", "pipe", "pipe"], () => {}],
  ["a pipe that stays open", ["pipe", "pipe", "pipe"], () => {}],
  ["a pipe that is closed at once", ["pipe", "pipe", "pipe"], (r) => r.child.stdin.end()],
  ["a pipe that is destroyed", ["pipe", "pipe", "pipe"], (r) => r.child.stdin.destroy()]
]) {
  test(`with stdin as ${label}, Multiplayer AI stays up, says how to get a new link without a terminal, and obeys SIGUSR2`, { skip: !POSIX }, async () => {
    const r = launch(stdio);
    await until(() => /Sign-in link/.test(r.out) && /SIGUSR2|Press Enter/.test(r.out));
    after_(r);
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(r.exited, null, `still running (${r.err})`);
    assert.match(r.out, /No model key is set up yet\. The link below opens Setup/);
    assert.match(r.out, /\/setup\?next=%2Fnew&admin=/);
    assert.match(r.out, /For a new link, send this process SIGUSR2/);
    assert.doesNotMatch(r.out, /Press Enter/);
    r.child.kill("SIGUSR2");
    await until(() => /New sign-in link/.test(r.out));
    const links = [...r.out.matchAll(/admin=([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    assert.equal(new Set(links).size, 2, "the new link is a different one");
    r.child.kill("SIGINT");
    await until(() => r.exited);
    assert.equal(r.exited.code, 0);
  });
}
