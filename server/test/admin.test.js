// Run: node --test test/   (no network beyond this computer, no real model)
// Setup and Settings behind the sign-in link: who can reach them, what they do, and that
// a tunnel, another computer or another website cannot.
import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createAdminAuth, COOKIE_NAME, CODE_TTL_MS, SESSION_TTL_MS } from "../admin.js";
import { boot, request, lanAddress, resetSettings } from "./helpers/http.js";
import { startFakeProvider, ok } from "./helpers/fakeProvider.js";
import { cleanup, tempDir } from "./helpers/stores.js";

const closers = [];
after(async () => {
  for (const c of closers.splice(0)) await c();
  resetSettings();
  await cleanup();
});
const up = async (options) => {
  const b = await boot(options);
  closers.push(() => b.app.close());
  return b;
};
const KEY = "gsk_made_up_key_for_admin_tests_4242";
const ADMIN_ROUTES = [
  ["GET", "/api/settings"],
  ["PUT", "/api/settings"],
  ["PUT", "/api/settings/key"],
  ["DELETE", "/api/settings/key"],
  ["POST", "/api/settings/key/test"],
  ["POST", "/api/settings/base-url/check"],
  ["POST", "/api/data/export"],
  ["POST", "/api/data/delete-rooms"]
];

// ── the sign-in link ──────────────────────────────────────────────────

test("the link signs the browser in: a cookie that JavaScript cannot read and other sites cannot send, and the code is gone from the address", async () => {
  const { app } = await up();
  const link = new URL(app.admin.link());
  const code = link.searchParams.get("admin");
  const res = await request(app, { path: "/settings?tab=key&admin=" + code });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, "/settings?tab=key", "the code is stripped, the rest of the address kept");
  const cookie = res.headers["set-cookie"][0];
  assert.match(cookie, new RegExp(`^${COOKIE_NAME}=`));
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Strict/);
  assert.match(cookie, /; Path=\//);
  assert.doesNotMatch(cookie, /Domain=/i, "bound to the exact host it was set on");
  assert.ok(!cookie.includes(code), "the cookie is not the code");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
});

test("the cookie opens the settings routes", async () => {
  const { app, cookie } = await up();
  const c = await cookie();
  const res = await request(app, { path: "/api/settings", headers: { Cookie: c } });
  assert.equal(res.status, 200);
  assert.equal(res.json().configured, false);
});

test("a code works once", async () => {
  const { app } = await up();
  const link = new URL(app.admin.link());
  const first = await request(app, { path: link.pathname + link.search });
  const second = await request(app, { path: link.pathname + link.search });
  assert.ok(first.headers["set-cookie"]);
  assert.equal(second.status, 303);
  assert.equal(second.headers.location, "/signin-expired", "sent to the page that says the link is used up");
  assert.equal(second.headers["set-cookie"], undefined, "and given no cookie");
});

test("a wrong, empty, malformed or oversized code gives no cookie, and does not use up a real one", async () => {
  const { app } = await up();
  const real = new URL(app.admin.link());
  for (const bad of ["", "x", "not-the-code-not-the-code-not-the-code", "a".repeat(5000), "%00%00", "../../etc/passwd"]) {
    const res = await request(app, { path: "/?admin=" + encodeURIComponent(bad) });
    assert.equal(res.headers["set-cookie"], undefined, `code "${bad.slice(0, 20)}"`);
  }
  const good = await request(app, { path: real.pathname + real.search });
  assert.ok(good.headers["set-cookie"], "the real code still works");
});

test("no cookie, a made-up cookie, or the code in place of the cookie are all refused with the instruction to use the terminal's link", async () => {
  const { app } = await up();
  const code = new URL(app.admin.link()).searchParams.get("admin");
  for (const headers of [{}, { Cookie: `${COOKIE_NAME}=forged` }, { Cookie: `${COOKIE_NAME}=${code}` }, { Cookie: "other=1" }]) {
    for (const [method, route] of ADMIN_ROUTES) {
      const res = await request(app, { method, path: route, headers, body: method === "GET" ? undefined : {} });
      assert.equal(res.status, 401, `${method} ${route} with ${JSON.stringify(headers)}`);
      assert.equal(res.json().code, "ADMIN_LINK_NEEDED");
      assert.match(res.json().error, /link in the terminal/);
    }
  }
});

