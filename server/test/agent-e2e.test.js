// Run: node --test test/   (no network, no key)
// The agent writing a file, end to end through the real launcher (`node scripts/start.mjs`), once for each provider, each in
// its own service's tool-calling format. The services themselves are stood in for by test/helpers/fake-services.cjs, which
// answers the adapters' fixed addresses inside the started process and refuses a request that is not in the right shape.
// The key used is made up.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempDir, cleanup } from "./helpers/stores.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BLOCKER = path.join(ROOT, "server/test/helpers/block-network.cjs");
const FAKES = path.join(ROOT, "server/test/helpers/fake-services.cjs");
const KEY = "key_agent_e2e_made_up_0123456789";

const children = [];
after(async () => {
  for (const c of children) c.kill("SIGKILL");
  await cleanup();
});

const until = async (cond, ms, what) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

function launch(dataDir) {
  const child = spawn(process.execPath, ["scripts/start.mjs"], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: tempDir("multiplayer-ai-home-"), NO_OPEN: "1", MULTIPLAYER_AI_NO_DOTENV: "1", MULTIPLAYER_AI_DATA_DIR: dataDir, NODE_OPTIONS: `--require "${BLOCKER}" --require "${FAKES}"`, npm_config_offline: "true" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  const run = { child, out: "", err: "", exited: null };
  child.stdout.on("data", (d) => (run.out += d));
  child.stderr.on("data", (d) => (run.err += d));
  child.on("exit", (code) => (run.exited = { code }));
  return run;
}

function call(base, method, route, { headers = {}, body } = {}) {
  const u = new URL(route, base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...(method === "GET" ? {} : { Origin: base }), ...headers } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    if (body !== undefined) {
      const payload = JSON.stringify(body);
      req.setHeader("Content-Type", "application/json");
      req.setHeader("Content-Length", Buffer.byteLength(payload));
      req.write(payload);
    }
    req.end();
  });
}

test("each provider's adapter writes a file through the real launcher, in that provider's own format", { timeout: 300_000 }, async () => {
  for (const d of ["server/node_modules", "web/node_modules"]) assert.ok(fs.existsSync(path.join(ROOT, d)), `${d} is missing. Run "npm ci" in server/ and web/ first; this test does not install anything. CI installs and builds before it runs the server tests.`);
  const data = path.join(tempDir(), "data");
  const run = launch(data);
  await until(() => /Sign-in link[^\n]*\n\s+http\S+/.test(run.out) || run.exited, 120_000, "Multiplayer AI to start");
  assert.equal(run.exited, null, run.out + run.err);
  const url = /Multiplayer AI is running at (http:\/\/127\.0\.0\.1:\d+)/.exec(run.out)[1];
  const link = new URL(/Sign-in link[^\n]*\n\s+(http\S+)/.exec(run.out)[1]);
  const signed = await call(url, "GET", link.pathname + link.search);
  const admin = { Cookie: signed.headers["set-cookie"][0].split(";")[0] };

  const results = {};
  for (const [provider, who] of [["groq", "groq"], ["claude", "claude"], ["gemini", "gemini"]]) {
    assert.equal((await call(url, "PUT", "/api/settings", { headers: admin, body: { provider } })).status, 200, provider);
    assert.equal((await call(url, "PUT", "/api/settings/key", { headers: admin, body: { provider, key: `${KEY}_${provider}` } })).status, 200);
    const room = (await call(url, "POST", "/api/tools/create_session", { headers: admin, body: { task: `Write notes with ${provider}`, creator_name: "Abhi", auto_start: true } })).json();
    let events;
    await until(async () => ((events = (await call(url, "POST", "/api/tools/get_session", { body: { session_id: room.session_id, token: room.token } })).json().events), events.some((e) => e.kind === "agent_message" || /could not reply/.test(e.content))), 20_000, `${provider}'s reply`);
    const reply = events.find((e) => e.kind === "agent_message");
    assert.ok(reply, `${provider}: no reply. Room said: ${events.filter((e) => e.kind === "status").map((e) => e.content).join(" | ")}. Terminal: ${run.err.split("\n").filter((l) => /gemini|fake service|failed/.test(l)).slice(-4).join(" ")}`);
    assert.equal(reply.content, `Wrote notes.md through ${who}.`);
    const file = (await call(url, "POST", "/api/tools/get_room_file", { body: { session_id: room.session_id, token: room.token, name: "notes.md" } })).json().file;
    assert.deepEqual([file.content, file.updated_by, file.on_behalf_of, file.version], [`hello from ${who}`, "agent", "Abhi", 1]);
    const lines = events.filter((e) => e.kind === "status").map((e) => e.content);
    assert.ok(lines.includes("Created notes.md, 16 bytes") || lines.includes(`Created notes.md, ${`hello from ${who}`.length} bytes`), `${provider}: ${lines.join(" | ")}`);
    results[provider] = { room, lines };
  }

  const gone = await new Promise((resolve) => (run.child.once("exit", (code) => resolve(code)), run.child.kill("SIGINT")));
  assert.equal(gone, 0, "stops cleanly");
  const printed = run.out + run.err;
  assert.ok(!printed.includes(KEY), "no key in anything printed");
  for (const f of fs.readdirSync(data).filter((n) => n.startsWith("multiplayer-ai.db"))) assert.ok(!fs.readFileSync(path.join(data, f)).includes(KEY), `${f} holds no key`);
});
