// Run: node --test test/   (no real key, no network)
//
// The whole first run, end to end, through the real launcher (`npm start` runs exactly
// `node scripts/start.mjs`): start Multiplayer AI on a temporary data folder, sign in with the link it
// prints, find there is no key, set one up against a provider on this computer, start a room, and
// receive the reply over the live stream the way a browser would. Then stop it, start it again,
// and check that the key survived and the old sign-in did not.
//
// The started process (and any npm it starts) runs with test/helpers/block-network.cjs, which
// makes every connection to anything but this computer fail. So this passes only if the first
// run needs no network at all, and it passes the same on a machine that has none. The test
// process itself is not affected.
//
// It needs the packages installed (npm ci in server/ and web/) so that nothing is fetched. The
// web app is built by the launcher if there is no current build.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFakeProvider, ok } from "./helpers/fakeProvider.js";
import { tempDir, cleanup } from "./helpers/stores.js";
import { lanCandidates } from "../sharing.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BLOCKER = path.join(ROOT, "server/test/helpers/block-network.cjs");
const KEY = "sk_smoke_test_made_up_key_0123456789";
const REPLY = "Here is a plan for your trip.";
const POSIX = process.platform !== "win32";

const children = [];
const closers = [];
after(async () => {
  for (const c of children) c.kill("SIGKILL");
  for (const c of closers) await c();
  await cleanup();
});

function prerequisites() {
  for (const dir of ["server/node_modules", "web/node_modules"]) {
    assert.ok(fs.existsSync(path.join(ROOT, dir)), `${dir} is missing. Run "npm ci" in server/ and in web/ first; this test does not install anything. CI installs and builds before it runs the server tests.`);
  }
}

/** Starts `node scripts/start.mjs` the way a clean computer would, with the network blocked for it. */
function launch(dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, ["scripts/start.mjs"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: tempDir("multiplayer-ai-home-"),
      NO_OPEN: "1",
      MULTIPLAYER_AI_NO_DOTENV: "1",
      MULTIPLAYER_AI_DATA_DIR: dataDir,
      NODE_OPTIONS: `--require "${BLOCKER}"`, // quoted: this path may contain spaces
      npm_config_offline: "true",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  const run = { child, out: "", err: "", exited: null };
  child.stdout.on("data", (d) => (run.out += d));
  child.stderr.on("data", (d) => (run.err += d));
  child.on("exit", (code, signal) => (run.exited = { code, signal }));
  return run;
}

async function until(cond, ms, what) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function started(run) {
  await until(() => /Sign-in link[^\n]*\n\s+http\S+/.test(run.out) || run.exited, 120_000, "Multiplayer AI to start");
  assert.equal(run.exited, null, `Multiplayer AI exited while starting:\n${run.out}\n${run.err}`);
  const url = /Multiplayer AI is running at (http:\/\/127\.0\.0\.1:\d+)/.exec(run.out)[1];
  const link = /Sign-in link[^\n]*\n\s+(http\S+)/.exec(run.out)[1];
  return { url, link, port: new URL(url).port };
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

async function signIn(base, link) {
  const u = new URL(link);
  const res = await call(base, "GET", u.pathname + u.search);
  assert.equal(res.status, 303);
  const cookie = res.headers["set-cookie"]?.[0]?.split(";")[0];
  return { cookie, location: res.headers.location };
}

/** Waits on the room's live stream (token in a header, as the browser does it) for an agent reply. */
function reply(base, sessionId, token, ms = 15_000) {
  return new Promise((resolve, reject) => {
    const u = new URL(`/api/stream/${sessionId}?after=0`, base);
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" } }, (res) => {
      let text = "";
      const timer = setTimeout(() => (req.destroy(), reject(new Error(`no reply within ${ms}ms; stream so far:\n${text}`))), ms);
      res.on("data", (d) => {
        text += d;
        const m = /event: event\ndata: (\{[^\n]*"kind":"agent_message"[^\n]*\})/.exec(text);
        if (m) {
          clearTimeout(timer);
          req.destroy();
          resolve(JSON.parse(m[1]));
        }
      });
    });
    req.on("error", (e) => e.code !== "ECONNRESET" && reject(e));
  });
}

