// Run: node --test test/   (no network beyond this computer)
// Same Wi-Fi mode: a second listener on ONE chosen private address of this computer, Host and Origin
// checks that depend on which listener took the connection, no settings routes on it, and a listener that
// closes (and is never replaced by a wider one) if its address goes away. Uses this computer's real
// address, so a request to it arrives from a non-loopback source address, as a phone's would.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { boot, request, lanAddress, resetSettings } from "./helpers/http.js";
import { makeFakeSupabase } from "./fakeSupabase.js";
import { asStore } from "../store/index.js";
import { startHttp } from "../http.js";
import { cleanup } from "./helpers/stores.js";

const closers = [];
after(async () => {
  for (const c of closers.splice(0)) await c();
  resetSettings();
  await cleanup();
});
const lan = lanAddress();
const skip = lan ? false : "this computer has no non-loopback IPv4 address";
const up = async (options) => {
  const b = await boot(options);
  closers.push(() => b.app.close());
  return b;
};
const nic = (address, name = "en0") => ({ [name]: [{ address, family: "IPv4", internal: false }] });
const refusedConnection = (address, port) =>
  new Promise((resolve) => {
    const s = net.connect(port, address);
    s.once("connect", () => (s.destroy(), resolve(false)));
    s.once("error", (e) => resolve(e.code));
  });
const viaLan = (b, p, { headers = {}, ...rest } = {}) =>
  request(b.app, { path: p, host: lan, headers: { Host: `${lan}:${b.app.port}`, ...headers }, ...rest });

test("by default nothing listens on the network address, only on this computer", { skip }, async () => {
  const b = await up();
  assert.equal(b.app.server.address().address, "127.0.0.1");
  assert.equal(await refusedConnection(lan, b.app.port), "ECONNREFUSED");
  const status = b.app.sharing.status();
  assert.deepEqual([status.active, status.address, status.url], [false, null, null]);
  assert.ok(status.candidates.some((c) => c.address === lan), "and this computer's address is offered");
});

test("turning sharing on opens a second listener on exactly the chosen address and the same port; turning it off closes it", { skip }, async () => {
  const b = await up();
  await b.app.sharing.enable(lan);
  const status = b.app.sharing.status();
  assert.deepEqual([status.active, status.address, status.url], [true, lan, `http://${lan}:${b.app.port}`]);
  assert.equal(b.app.sharing.listener.address().address, lan, "bound to that address, not to every interface");
  assert.equal(b.app.sharing.listener.address().port, b.app.port);
  assert.equal((await viaLan(b, "/api/config")).status, 200);
  assert.equal((await request(b.app, { path: "/api/config" })).status, 200, "this computer still works");
  await b.app.sharing.disable();
  assert.equal(b.app.sharing.status().active, false);
  assert.equal(await refusedConnection(lan, b.app.port), "ECONNREFUSED");
  assert.equal((await request(b.app, { path: "/api/config" })).status, 200);
});

test("only an address this computer really has, in a private range, can be chosen; everything else is refused and nothing is opened", { skip }, async () => {
  const b = await up();
  for (const bad of ["0.0.0.0", "::", "::1", "127.0.0.1", "localhost", "8.8.8.8", "203.0.113.5", "10.254.254.254", "", undefined, null, 42, { a: 1 }, `${lan} `, `${lan}:3737`, "*"]) {
    await assert.rejects(b.app.sharing.enable(bad), (e) => e.code === "BAD_ADDRESS" && e.status === 400, JSON.stringify(bad));
    assert.equal(b.app.sharing.status().active, false);
    assert.equal(b.app.sharing.listener, null);
  }
  assert.equal(await refusedConnection(lan, b.app.port), "ECONNREFUSED");
});

test("an address in an unusual range needs a deliberate yes; it is not accepted by default", async () => {
  const b = await up({ interfaces: () => ({ ...nic("192.168.1.9"), eth1: [{ address: "169.254.7.7", family: "IPv4", internal: false }], utun3: [{ address: "100.100.1.2", family: "IPv4", internal: false }] }) });
  for (const odd of ["169.254.7.7", "100.100.1.2"]) {
    await assert.rejects(b.app.sharing.enable(odd), (e) => e.code === "ADDRESS_UNUSUAL" && e.status === 409 && e.message.length > 40, odd);
    assert.equal(b.app.sharing.status().active, false);
  }
});

test("if the address can't be bound (it is not on this computer after all), it says so and opens nothing", async () => {
  const b = await up({ interfaces: () => nic("192.168.77.77") });
  await assert.rejects(b.app.sharing.enable("192.168.77.77"), (e) => e.code === "ADDRESS_GONE" && e.status === 409);
  assert.equal(b.app.sharing.status().active, false);
  assert.equal(b.app.sharing.listener, null);
});