test("the only thing open without signing in is three yes-or-no answers: is a key set up, is sharing on, are you the host", async () => {
  const { app } = await up();
  const res = await request(app, { path: "/api/status" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { configured: false, sharing: false, host: false });
});

// ── the code and the cookie, as units ─────────────────────────────────

test("a code expires after 5 minutes and a signed-in browser after 7 days", () => {
  let t = 1_000_000;
  const auth = createAdminAuth({ now: () => t });
  const code = auth.issueCode();
  t += CODE_TTL_MS - 1;
  const cookie = auth.exchange(code);
  assert.ok(cookie, "just inside the limit");
  const late = auth.issueCode();
  t += CODE_TTL_MS + 1;
  assert.equal(auth.exchange(late), null, "just past it");
  assert.equal(auth.isValidSession(cookie), true);
  t += SESSION_TTL_MS;
  assert.equal(auth.isValidSession(cookie), false);
});

test("codes are compared by hash in constant time, against every outstanding code", () => {
  const auth = createAdminAuth();
  auth.issueCode();
  auth.issueCode();
  auth.issueCode();
  const spy = mock.method(crypto, "timingSafeEqual");
  try {
    assert.equal(auth.exchange("w".repeat(43)), null);
    assert.equal(spy.mock.callCount(), 3, "no early exit: every stored code is compared");
  } finally {
    spy.mock.restore();
  }
});

test("each code and each cookie is different, long and not guessable from the last", () => {
  const auth = createAdminAuth();
  const codes = new Set(Array.from({ length: 50 }, () => auth.issueCode()));
  assert.equal(codes.size, 50);
  for (const c of codes) assert.ok(c.length >= 43);
  const cookies = new Set([...codes].map((c) => auth.exchange(c)));
  assert.equal(cookies.size, 50);
});

test("restarting ends every sign-in (they live in the running process only)", () => {
  const auth = createAdminAuth();
  const cookie = auth.exchange(auth.issueCode());
  assert.equal(createAdminAuth().isValidSession(cookie), false);
  auth.revokeAll();
  assert.equal(auth.isValidSession(cookie), false);
});

// ── a tunnel ──────────────────────────────────────────────────────────

const TUNNEL = "abc123.tunnel.example";

test("a tunnel: it reaches rooms, but the connection comes from this computer with a rewritten Host and no proxy headers, and settings still refuse it", async () => {
  const { app, cookie } = await up({ extraHosts: [TUNNEL] });
  const c = await cookie();

  // The tunnel's host is allowed for rooms, so this really is the situation to defend against.
  const room = await request(app, { path: "/api/config", headers: { Host: TUNNEL } });
  assert.equal(room.status, 200, "rooms answer on the tunnel's host");

  // From the tunnel: loopback socket, Host rewritten, no proxy headers, no cookie.
  for (const [method, route] of ADMIN_ROUTES) {
    const res = await request(app, { method, path: route, headers: { Host: TUNNEL }, body: method === "GET" ? undefined : {} });
    assert.equal(res.status, 403, `${method} ${route}`);
    assert.equal(res.json().code, "ADMIN_LOCAL_ONLY");
  }

  // Even carrying a perfectly valid cookie (stolen, say), the Host is not ours.
  for (const [method, route] of ADMIN_ROUTES) {
    const res = await request(app, { method, path: route, headers: { Host: TUNNEL, Cookie: c }, body: method === "GET" ? undefined : {} });
    assert.equal(res.status, 403, `with a valid cookie: ${method} ${route}`);
  }
  // And the owner, on the real address, is fine.
  assert.equal((await request(app, { path: "/api/settings", headers: { Cookie: c } })).status, 200);
});

test("a tunnel cannot use a sign-in link either", async () => {
  const { app } = await up({ extraHosts: [TUNNEL] });
  const link = new URL(app.admin.link());
  const res = await request(app, { path: link.pathname + link.search, headers: { Host: TUNNEL } });
  assert.equal(res.headers["set-cookie"], undefined);
  const still = await request(app, { path: link.pathname + link.search });
  assert.ok(still.headers["set-cookie"], "and the code was not spent by the attempt");
});

test("proxy and tunnel headers are refused even on the right Host with a valid cookie", async () => {
  const { app, cookie } = await up();
  const c = await cookie();
  for (const header of [
    { "X-Forwarded-For": "203.0.113.9" }, { "X-Forwarded-Host": "evil.example" }, { "X-Forwarded-Proto": "https" },
    { Forwarded: "for=203.0.113.9" }, { Via: "1.1 tunnel" }, { "X-Real-IP": "203.0.113.9" },
    { "CF-Connecting-IP": "203.0.113.9" }, { "CF-Ray": "abc" }, { "True-Client-IP": "203.0.113.9" }
  ]) {
    const res = await request(app, { path: "/api/settings", headers: { Cookie: c, ...header } });
    assert.equal(res.status, 403, JSON.stringify(header));
    assert.equal(res.json().code, "PROXY_NOT_SUPPORTED", "refused for every route now, before the admin checks");
  }
});

test("a foreign Origin is refused even for a read, with a valid cookie", async () => {
  const { app, cookie } = await up();
  const c = await cookie();
  const res = await request(app, { path: "/api/settings", headers: { Cookie: c, Origin: "https://evil.example" } });
  assert.equal(res.status, 403);
});

// ── another computer ──────────────────────────────────────────────────

const lan = lanAddress();
test("a connection from another address is refused by the socket, however the headers read", { skip: lan ? false : "this computer has no non-loopback IPv4 address" }, async () => {
  const hosts = [];
  const { app, cookie } = await up({ host: "0.0.0.0", extraHosts: hosts });
  const c = await cookie();
  hosts.push(`${lan}:${app.port}`); // rooms answer on the LAN address, as a shared link would
  const room = await request(app, { path: "/api/config", host: lan, headers: { Host: `${lan}:${app.port}` } });
  assert.equal(room.status, 200, "reachable from the LAN address");

  for (const headers of [
    { Host: `${lan}:${app.port}`, Cookie: c },
    { Host: `127.0.0.1:${app.port}`, Cookie: c }, // a forged loopback Host with a valid cookie
    { Host: `localhost:${app.port}`, Cookie: c }
  ]) {
    for (const [method, route] of ADMIN_ROUTES) {
      const res = await request(app, { method, path: route, host: lan, headers, body: method === "GET" ? undefined : {} });
      assert.equal(res.status, 403, `${headers.Host} ${method} ${route}`);
      assert.equal(res.json().code, "ADMIN_LOCAL_ONLY");
    }
  }
  const link = new URL(app.admin.link());
  const exchange = await request(app, { path: link.pathname + link.search, host: lan, headers: { Host: `127.0.0.1:${app.port}` } });
  assert.equal(exchange.headers["set-cookie"], undefined, "a sign-in link does not work from another computer");
});

// ── settings ──────────────────────────────────────────────────────────

// What the page in the browser sends: the cookie, and its own Origin.
const api = (app, c) => (method, route, body) => request(app, { method, path: route, headers: { Cookie: c, Origin: app.url }, body });

test("saving a key: the view shows its last 4 characters and never the key; the file holds it, owner-only", async () => {
  const { app, cookie, dir } = await up();
  const call = api(app, await cookie());
  assert.equal((await call("PUT", "/api/settings", { provider: "groq" })).status, 200);
  const saved = await call("PUT", "/api/settings/key", { provider: "groq", key: KEY });
  assert.equal(saved.status, 200);
  assert.ok(!saved.text.includes(KEY), "the response to saving does not contain the key");
  const view = (await call("GET", "/api/settings")).json();
  assert.ok(!JSON.stringify(view).includes(KEY));
  const groq = view.providers.find((p) => p.id === "groq");
  assert.deepEqual([groq.key.present, groq.key.source, groq.key.last4], [true, "saved", KEY.slice(-4)]);
  assert.equal(view.configured, true);
  assert.equal(view.storage.kind, "sqlite");
  const file = path.join(dir, "settings.json");
  assert.ok(fs.readFileSync(file, "utf8").includes(KEY));
  if (process.platform !== "win32") assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
  assert.equal((await request(app, { path: "/api/status" })).json().configured, true);
});

test("a key that is not usable is refused in words, and the key is not echoed back in the refusal", async () => {
  const { app, cookie } = await up();
  const call = api(app, await cookie());
  const spaced = await call("PUT", "/api/settings/key", { provider: "groq", key: "two words in here" });
  assert.equal(spaced.status, 400);
  assert.match(spaced.json().error, /no spaces/);
  assert.ok(!spaced.text.includes("two words in here"));
  assert.equal((await call("PUT", "/api/settings/key", { provider: "groq", key: "" })).status, 400);
  assert.equal((await call("PUT", "/api/settings/key", { provider: "nope", key: KEY })).status, 400);
  assert.equal((await call("PUT", "/api/settings", { provider: "compat", base_url: "http://example.com/v1" })).json().code, "BAD_URL");
});

test("the environment overriding a saved setting is reported by variable name, never by value", async () => {
  const { app, cookie } = await up({ env: { GROQ_API_KEY: "gsk_env_value_that_overrides_0001", PROVIDER: "groq" } });
  const call = api(app, await cookie());
  await call("PUT", "/api/settings/key", { provider: "groq", key: KEY });
  const res = await call("GET", "/api/settings");
  const view = res.json();
  assert.deepEqual(view.provider_override, { field: "provider", variable: "PROVIDER" });
  const groq = view.providers.find((p) => p.id === "groq");
  assert.deepEqual(groq.overrides, [{ field: "key", variable: "GROQ_API_KEY" }]);
  assert.equal(groq.key.source, "env");
  assert.equal(groq.key.last4, "0001");
  assert.ok(!res.text.includes("gsk_env_value_that_overrides_0001") && !res.text.includes(KEY));
});

test("deleting the saved key needs the typed phrase, and an environment key is left alone", async () => {
  const { app, cookie, settings } = await up({ env: { GEMINI_API_KEY: "AIzaSy_env_key_stays_9999" } });
  const call = api(app, await cookie());
  await call("PUT", "/api/settings/key", { provider: "groq", key: KEY });
  for (const confirm of [undefined, "", "delete", "DELETE KEY", "delete key please"]) {
    const res = await call("DELETE", "/api/settings/key", { provider: "groq", confirm });
    assert.equal(res.status, 400, `confirm ${JSON.stringify(confirm)}`);
    assert.equal(res.json().code, "CONFIRM_MISMATCH");
  }
  assert.equal(settings.apiKey("groq"), KEY, "nothing was deleted by a wrong phrase");
  const done = await call("DELETE", "/api/settings/key", { provider: "groq", confirm: "delete key" });
  assert.equal(done.status, 200);
  assert.equal(done.json().removed, true);
  assert.equal(settings.apiKey("groq"), null);
  assert.ok(!fs.readFileSync(path.join(path.dirname(settings.file), "settings.json"), "utf8").includes(KEY), "gone from the file");
  const env = await call("DELETE", "/api/settings/key", { provider: "gemini", confirm: "delete key" });
  assert.equal(env.json().removed, false);
  assert.equal(settings.apiKey("gemini"), "AIzaSy_env_key_stays_9999");
});

test("the address check says exactly where the key would go", async () => {
  const { app, cookie } = await up();
  const call = api(app, await cookie());
  assert.deepEqual((await call("POST", "/api/settings/base-url/check", { base_url: "https://api.example.com/v1" })).json(), { ok: true, display: "api.example.com (https, port 443)", host: "api.example.com", local: false });
  assert.equal((await call("POST", "/api/settings/base-url/check", { base_url: "http://api.example.com/v1" })).json().ok, false);
});

// ── first run to first reply ──────────────────────────────────────────

test("first run to first reply: no key refuses a room; a tested and saved key lets one start and get its answer", async () => {
  const provider = await startFakeProvider(ok("Here is your plan."));
  closers.push(() => provider.close());
  const { app, cookie, store } = await up();
  const call = api(app, await cookie());
  const start = () => request(app, { method: "POST", path: "/api/tools/create_session", body: { task: "Plan a trip", creator_name: "Abhi", auto_start: true } });

  const refused = await start();
  assert.equal(refused.status, 409);
  assert.equal(refused.json().code, "NO_KEY");
  assert.deepEqual(await store.listSessions(), [], "no room was left behind");
  assert.equal((await request(app, { path: "/api/status" })).json().configured, false);

  const tested = await call("POST", "/api/settings/key/test", { provider: "compat", key: KEY, base_url: provider.base, model: "m1" });
  assert.deepEqual(tested.json(), { ok: true, model: "m1" });
  assert.equal((await call("PUT", "/api/settings", { provider: "compat", base_url: provider.base, model: "m1" })).status, 200);
  assert.equal((await call("PUT", "/api/settings/key", { provider: "compat", key: KEY })).status, 200);
  assert.equal((await request(app, { path: "/api/status" })).json().configured, true);

  const started = await start();
  assert.equal(started.status, 200);
  const id = started.json().session_id;
  const end = Date.now() + 5000;
  let reply;
  while (!reply && Date.now() < end) {
    reply = (await store.listEvents(id)).find((e) => e.kind === "agent_message");
    if (!reply) await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(reply?.content, "Here is your plan.");
  assert.equal(provider.requests.at(-1).headers.authorization, `Bearer ${KEY}`, "the saved key is the one the reply used");
});

// ── export and delete ─────────────────────────────────────────────────

async function populated(up_) {
  const b = await up_();
  const call = api(b.app, await b.cookie());
  const make = async (task, name) =>
    (await request(b.app, { method: "POST", path: "/api/tools/create_session", body: { task, creator_name: name } })).json();
  const room = await make("Plan the launch", "Maya");
  const joined = await request(b.app, { method: "POST", path: "/api/tools/join_session", body: { session_id: room.session_id, name: "Dana" } });
  await request(b.app, { method: "POST", path: "/api/tools/send_comment", body: { session_id: room.session_id, token: joined.json().token, content: "Nice start." } });
  await make("A second room", "Zoe");
  return { ...b, call, room, dana: joined.json() };
}

test("export holds rooms, events, and names with roles, and no token hash, token, expiry, last-seen time or key", async () => {
  const { app, call, room, dana, settings } = await populated(() => up());
  await call("PUT", "/api/settings/key", { provider: "groq", key: KEY });
  const res = await call("POST", "/api/data/export");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-disposition"], /^attachment; filename="multiplayer-ai-export-\d{4}-\d\d-\d\d\.json"$/);
  const data = JSON.parse(res.text);
  assert.equal(data.format, "multiplayer-ai-export");
  assert.equal(data.rooms.length, 2);
  const first = data.rooms.find((r) => r.id === room.session_id);
  assert.deepEqual(first.participants.map((p) => [p.name, p.role]).sort(), [["Dana", "watcher"], ["Maya", "controller"]]);
  assert.ok(first.events.some((e) => e.kind === "comment" && e.content === "Nice start."));
  assert.ok(first.events.some((e) => e.kind === "directive" && e.content === "Plan the launch"));
  assert.deepEqual(Object.keys(first.participants[0]).sort(), ["name", "role"]);
  const hashes = [room.token, dana.token].map((t) => crypto.createHash("sha256").update(t).digest("hex"));
  for (const secret of [room.token, dana.token, ...hashes, KEY, "token_hash", "token_expires", "last_seen", "settings"]) {
    assert.ok(!res.text.includes(secret), `the export must not contain ${secret.slice(0, 12)}`);
  }
  void app; void settings;
});

test("export needs the sign-in like everything else, and writes nothing", async () => {
  const { app, store } = await populated(() => up());
  const before = (await store.listSessions()).length;
  assert.equal((await request(app, { method: "POST", path: "/api/data/export" })).status, 401);
  assert.equal((await store.listSessions()).length, before);
});

test("deleting rooms needs the exact phrase, and a wrong one deletes nothing", async () => {
  const { call, store } = await populated(() => up());
  for (const confirm of [undefined, "", "delete", "delete all", "DELETE ALL ROOMS", "delete key"]) {
    const res = await call("POST", "/api/data/delete-rooms", { confirm });
    assert.equal(res.status, 400, JSON.stringify(confirm));
    assert.equal(res.json().code, "CONFIRM_MISMATCH");
  }
  assert.equal((await store.listSessions()).length, 2);
});

test("deleting rooms is refused while an agent is mid-reply, and works once it has finished", async () => {
  const { call, store } = await populated(() => up());
  const [first] = await store.listSessions();
  await store.updateSession(first.id, { agent_working: true });
  const busy = await call("POST", "/api/data/delete-rooms", { confirm: "delete all rooms" });
  assert.equal(busy.status, 409);
  assert.equal(busy.json().code, "AGENT_WORKING");
  assert.match(busy.json().error, /Wait for it to finish/);
  assert.equal((await store.listSessions()).length, 2);
  await store.updateSession(first.id, { agent_working: false });
  const done = await call("POST", "/api/data/delete-rooms", { confirm: "delete all rooms" });
  assert.equal(done.status, 200);
  assert.equal(done.json().deleted_rooms, 2);
  assert.deepEqual(await store.listSessions(), []);
});

test("deleting rooms removes the backups, leaves the saved key alone, and leaves no trace of the rooms in the data file", async () => {
  const { call, store, settings } = await populated(() => up());
  await call("PUT", "/api/settings/key", { provider: "groq", key: KEY });
  const marker = "ROOM-TEXT-" + "z5k1".repeat(6);
  const [room] = await store.listSessions();
  for (let i = 0; i < 10; i++) await store.insertEvent({ session_id: room.id, kind: "comment", author: "Maya", content: `${marker} ${i}` });
  const dir = path.dirname(store.file);
  const backup = path.join(dir, "multiplayer-ai.db.bak-v1-20260101T000000Z");
  fs.writeFileSync(backup, `an old copy with ${marker} in it`);
  const res = await call("POST", "/api/data/delete-rooms", { confirm: "delete all rooms" });
  assert.deepEqual(res.json(), { deleted_rooms: 2, removed_backups: 1 });
  assert.ok(!fs.existsSync(backup));
  for (const f of fs.readdirSync(dir).filter((n) => n.startsWith("multiplayer-ai.db"))) {
    assert.ok(!fs.readFileSync(path.join(dir, f)).includes(marker), `${f} still holds the text of a deleted room`);
  }
  assert.equal(settings.apiKey("groq"), KEY, "deleting rooms is not deleting the key");
});

test("after the rooms are deleted, a token from one of them is refused and a new room can be started", async () => {
  const { app, call, room, store } = await populated(() => up());
  await call("PUT", "/api/settings/key", { provider: "groq", key: KEY });
  await call("POST", "/api/data/delete-rooms", { confirm: "delete all rooms" });
  const stale = await request(app, { method: "POST", path: "/api/tools/get_session", body: { session_id: room.session_id, token: room.token } });
  assert.equal(stale.status, 401);
  const fresh = await request(app, { method: "POST", path: "/api/tools/create_session", body: { task: "again", creator_name: "Maya" } });
  assert.equal(fresh.status, 200);
  assert.equal((await store.listSessions()).length, 1);
});

test("the data folder is reported without anything secret in it", async () => {
  const { call, dir } = await populated(() => up());
  const view = (await call("GET", "/api/settings")).json();
  assert.equal(view.storage.folder, dir);
  assert.equal(view.file, path.join(dir, "settings.json"));
  void tempDir;
});


// ── the cookie is sent to other ports of the same host; it must not be usable from them ──

const STATE_CHANGING = ["POST", "PUT", "DELETE", "PATCH"];
const settingsFileOf = (dir) => path.join(dir, "settings.json");
const snapshot = (dir) => (fs.existsSync(settingsFileOf(dir)) ? fs.readFileSync(settingsFileOf(dir), "utf8") : null);

test("a valid cookie with an Origin from another localhost port is refused on every settings, key and data route", async () => {
  const { app, cookie, store, dir, settings } = await populated(() => up());
  settings.saveKey("groq", KEY);
  const c = await cookie();
  const before = snapshot(dir);
  const rooms = (await store.listSessions()).length;
  for (const origin of [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://localhost",
    `http://localhost:${app.port + 1}`,
    `http://127.0.0.1:${app.port + 1}`,
    "http://[::1]:5173"
  ]) {
    for (const [method, route] of ADMIN_ROUTES) {
      const res = await request(app, { method, path: route, headers: { Cookie: c, Origin: origin }, body: method === "GET" ? undefined : { provider: "groq", key: "x".repeat(12), confirm: "delete key" } });
      assert.equal(res.status, 403, `${origin} ${method} ${route}`);
      assert.equal(res.json().code, "BAD_ORIGIN");
    }
  }
  assert.equal(snapshot(dir), before, "the settings file was not touched");
  assert.equal((await store.listSessions()).length, rooms, "no room was deleted");
  assert.equal(settings.apiKey("groq"), KEY, "and the key is still there");
});

test("a valid cookie on a request the browser marks as from another site or port is refused, even for a read and even with no Origin", async () => {
  const { app, cookie } = await up();
  const c = await cookie();
  for (const site of ["same-site", "cross-site"]) {
    for (const [method, route] of ADMIN_ROUTES) {
      const res = await request(app, { method, path: route, headers: { Cookie: c, "Sec-Fetch-Site": site }, body: method === "GET" ? undefined : {} });
      assert.equal(res.status, 403, `${site} ${method} ${route}`);
    }
  }
  for (const site of ["same-origin", "none"]) {
    const res = await request(app, { path: "/api/settings", headers: { Cookie: c, "Sec-Fetch-Site": site } });
    assert.equal(res.status, 200, `a page of ours (${site}) is fine`);
  }
});

test("a valid cookie with no Origin header at all is refused for every state-changing method, and nothing happens", async () => {
  const { app, cookie, store, dir, settings } = await populated(() => up());
  settings.saveKey("groq", KEY);
  const c = await cookie();
  const before = snapshot(dir);
  const rooms = (await store.listSessions()).length;
  const targets = [...ADMIN_ROUTES.filter(([m]) => m !== "GET"), ["POST", "/api/settings/nothing-here"], ["PUT", "/api/data/export"]];
  for (const method of STATE_CHANGING) {
    for (const [, route] of targets) {
      const res = await request(app, { method, path: route, headers: { Cookie: c }, body: { provider: "groq", key: "y".repeat(12), confirm: "delete all rooms" } });
      assert.equal(res.status, 403, `${method} ${route} with no Origin`);
      assert.equal(res.json().code, "BAD_ORIGIN");
    }
  }
  assert.equal(snapshot(dir), before);
  assert.equal((await store.listSessions()).length, rooms);
  assert.equal(settings.apiKey("groq"), KEY);
  // The same requests from the page itself (its own Origin) are accepted.
  const fromPage = await request(app, { method: "POST", path: "/api/settings/base-url/check", headers: { Cookie: c, Origin: app.url }, body: { base_url: "https://api.example.com/v1" } });
  assert.equal(fromPage.status, 200);
  const alt = await request(app, { method: "POST", path: "/api/settings/base-url/check", headers: { Cookie: c, Origin: `http://localhost:${app.port}` }, body: { base_url: "https://api.example.com/v1" } });
  assert.equal(alt.status, 200, "and from the page opened as localhost");
});

test("a read with a valid cookie and no Origin is fine (a page opened it by typing the address), but the order of checks still answers 401 before 403 for someone with no cookie", async () => {
  const { app, cookie } = await up();
  assert.equal((await request(app, { path: "/api/settings", headers: { Cookie: await cookie() } })).status, 200);
  const noCookie = await request(app, { method: "POST", path: "/api/settings/key", body: {} });
  assert.equal(noCookie.status, 401);
});

// ── GET /api/settings shows the last 4 characters and nothing more of any key, in every case ──

// Every run of 5 characters in the key must be absent from what is sent back. The last four
// are allowed; the fifth from the end together with them is not.
const fiveGrams = (key) => Array.from({ length: Math.max(0, key.length - 4) }, (_, i) => key.slice(i, i + 5)).filter((g) => g.length === 5);
const assertOnlyLast4 = (text, key, label) => {
  for (const g of fiveGrams(key)) assert.ok(!text.includes(g), `${label}: the response contains "${g}" from a key`);
  assert.ok(!text.includes(key), `${label}: the whole key is in the response`);
};

const KEYS = {
  saved: "Kq7ZvT2LmN9xB4wDhR8sJ5c",
  env: "Xe3Wp6YuH1fG0aVzQ7oMiL9",
  other: "Rt5BnC8dJ2kS4hUy6EqOw1Z",
  compat: "Mv9LxA3cP7zD5gTn2KbY8Fe",
  eight: "Zr4Jm7Qs",
  short: "Hq5Tn",
  long: "Wd8Ev2Ft6Gy0Hu4Ji9Ko3Lp7Mq1Nr5Os~Pt!Qu#Rv$Sw%Tx^Uy&Vz"
};

test("GET /api/settings carries only the last 4 characters of a key in every case", async () => {
  const cases = [
    ["a saved key", {}, (s) => s.saveKey("groq", KEYS.saved), [KEYS.saved]],
    ["a key from the environment", { GEMINI_API_KEY: KEYS.env }, () => {}, [KEYS.env]],
    ["a saved key and a different environment key for the same provider", { GROQ_API_KEY: KEYS.env }, (s) => s.saveKey("groq", KEYS.saved), [KEYS.env, KEYS.saved]],
    ["keys for all three providers", { GEMINI_API_KEY: KEYS.env }, (s) => (s.saveKey("groq", KEYS.saved), s.saveKey("compat", KEYS.compat)), [KEYS.env, KEYS.saved, KEYS.compat]],
    ["a key of exactly 8 characters", {}, (s) => s.saveKey("groq", KEYS.eight), [KEYS.eight]],
    ["a key too short to show any of it", {}, (s) => s.saveKey("groq", KEYS.short), [KEYS.short]],
    ["a very long key with symbols", {}, (s) => s.saveKey("groq", KEYS.long), [KEYS.long]],
    ["a compatible provider with its key", { OPENAI_COMPAT_API_KEY: KEYS.compat, OPENAI_COMPAT_BASE_URL: "https://api.example.com/v1", OPENAI_COMPAT_MODEL: "m" }, () => {}, [KEYS.compat]]
  ];
  for (const [label, env, setUp, keys] of cases) {
    const { app, cookie, settings } = await up({ env });
    setUp(settings);
    const call = api(app, await cookie());
    const res = await call("GET", "/api/settings");
    assert.equal(res.status, 200, label);
    for (const k of keys) {
      assertOnlyLast4(res.text, k, label);
      if (k.length >= 8) assert.ok(res.text.includes(k.slice(-4)), `${label}: the last 4 characters of ${k.slice(0, 2)}… are shown`);
    }
    // Wherever a key appears, it is the last4 / saved_last4 field, four characters or null.
    const view = res.json();
    for (const p of view.providers) {
      for (const field of ["last4", "saved_last4"]) assert.ok(p.key[field] === null || (typeof p.key[field] === "string" && p.key[field].length === 4), `${label}: ${p.id}.${field}`);
    }
  }
});

test("a key that is too short to hide behind its last 4 characters shows none", async () => {
  const { app, cookie, settings } = await up();
  settings.saveKey("groq", KEYS.short);
  const view = (await api(app, await cookie())("GET", "/api/settings")).json();
  const groq = view.providers.find((p) => p.id === "groq");
  assert.deepEqual([groq.key.present, groq.key.last4, groq.key.saved_last4], [true, null, null]);
});

test("every other response that carries the settings, or fails while handling a key, holds no more of a key than its last 4 characters", async () => {
  const { app, cookie, settings } = await up({ env: { GEMINI_API_KEY: KEYS.env } });
  const call = api(app, await cookie());
  const responses = [];
  responses.push(await call("PUT", "/api/settings", { provider: "groq", model: "m" }));
  responses.push(await call("PUT", "/api/settings/key", { provider: "groq", key: KEYS.saved }));
  responses.push(await call("PUT", "/api/settings/key", { provider: "groq", key: KEYS.long + " with spaces" }));
  responses.push(await call("PUT", "/api/settings/key", { provider: "groq", key: "z".repeat(600) }));
  responses.push(await call("DELETE", "/api/settings/key", { provider: "groq", confirm: "wrong" }));
  responses.push(await call("GET", "/api/settings"));
  responses.push(await call("DELETE", "/api/settings/key", { provider: "groq", confirm: "delete key" }));
  responses.push(await call("POST", "/api/settings/key/test", { provider: "groq", key: KEYS.other, base_url: "x" }));
  responses.push(await call("POST", "/api/settings/base-url/check", { base_url: `https://user:${KEYS.compat}@api.example.com/v1` }));
  for (const [i, res] of responses.entries()) {
    for (const k of [KEYS.saved, KEYS.env, KEYS.long, KEYS.other, KEYS.compat]) assertOnlyLast4(res.text, k, `response ${i + 1} (${res.status})`);
  }
  void settings;
});