const stop = async (run) => {
  run.child.kill("SIGINT");
  await until(() => run.exited, 15_000, "Multiplayer AI to stop");
  return run.exited;
};

test("first run to first reply, then a restart, through the real launcher with no network", { timeout: 240_000 }, async () => {
  prerequisites();
  const provider = await startFakeProvider(ok(REPLY));
  closers.push(() => provider.close());
  const data = path.join(tempDir(), "data");

  // ── first start ────────────────────────────────────────────────────
  const first = launch(data);
  const a = await started(first);
  assert.match(first.out, /No model key is set up yet\. The link below opens Setup/, "the terminal says there is no key");
  assert.match(a.link, /\/setup\?next=%2Fnew&admin=/, "and the link goes to Setup");

  const home = await call(a.url, "GET", "/");
  assert.equal(home.status, 200);
  assert.match(home.text, /id="root"/, "the built web app is served from the same port");

  // Nothing in the page or its styles names another host, and the fonts are served by Multiplayer AI itself.
  const cssPath = /href="(\/assets\/[^"]+\.css)"/.exec(home.text)?.[1];
  assert.ok(cssPath, "the page links its stylesheet");
  const css = await call(a.url, "GET", cssPath);
  assert.equal(css.status, 200);
  assert.doesNotMatch(home.text + css.text, /https?:\/\//, "the page and its styles name no other host");
  const fontPath = /url\((\/assets\/[^)]+\.woff2)\)/.exec(css.text)?.[1];
  assert.ok(fontPath, "the styles name a bundled font file");
  const font = await call(a.url, "GET", fontPath);
  assert.equal(font.status, 200, "and Multiplayer AI serves it");
  assert.match(font.headers["content-type"], /font\/woff2/);

  const { cookie, location } = await signIn(a.url, a.link);
  assert.ok(cookie, "the link signs the browser in");
  assert.equal(location, "/setup?next=%2Fnew", "and sends it on to Setup with the code removed");
  const admin = { Cookie: cookie };

  assert.deepEqual((await call(a.url, "GET", "/api/status")).json(), { configured: false, sharing: false, host: false }, "a yes or no about the key, and whether sharing is on and whether the caller is the host");
  const refused = await call(a.url, "POST", "/api/tools/create_session", { body: { task: "Plan a trip", creator_name: "Abhi", auto_start: true } });
  assert.equal(refused.status, 409);
  assert.equal(refused.json().code, "NO_KEY");

  // Set up the provider: test the key, then save it.
  const tested = await call(a.url, "POST", "/api/settings/key/test", { headers: admin, body: { provider: "compat", key: KEY, base_url: provider.base, model: "smoke-model" } });
  assert.deepEqual(tested.json(), { ok: true, model: "smoke-model" });
  assert.equal((await call(a.url, "PUT", "/api/settings", { headers: admin, body: { provider: "compat", base_url: provider.base, model: "smoke-model" } })).status, 200);
  const saved = await call(a.url, "PUT", "/api/settings/key", { headers: admin, body: { provider: "compat", key: KEY } });
  assert.equal(saved.status, 200);
  assert.ok(!saved.text.includes(KEY));
  assert.equal((await call(a.url, "GET", "/api/status")).json().configured, true);

  // Start a room and get the agent's reply on the live stream.
  const room = (await call(a.url, "POST", "/api/tools/create_session", { body: { task: "Plan a trip to Lisbon", creator_name: "Abhi", auto_start: true } })).json();
  assert.ok(room.session_id && room.token.startsWith("mpai_"));
  const answer = await reply(a.url, room.session_id, room.token);
  assert.equal(answer.content, REPLY);
  assert.equal(answer.author, "agent");

  const seen = provider.requests.at(-1);
  assert.equal(seen.headers.authorization, `Bearer ${KEY}`, "the saved key is what the provider received");
  assert.match(seen.body, /Plan a trip to Lisbon/);
  assert.ok(!seen.url.includes(KEY) && !seen.body.includes(KEY));

  // The key is where it should be, and nowhere else.
  const settingsFile = path.join(data, "settings.json");
  assert.ok(fs.readFileSync(settingsFile, "utf8").includes(KEY));
  if (POSIX) {
    assert.equal((fs.statSync(settingsFile).mode & 0o777).toString(8), "600");
    assert.equal((fs.statSync(data).mode & 0o777).toString(8), "700");
  }
  for (const f of fs.readdirSync(data).filter((n) => n.startsWith("multiplayer-ai.db"))) {
    assert.ok(!fs.readFileSync(path.join(data, f)).includes(KEY), `${f} must not hold the key`);
  }
  const gone = await stop(first);
  assert.equal(gone.code, 0, "stops cleanly on Ctrl+C");
  assert.ok(!(first.out + first.err).includes(KEY), "the key is in nothing Multiplayer AI printed");

  // ── second start, same folder ──────────────────────────────────────
  const second = launch(data);
  const b = await started(second);
  assert.doesNotMatch(second.out, /No model key is set up yet/, "the key was kept");
  assert.match(b.link, /^http:\/\/127\.0\.0\.1:\d+\/\?admin=/, "so the link goes to the home page");
  assert.equal((await call(b.url, "GET", "/api/status")).json().configured, true);
  assert.equal((await call(b.url, "GET", "/api/settings", { headers: admin })).status, 401, "the old sign-in ended with the old process");
  const again = await signIn(b.url, b.link);
  assert.ok(again.cookie && again.cookie !== cookie);
  assert.equal((await call(b.url, "GET", "/api/settings", { headers: { Cookie: again.cookie } })).status, 200);
  const room2 = (await call(b.url, "POST", "/api/tools/create_session", { body: { task: "And another", creator_name: "Abhi", auto_start: true } })).json();
  assert.equal((await reply(b.url, room2.session_id, room2.token)).content, REPLY);
  assert.equal((await stop(second)).code, 0);
  assert.ok(!(second.out + second.err).includes(KEY));
});