test("if the port is already taken on that address, it says so, opens nothing, and does not pick another port", { skip }, async () => {
  const b = await up();
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(b.app.port, lan, r));
  closers.push(() => new Promise((r) => blocker.close(r)));
  await assert.rejects(b.app.sharing.enable(lan), (e) => e.code === "PORT_BUSY_ON_ADDRESS" && e.status === 409);
  assert.equal(b.app.sharing.status().active, false);
});

test("sharing can't be turned on twice", { skip }, async () => {
  const b = await up();
  await b.app.sharing.enable(lan);
  await assert.rejects(b.app.sharing.enable(lan), (e) => e.code === "ALREADY_SHARING");
});

test("with Supabase storage sharing is refused with a plain message", async () => {
  const store = asStore(makeFakeSupabase({ sessions: [], session_events: [], session_participants: [] }));
  const app = await startHttp({ store, profile: "local", env: {}, port: 0, log: () => {} });
  closers.push(() => app.close());
  await assert.rejects(app.sharing.enable("192.168.1.9"), (e) => e.code === "SHARING_UNAVAILABLE" && /local data file/.test(e.message) && /Supabase/.test(e.message));
  assert.equal(app.sharing.status().available, false);
});

// ── who is let in, by listener ───────────────────────────────────────

test("on the network address only that address is accepted as Host; localhost, 127.0.0.1, other names and a rebound domain are refused", { skip }, async () => {
  const b = await up();
  await b.app.sharing.enable(lan);
  const port = b.app.port;
  assert.equal((await viaLan(b, "/api/config")).status, 200);
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `evil.example:${port}`, `rebind.attacker.example:${port}`, `${lan}`, `${lan}:${port + 1}`, `0.0.0.0:${port}`, `${lan}.evil.example:${port}`]) {
    const res = await viaLan(b, "/api/config", { headers: { Host: host } });
    assert.equal(res.status, 403, `Host ${host}`);
    assert.equal(res.json().code, "BAD_HOST");
  }
});

test("on this computer's own listener the network address is not accepted as Host", { skip }, async () => {
  const b = await up();
  await b.app.sharing.enable(lan);
  const res = await request(b.app, { path: "/api/config", headers: { Host: `${lan}:${b.app.port}` } });
  assert.equal(res.status, 403);
});

test("on the network address a change must carry that address as its Origin; another origin, localhost and 'null' are refused", { skip }, async () => {
  const b = await up();
  await b.app.sharing.enable(lan);
  const post = (origin) => viaLan(b, "/api/tools/get_session", { method: "POST", headers: origin === undefined ? {} : { Origin: origin }, body: {} });
  for (const origin of [`http://localhost:${b.app.port}`, `http://127.0.0.1:${b.app.port}`, "https://evil.example", "http://evil.example", "null"]) {
    const res = await post(origin);
    assert.equal(res.status, 403, origin);
    assert.equal(res.json().code, "BAD_ORIGIN");
  }
  assert.notEqual((await post(`http://${lan}:${b.app.port}`)).json().code, "BAD_ORIGIN", "its own origin gets past the origin check");
  const sameSite = await viaLan(b, "/api/tools/get_session", { method: "POST", headers: { Origin: `http://${lan}:${b.app.port}`, "Sec-Fetch-Site": "cross-site" }, body: {} });
  assert.equal(sameSite.status, 403);
});

test("no response from the network address carries a CORS header, and a preflight is never approved", { skip }, async () => {
  const b = await up();
  await b.app.sharing.enable(lan);
  const origin = `http://${lan}:${b.app.port}`;
  const responses = [
    await viaLan(b, "/api/config", { headers: { Origin: "https://evil.example" } }),
    await viaLan(b, "/api/tools/get_session", { method: "POST", headers: { Origin: "https://evil.example" }, body: {} }),
    await viaLan(b, "/api/tools/get_session", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } }),
    await viaLan(b, "/api/tools/get_session", { method: "OPTIONS", headers: { Origin: origin } })
  ];
  for (const r of responses) assert.deepEqual(Object.keys(r.headers).filter((h) => h.startsWith("access-control-")), []);
  assert.equal(responses[2].status, 403);
  assert.equal(responses[3].status, 405);
});

// ── the settings routes do not exist on the network address ───────────

const ADMIN_PATHS = [
  ["GET", "/api/settings"], ["PUT", "/api/settings"], ["PUT", "/api/settings/key"], ["DELETE", "/api/settings/key"],
  ["POST", "/api/settings/key/test"], ["POST", "/api/settings/base-url/check"], ["POST", "/api/data/export"], ["POST", "/api/data/delete-rooms"],
  ["GET", "/api/host/sharing"], ["PUT", "/api/host/sharing"], ["GET", "/api/host/rooms/11111111-2222-4333-8444-555555555555"]
];

