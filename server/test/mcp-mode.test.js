// Run: node --test test/   (no network, no real model)
// The MCP server (node server/server.js). Claude Code starts one copy per
// session, so a second copy must never die because the first holds a port, and
// it must not serve HTTP unless asked. These tests start the real thing.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempDir, cleanup } from "./helpers/stores.js";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../server.js");
const children = [];
after(async () => {
  for (const c of children) c.kill();
  await cleanup();
});

// A clean environment: nothing from the developer's own shell or server/.env (cwd is an empty folder).
function launch({ args = [], env = {} } = {}) {
  const child = spawn(process.execPath, [SERVER, ...args], {
    cwd: tempDir("multiplayer-ai-cwd-"),
    env: { PATH: process.env.PATH, MULTIPLAYER_AI_DATA_DIR: path.join(tempDir(), "data"), ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  children.push(child);
  const run = { child, stderr: "", stdout: "", exited: null };
  child.stderr.on("data", (d) => (run.stderr += d));
  child.stdout.on("data", (d) => (run.stdout += d));
  child.on("exit", (code, signal) => (run.exited = { code, signal }));
  return run;
}

const until = async (cond, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function initialize(run) {
  run.child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } }) + "\n"
  );
  await until(() => run.stdout.includes('"id":1'));
  return JSON.parse(run.stdout.split("\n").find((l) => l.includes('"id":1')));
}

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const listening = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
  });

test("two copies run side by side, both answer MCP, and neither takes a port even with PORT set", async () => {
  const port = await freePort();
  const data = path.join(tempDir(), "shared"); // the same data file, as two Claude sessions would share
  const a = launch({ env: { PORT: String(port), MULTIPLAYER_AI_DATA_DIR: data } });
  const b = launch({ env: { PORT: String(port), MULTIPLAYER_AI_DATA_DIR: data } });
  for (const run of [a, b]) {
    const reply = await initialize(run);
    assert.equal(reply.result.serverInfo.name, "multiplayer-ai");
  }
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(a.exited, null, `copy A is still running (${a.stderr})`);
  assert.equal(b.exited, null, `copy B is still running (${b.stderr})`);
  assert.equal(await listening(port), false, "nothing is listening on PORT");
  assert.match(b.stderr, /PORT is set, but this is the MCP server/);
});

test("nothing but MCP is written to stdout", async () => {
  const run = launch();
  await initialize(run);
  for (const line of run.stdout.split("\n").filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line), `not JSON: ${line}`);
});

test("with --http it also serves the app, and a second copy that finds the port taken uses another and stays up", async () => {
  const port = await freePort();
  const data = path.join(tempDir(), "shared");
  const a = launch({ args: ["--http"], env: { MULTIPLAYER_AI_PORT: String(port), MULTIPLAYER_AI_DATA_DIR: data } });
  await until(() => /HTTP listening on/.test(a.stderr));
  assert.match(a.stderr, new RegExp(`HTTP listening on http://127.0.0.1:${port}`));
  const b = launch({ args: ["--http"], env: { MULTIPLAYER_AI_PORT: String(port), MULTIPLAYER_AI_DATA_DIR: data } });
  await until(() => /HTTP listening on/.test(b.stderr));
  assert.match(b.stderr, new RegExp(`port ${port} is busy`));
  assert.doesNotMatch(b.stderr, new RegExp(`HTTP listening on http://127.0.0.1:${port}\\b`));
  const reply = await initialize(b);
  assert.equal(reply.result.serverInfo.name, "multiplayer-ai");
  assert.equal(b.exited, null);
});

test("a bad setting stops the server with a message that names it, instead of a stack trace", async () => {
  const run = launch({ env: { MULTIPLAYER_AI_STORE: "mongo" } });
  await until(() => run.exited);
  assert.notEqual(run.exited.code, 0);
  assert.match(run.stderr, /MULTIPLAYER_AI_STORE must be one of sqlite, supabase, memory/);
  assert.doesNotMatch(run.stderr, /\n\s+at /);
});

test("storage set to Supabase without its settings says what is missing", async () => {
  const run = launch({ env: { MULTIPLAYER_AI_STORE: "supabase" } });
  await until(() => run.exited);
  assert.notEqual(run.exited.code, 0);
  assert.match(run.stderr, /SUPABASE_URL is required/);
});