test("when the port is taken, it says so and runs on another that works", { timeout: 240_000 }, async () => {
  prerequisites();
  // A port this test holds itself for the whole run (the default, 3737, may be held or freed by other tests running at the same time).
  const blocker = net.createServer();
  const taken = await new Promise((resolve) => blocker.listen(0, "127.0.0.1", () => resolve(blocker.address().port)));
  closers.push(() => new Promise((r) => blocker.close(r)));

  const run = launch(path.join(tempDir(), "data"), { MULTIPLAYER_AI_PORT: String(taken) });
  const { url, port } = await started(run);
  assert.notEqual(port, String(taken));
  assert.match(run.out, new RegExp(`port ${taken} is busy \\(it is the one set in MULTIPLAYER_AI_PORT\\)\\. Another copy of Multiplayer AI or another program is using it, so this copy is using \\d+ instead\\.`));
  assert.match(run.out, new RegExp(`Multiplayer AI is running at http://127\\.0\\.0\\.1:${port}`));
  assert.deepEqual((await call(url, "GET", "/api/config")).json(), { max_steps_per_session: 50 });
  assert.equal((await stop(run)).code, 0);
});

test("sharing on the Wi-Fi through the real launcher: guests need the link, only the host starts rooms, nothing secret is printed", { timeout: 240_000 }, async (t) => {
  prerequisites();
  const candidates = lanCandidates(os.networkInterfaces());
  const usual = candidates.filter((c) => c.kind === "private");
  const provider = await startFakeProvider(ok(REPLY));
  closers.push(() => provider.close());
  const data = path.join(tempDir(), "data");

  const run = launch(data, { MULTIPLAYER_AI_SHARE: "wifi" });
  const a = await started(run);

  if (candidates.length !== 1 || usual.length !== 1) {
    // More than one address (or none, or only an unusual one): it must not guess. The same code path, run on a machine with one address, is the branch below.
    assert.match(run.out, /Sharing was not turned on/, "with no single ordinary address it says it did not turn sharing on");
    assert.equal((await call(a.url, "GET", "/api/status")).json().sharing, false);
    assert.equal((await stop(run)).code, 0);
    t.diagnostic(`this computer has ${candidates.length} candidate address(es), so only the refusal was exercised`);
    return;
  }

  const lan = usual[0].address;
  assert.match(run.out, new RegExp(`Sharing is on for ${lan.replace(/\./g, "\\.")} \\(port ${a.port}\\)\\. This link uses plain http`), "the terminal says which address and warns about plain http");
  const guestBase = `http://${lan}:${a.port}`;

  // Set up a provider as the host, over this computer's own address.
  const { cookie } = await signIn(a.url, a.link);
  const admin = { Cookie: cookie };
  assert.equal((await call(a.url, "PUT", "/api/settings", { headers: admin, body: { provider: "compat", base_url: provider.base, model: "smoke-model" } })).status, 200);
  assert.equal((await call(a.url, "PUT", "/api/settings/key", { headers: admin, body: { provider: "compat", key: KEY } })).status, 200);
  assert.deepEqual((await call(a.url, "GET", "/api/status", { headers: admin })).json(), { configured: true, sharing: true, host: true });

  // A guest on the network: the page and a yes/no status, nothing of the host's.
  assert.equal((await call(guestBase, "GET", "/")).status, 200);
  assert.deepEqual((await call(guestBase, "GET", "/api/status")).json(), { configured: true, sharing: true, host: false });
  for (const [method, route] of [["GET", "/api/settings"], ["GET", "/api/data/export"], ["GET", "/api/host/sharing"], ["PUT", "/api/settings/key"]]) {
    const res = await call(guestBase, method, route, { headers: admin, body: method === "PUT" ? { provider: "compat", key: "x" } : undefined });
    assert.equal(res.status, 404, `${method} ${route} is not there on the network address, even with the host's cookie`);
  }
  const notHost = await call(guestBase, "POST", "/api/tools/create_session", { headers: admin, body: { task: "Nope", creator_name: "Guest" } });
  assert.equal(notHost.status, 403);
  assert.equal(notHost.json().code, "HOST_ONLY", "a guest can't start a room, even with a copied sign-in cookie");

  // The host starts a room and gets its link.
  const room = (await call(a.url, "POST", "/api/tools/create_session", { headers: admin, body: { task: "Plan a trip", creator_name: "Abhi", auto_start: true } })).json();
  assert.ok(room.session_id && room.token.startsWith("mpai_"));
  const panel = (await call(a.url, "GET", `/api/host/rooms/${room.session_id}`, { headers: admin })).json();
  const link = new URL(panel.share.link);
  assert.equal(link.host, `${lan}:${a.port}`, "the guest link is on the network address");
  const secret = /^#k=([A-Za-z0-9_-]{43})$/.exec(link.hash)?.[1];
  assert.ok(secret, "and carries the room's secret after the #");
  assert.match(panel.share.qr_svg, /^<svg/);

  const noLink = await call(guestBase, "POST", "/api/tools/join_session", { body: { session_id: room.session_id, name: "Dana" } });
  assert.equal(noLink.status, 403);
  assert.equal(noLink.json().code, "INVITE_REQUIRED");
  const wrong = await call(guestBase, "POST", "/api/tools/join_session", { body: { session_id: room.session_id, name: "Dana", invite: "A".repeat(43) } });
  assert.equal(wrong.status, 403);
  const joined = await call(guestBase, "POST", "/api/tools/join_session", { body: { session_id: room.session_id, name: "Dana", invite: secret } });
  assert.equal(joined.status, 200);
  const guest = joined.json();
  assert.ok(guest.token.startsWith("mpai_"));
  assert.ok(!joined.text.includes(secret), "the secret is not echoed back to the guest");
  assert.equal(guest.you.role, "watcher");

  // The host's message gets a reply, and the guest sees it on the live stream over the network.
  assert.equal((await reply(guestBase, room.session_id, guest.token)).content, REPLY);

  assert.equal((await stop(run)).code, 0);
  const printed = run.out + run.err;
  assert.ok(!printed.includes(secret), "the room's secret is not in anything Multiplayer AI printed");
  assert.ok(!printed.includes("#k="), "and neither is a guest link");
  assert.ok(!printed.includes(KEY));
  for (const f of fs.readdirSync(data)) {
    if (f === "instance.key") continue;
    const bytes = fs.readFileSync(path.join(data, f));
    assert.ok(!bytes.includes(secret), `${f} does not hold the room's secret`);
  }
});

test("the start script npm runs is the launcher this test drives", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts.start, "node scripts/start.mjs");
});