test("a client on the network address with the room link, the right Host, Origin and every header, and even the host's cookie, finds no settings, key, export, delete or host route", { skip }, async () => {
  const b = await up();
  await b.app.sharing.enable(lan);
  const cookie = await b.cookie(); // the host's cookie, obtained on this computer, as if it had leaked
  const origin = `http://${lan}:${b.app.port}`;
  for (const [method, p] of ADMIN_PATHS) {
    const res = await viaLan(b, p, {
      method,
      headers: { Cookie: cookie, Origin: origin, "Sec-Fetch-Site": "same-origin", Accept: "application/json" },
      body: method === "GET" ? undefined : { confirm: "delete all rooms", provider: "groq", key: "x".repeat(12) }
    });
    assert.equal(res.status, 404, `${method} ${p}`);
    assert.equal(res.json().code, "NOT_FOUND");
  }
});

test("the sign-in link does not work on the network address, and trying it there does not spend the code", { skip }, async () => {
  const b = await up();
  await b.app.sharing.enable(lan);
  const link = new URL(b.app.admin.link());
  const code = link.pathname + link.search;
  const viaNet = await viaLan(b, code);
  assert.equal(viaNet.status, 404);
  assert.equal(viaNet.headers["set-cookie"], undefined);
  const here = await request(b.app, { path: code });
  assert.ok(here.headers["set-cookie"], "and it still works on this computer");
});

// ── proxies and tunnels are not supported: refused on every route ─────

const PROXY_HEADERS = [
  { "X-Forwarded-For": "203.0.113.9" }, { "X-Forwarded-Host": "evil.example" }, { "X-Forwarded-Proto": "https" }, { Forwarded: "for=203.0.113.9" },
  { Via: "1.1 tunnel" }, { "X-Real-IP": "203.0.113.9" }, { "CF-Connecting-IP": "203.0.113.9" }, { "CF-Ray": "abc" }, { "True-Client-IP": "203.0.113.9" }
];
const EVERY_ROUTE = [
  ["GET", "/"], ["GET", "/new"], ["GET", "/s/11111111-2222-4333-8444-555555555555/join"], ["GET", "/assets/index.js"], ["GET", "/signin-expired"], ["GET", "/?admin=whatever"],
  ["GET", "/rooms"], ["GET", "/api/config"], ["GET", "/api/status"], ["GET", "/api/stream/11111111-2222-4333-8444-555555555555"], ["GET", "/api/nope"],
  ["POST", "/api/tools/create_session"], ["POST", "/api/tools/join_session"], ["POST", "/api/tools/get_session"], ["POST", "/api/tools/send_directive"],
  ["POST", "/api/tools/send_comment"], ["POST", "/api/tools/take_control"], ["POST", "/api/tools/heartbeat"], ["POST", "/api/tools/leave_session"],
  ["POST", "/api/tools/step_agent"], ["POST", "/api/tools/set_status"], ["OPTIONS", "/api/tools/create_session"],
  ...ADMIN_PATHS
];

test("every route that exists is on the list of routes tested for proxy and tunnel headers", async () => {
  const b = await up();
  const registered = b.app.routes(); // [{ method, path }] for every route and mounted prefix
  const listed = new Set(EVERY_ROUTE.map(([m, p]) => `${m} ${p.replace(/[0-9a-f-]{36}/g, ":id").split("?")[0]}`));
  const wildcard = (path) => path === "*" || path === "/api" || path.startsWith("/rooms") || path.startsWith("/api/host") || path.startsWith("/api/settings") || path.startsWith("/api/data");
  for (const r of registered) {
    if (wildcard(r.path)) continue;
    const key = `${r.method.toUpperCase()} ${r.path.replace(/:[a-z_]+/g, (m) => (m === ":name" ? "" : m)).replace("/api/tools/:name", "/api/tools/create_session")}`;
    const covered = [...listed].some((l) => l === key || (r.path.includes(":name") && l.startsWith(`${r.method.toUpperCase()} /api/tools/`)) || r.path === "/api/stream/:session_id" && l.includes("/api/stream/"));
    assert.ok(covered, `${r.method} ${r.path} is registered but not in EVERY_ROUTE: add it so it is tested for proxy headers`);
  }
});

test("a request with a foreign Host and proxy headers arriving on this computer's listener is refused on every route", async () => {
  const b = await up({ extraHosts: [] });
  const cookie = await b.cookie();
  for (const proxy of PROXY_HEADERS) {
    for (const [method, p] of EVERY_ROUTE) {
      const res = await request(b.app, {
        method, path: p, headers: { Host: "abc123.tunnel.example", Cookie: cookie, Origin: "https://abc123.tunnel.example", ...proxy },
        body: method === "GET" || method === "OPTIONS" ? undefined : {}
      });
      assert.ok([403, 405].includes(res.status) && res.status === 403, `${method} ${p} with ${Object.keys(proxy)[0]}: got ${res.status}`);
    }
  }
});

