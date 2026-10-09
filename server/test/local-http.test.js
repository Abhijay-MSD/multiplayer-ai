// Run: node --test test/   (no network beyond this computer, no real model)
// The app as `npm start` runs it: one server on 127.0.0.1 serving the web app
// and the API, with the request checks that keep other websites out.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import http from "node:http";
import { startHttp, LOCAL_HOST } from "../http.js";
import { makers, cleanup, tempDir } from "./helpers/stores.js";
import { setDefaultStore } from "../store/index.js";
import { createLimits, useLimits } from "../limits.js";

const closers = [];
after(async () => {
  for (const c of closers.splice(0)) await c();
  await cleanup();
});

// A tiny "web app" so the static side can be checked without a build.
function webDir() {
  const dir = tempDir("multiplayer-ai-web-");
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Multiplayer AI</title><div id=root></div>");
  fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log('app')");
  return dir;
}

async function boot(options = {}) {
  const store = await makers.memory();
  setDefaultStore(store);
  useLimits(createLimits({ env: {}, local: true }));
  const app = await startHttp({ store, profile: "local", env: {}, port: 0, webDir: webDir(), log: () => {}, ...options });
  closers.push(() => app.close());
  return { app, store };
}

// Raw requests, so a test can send any Host or Origin header (fetch refuses to).
function request(app, { method = "GET", path: p = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: LOCAL_HOST, port: app.port, method, path: p, headers: { Host: `${LOCAL_HOST}:${app.port}`, ...headers } },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
      }
    );
    req.on("error", reject);
    if (body !== undefined) {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      req.setHeader("Content-Type", "application/json");
      req.setHeader("Content-Length", Buffer.byteLength(payload));
      req.write(payload);
    }
    req.end();
  });
}

const create = (extra = {}) => ({ method: "POST", path: "/api/tools/create_session", body: { task: "Plan a trip", creator_name: "Alice" }, ...extra });

// ── where it listens ──────────────────────────────────────────────────

test("it listens on 127.0.0.1 only, and says so in the address it returns", async () => {
  const { app } = await boot();
  assert.equal(app.server.address().address, "127.0.0.1");
  assert.equal(app.url, `http://127.0.0.1:${app.port}`);
});

test("the default port is 3737, MULTIPLAYER_AI_PORT changes it, and a busy port gets a free one with the real address", async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const busy = blocker.address().port;
  const lines = [];
  const store = await makers.memory();
  setDefaultStore(store);
  const app = await startHttp({ store, profile: "local", env: { MULTIPLAYER_AI_PORT: String(busy) }, webDir: webDir(), log: (l) => lines.push(l) });
  closers.push(() => app.close(), () => new Promise((r) => blocker.close(r)));
  assert.notEqual(app.port, busy);
  assert.ok(app.port > 0);
  assert.match(lines.join("\n"), new RegExp(`port ${busy} is busy.*${app.port}`));
  assert.equal((await request(app, { path: "/api/config" })).status, 200, "and it answers on the port it printed");
});

// ── the web app ───────────────────────────────────────────────────────

test("it serves the built web app, and a link into a room loads the same page", async () => {
  const { app } = await boot();
  const home = await request(app, { path: "/" });
  assert.equal(home.status, 200);
  assert.match(home.text, /<div id=root>/);
  assert.equal((await request(app, { path: "/assets/app.js" })).status, 200);
  const room = await request(app, { path: "/s/3f0c1d2e-0000-4000-8000-000000000000/join" });
  assert.equal(room.status, 200);
  assert.match(room.text, /<div id=root>/);
});

test("an unknown path under /api is a JSON 404, not the web page", async () => {
  const { app } = await boot();
  const res = await request(app, { path: "/api/nope" });
  assert.equal(res.status, 404);
  assert.equal(res.json().code, "NOT_FOUND");
});

test("without a built web app it still serves the API and says what is missing", async () => {
  const lines = [];
  const { app } = await boot({ webDir: path.join(tempDir(), "missing"), log: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /web app has not been built/);
  assert.equal((await request(app, { path: "/api/config" })).status, 200);
});

// ── the config endpoint ───────────────────────────────────────────────

test("/api/config returns the room step cap and nothing else", async () => {
  const { app } = await boot({ env: { MAX_STEPS_PER_SESSION: "12", GEMINI_API_KEY: "should-never-appear", SUPABASE_SERVICE_KEY: "nor-this" } });
  const res = await request(app, { path: "/api/config" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { max_steps_per_session: 12 });
  assert.ok(!res.text.includes("should-never-appear") && !res.text.includes("nor-this"));
});

test("/api/config says 50 when the cap is not set", async () => {
  const { app } = await boot();
  assert.deepEqual((await request(app, { path: "/api/config" })).json(), { max_steps_per_session: 50 });
});

// ── Host header (DNS rebinding) ───────────────────────────────────────

test("a request with a forged Host header is refused, whatever it asks for", async () => {
  const { app } = await boot();
  for (const host of [
    "evil.example",
    `evil.example:${app.port}`,
    `127.0.0.1.evil.example:${app.port}`,
    `localhost.evil.example:${app.port}`,
    `127.0.0.1:${app.port + 1}`, // right name, wrong port
    "127.0.0.1", // no port
    "0.0.0.0:" + app.port
  ]) {
    for (const p of ["/", "/api/config", "/assets/app.js"]) {
      const res = await request(app, { path: p, headers: { Host: host } });
      assert.equal(res.status, 403, `Host "${host}" for ${p}`);
      assert.equal(res.json().code, "BAD_HOST");
    }
  }
  const post = await request(app, create({ headers: { Host: "evil.example" } }));
  assert.equal(post.status, 403);
  assert.equal(post.json().code, "BAD_HOST");
});

test("a request with no Host header at all is refused", async () => {
  const { app } = await boot();
  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(app.port, LOCAL_HOST, () => socket.write("GET /api/config HTTP/1.0\r\n\r\n"));
    let text = "";
    socket.on("data", (d) => (text += d));
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
  });
  assert.match(reply, /^HTTP\/1\.1 403/);
  assert.match(reply, /BAD_HOST/);
});