test("proxy and tunnel headers are refused on every route even when the Host is right, so a tunnel that rewrites it still gets nothing", async () => {
  const b = await up();
  const cookie = await b.cookie();
  for (const proxy of PROXY_HEADERS) {
    for (const [method, p] of EVERY_ROUTE) {
      const res = await request(b.app, {
        method, path: p, headers: { Cookie: cookie, Origin: b.app.url, "Sec-Fetch-Site": "same-origin", ...proxy },
        body: method === "GET" || method === "OPTIONS" ? undefined : {}
      });
      assert.equal(res.status, 403, `${method} ${p} with ${Object.keys(proxy)[0]}`);
      assert.equal(res.json().code, "PROXY_NOT_SUPPORTED", `${method} ${p}`);
      assert.match(res.json().error, /proxy or tunnel/);
    }
  }
});

test("the same holds on the network address", { skip }, async () => {
  const b = await up();
  await b.app.sharing.enable(lan);
  for (const proxy of PROXY_HEADERS) {
    for (const [method, p] of EVERY_ROUTE.filter(([, p]) => !p.startsWith("/api/settings") && !p.startsWith("/api/data") && !p.startsWith("/api/host") && !p.includes("admin"))) {
      const res = await viaLan(b, p, { method, headers: { Origin: `http://${lan}:${b.app.port}`, ...proxy }, body: method === "GET" || method === "OPTIONS" ? undefined : {} });
      assert.equal(res.status, 403, `${method} ${p}`);
    }
  }
});

// ── the address goes away ────────────────────────────────────────────

const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("if the chosen address disappears, the second listener closes, the host is told, and it never falls back to a wider one", { skip }, async () => {
  let present = true;
  const lines = [];
  const b = await up({ interfaces: () => (present ? nic(lan) : { lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }] }), watchMs: 30, log: (l) => lines.push(l) });
  await b.app.sharing.enable(lan);
  assert.equal((await viaLan(b, "/api/config")).status, 200);
  present = false;
  await until(() => !b.app.sharing.status().active);
  const status = b.app.sharing.status();
  assert.match(status.notice, new RegExp(lan.replace(/\./g, "\\.")));
  assert.match(status.notice, /went away|no longer/);
  assert.match(lines.join("\n"), /sharing was turned off/);
  assert.equal(b.app.sharing.listener, null);
  assert.equal(await refusedConnection(lan, b.app.port), "ECONNREFUSED", "nothing answers on that address");
  assert.equal(await refusedConnection("127.0.0.1", b.app.port), false, "this computer's own listener is untouched");
  const listening = await new Promise((r) => b.app.server.listening ? r(b.app.server.address().address) : r(null));
  assert.equal(listening, "127.0.0.1", "and still only on this computer");
});

test("if the address changes (a new one appears where the old one was), sharing is turned off, not moved", { skip }, async () => {
  let current = lan;
  const b = await up({ interfaces: () => nic(current), watchMs: 30 });
  await b.app.sharing.enable(lan);
  current = "192.168.200.200";
  await until(() => !b.app.sharing.status().active);
  assert.equal(await refusedConnection(lan, b.app.port), "ECONNREFUSED", "the old address is closed");
  assert.equal(b.app.sharing.listener, null, "and no listener was made for the new address (it would not be this computer's anyway)");
  assert.equal(b.app.sharing.status().address, null);
  assert.match(b.app.sharing.status().notice, /Turn sharing on again/);
});

test("turning sharing off ends connections already open on it", { skip }, async () => {
  const b = await up();
  await b.app.sharing.enable(lan);
  const socket = net.connect(b.app.port, lan);
  socket.on("error", () => {}); // being cut off is the point; the reset is expected
  await new Promise((r) => socket.once("connect", r));
  socket.write(`GET /api/stream/x HTTP/1.1\r\nHost: ${lan}:${b.app.port}\r\n`); // an unfinished request, as a held-open stream would be
  const closed = new Promise((r) => socket.once("close", r));
  await b.app.sharing.disable();
  await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("connection was not closed")), 3000))]);
});

test("a notice about a closed listener is cleared when sharing is turned on again", { skip }, async () => {
  let present = true;
  const b = await up({ interfaces: () => (present ? nic(lan) : {}), watchMs: 30 });
  await b.app.sharing.enable(lan);
  present = false;
  await until(() => b.app.sharing.status().notice);
  present = true;
  await b.app.sharing.enable(lan);
  assert.equal(b.app.sharing.status().notice, null);
});