test("localhost and 127.0.0.1 with our port are both accepted, in any letter case", async () => {
  const { app } = await boot();
  for (const host of [`localhost:${app.port}`, `127.0.0.1:${app.port}`, `LocalHost:${app.port}`]) {
    assert.equal((await request(app, { path: "/api/config", headers: { Host: host } })).status, 200, host);
  }
});

// ── Origin (cross-site requests) ──────────────────────────────────────

test("a POST from another website's origin is refused, and creates nothing", async () => {
  const { app, store } = await boot();
  for (const origin of ["https://evil.example", "http://localhost:9999", "http://127.0.0.1:1", "null", `http://evil.example:${app.port}`]) {
    const res = await request(app, create({ headers: { Origin: origin } }));
    assert.equal(res.status, 403, `Origin ${origin}`);
    assert.equal(res.json().code, "BAD_ORIGIN");
  }
  assert.equal(store._tables.sessions.size, 0, "no room was created by any of them");
});

test("a POST the browser marks as cross-site is refused even if its Origin looks right", async () => {
  const { app, store } = await boot();
  for (const site of ["cross-site", "same-site"]) {
    const res = await request(app, create({ headers: { Origin: app.url, "Sec-Fetch-Site": site } }));
    assert.equal(res.status, 403, site);
  }
  assert.equal(store._tables.sessions.size, 0);
});

test("a POST from the app's own origin works, from either of its addresses", async () => {
  const { app } = await boot();
  for (const origin of [app.url, `http://localhost:${app.port}`]) {
    const res = await request(app, create({ headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" } }));
    assert.equal(res.status, 200, origin);
    assert.ok(res.json().token.startsWith("mpai_"));
  }
});

test("a program with no Origin (curl, an MCP client) is allowed to POST", async () => {
  const { app } = await boot();
  assert.equal((await request(app, create())).status, 200);
});

test("the other state-changing methods are checked the same way", async () => {
  const { app } = await boot();
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    const res = await request(app, { method, path: "/api/tools/create_session", headers: { Origin: "https://evil.example" } });
    assert.equal(res.status, 403, method);
  }
});

// ── CORS ──────────────────────────────────────────────────────────────

test("no response carries a CORS header, so another website cannot read one", async () => {
  const { app } = await boot();
  const responses = [
    await request(app, { path: "/api/config", headers: { Origin: "https://evil.example" } }),
    await request(app, { path: "/", headers: { Origin: "https://evil.example" } }),
    await request(app, create({ headers: { Origin: "https://evil.example" } })), // refused
    await request(app, create()), // allowed
    await request(app, { path: "/api/config", headers: { Host: "evil.example" } }) // refused
  ];
  for (const res of responses) {
    const cors = Object.keys(res.headers).filter((h) => h.startsWith("access-control-"));
    assert.deepEqual(cors, [], `status ${res.status} sent ${cors}`);
  }
});

test("a CORS preflight is never approved", async () => {
  const { app } = await boot();
  const foreign = await request(app, {
    method: "OPTIONS", path: "/api/tools/create_session",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" }
  });
  assert.equal(foreign.status, 403);
  const same = await request(app, { method: "OPTIONS", path: "/api/tools/create_session", headers: { Origin: app.url } });
  assert.equal(same.status, 405);
  for (const res of [foreign, same]) assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("responses ask the browser not to guess types, frame the app or send a Referer", async () => {
  const { app } = await boot();
  const res = await request(app, { path: "/" });
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.equal(res.headers["x-powered-by"], undefined);
});

// ── the live stream is guarded too ────────────────────────────────────

test("the live stream refuses a forged Host and a missing token", async () => {
  const { app } = await boot();
  const id = "3f0c1d2e-0000-4000-8000-000000000000";
  assert.equal((await request(app, { path: `/api/stream/${id}`, headers: { Host: "evil.example" } })).status, 403);
  assert.equal((await request(app, { path: `/api/stream/${id}` })).status, 401);
});

// ── local mode: limits are off unless set ─────────────────────────────

test("on a local store the per-IP limits are off: 40 rooms from one address all start", async () => {
  const { app } = await boot();
  for (let i = 0; i < 40; i++) {
    const res = await request(app, { method: "POST", path: "/api/tools/create_session", body: { task: "t", creator_name: `P${i}` } });
    assert.equal(res.status, 200, `room ${i + 1}`);
  }
});

test("setting CREATE_LIMIT_PER_HOUR turns the per-IP limit on", async () => {
  const store = await makers.memory();
  setDefaultStore(store);
  useLimits(createLimits({ env: { CREATE_LIMIT_PER_HOUR: "2" }, local: true }));
  const app = await startHttp({ store, profile: "local", env: {}, port: 0, webDir: webDir(), log: () => {} });
  closers.push(() => app.close());
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await request(app, create())).status);
  assert.deepEqual(codes, [200, 200, 429, 429]);
  useLimits(createLimits({ env: {}, local: true }));
});
