// Run: node --test test/   (no network beyond this computer)
// MULTIPLAYER_AI_CONTAINER, and what changes inside a container: Multiplayer AI listens on every
// interface (so Docker can publish the port) and can no longer ask the socket whether a
// request comes from this computer, so the sign-in code and cookie become the whole proof.
// Nothing about that is allowed to happen on an ordinary computer.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { detectContainer, containerMode } from "../container.js";
import { listenHostFor, startHttp } from "../http.js";
import { createAdminAuth } from "../admin.js";
import { start } from "../local.js";
import { boot, request, lanAddress, resetSettings } from "./helpers/http.js";
import { cleanup, tempDir } from "./helpers/stores.js";

const closers = [];
after(async () => {
  for (const c of closers.splice(0)) await c();
  resetSettings();
  await cleanup();
});

// ── is this really a container? ──────────────────────────────────────

test("a Linux process is in a container when Docker or Podman left their marker, the cgroup names one, or `container` is set", () => {
  const none = { platform: "linux", exists: () => false, read: () => { throw new Error("ENOENT"); }, env: {} };
  assert.equal(detectContainer(none), false);
  assert.equal(detectContainer({ ...none, exists: (p) => p === "/.dockerenv" }), true);
  assert.equal(detectContainer({ ...none, exists: (p) => p === "/run/.containerenv" }), true);
  assert.equal(detectContainer({ ...none, read: () => "12:cpu:/docker/abc123" }), true);
  assert.equal(detectContainer({ ...none, read: () => "0::/kubepods/besteffort/pod1" }), true);
  assert.equal(detectContainer({ ...none, read: () => "0::/user.slice/user-1000.slice" }), false);
  assert.equal(detectContainer({ ...none, env: { container: "podman" } }), true);
});

test("on macOS and Windows nothing counts as a container, whatever files or variables exist", () => {
  for (const platform of ["darwin", "win32"]) {
    assert.equal(detectContainer({ platform, exists: () => true, read: () => "docker", env: { container: "docker" } }), false);
  }
});

test("MULTIPLAYER_AI_CONTAINER=1 turns container mode on only inside a container", () => {
  const inside = () => true;
  const outside = () => false;
  assert.deepEqual(containerMode({ MULTIPLAYER_AI_CONTAINER: "1" }, inside), { on: true, ignored: false });
  assert.deepEqual(containerMode({ MULTIPLAYER_AI_CONTAINER: "1" }, outside), { on: false, ignored: true });
  for (const unset of [{}, { MULTIPLAYER_AI_CONTAINER: "" }, { MULTIPLAYER_AI_CONTAINER: "0" }, { MULTIPLAYER_AI_CONTAINER: "true" }, { MULTIPLAYER_AI_CONTAINER: "yes" }]) {
    assert.deepEqual(containerMode(unset, inside), { on: false, ignored: false }, JSON.stringify(unset));
  }
});

test("on this computer MULTIPLAYER_AI_CONTAINER=1 is ignored, with a warning, and Multiplayer AI still listens on this computer only", async () => {
  const lines = [];
  const env = { MULTIPLAYER_AI_CONTAINER: "1", MULTIPLAYER_AI_NO_DOTENV: "1", MULTIPLAYER_AI_DATA_DIR: path.join(tempDir(), "d") };
  const app = await start({ env, port: 0, log: (l) => lines.push(l), detectContainer: () => false }); // stand-in: this test may itself run inside a container
  closers.push(async () => (await app.close(), await app.store.close()));
  assert.equal(app.container, false);
  assert.equal(app.server.address().address, "127.0.0.1");
  assert.match(lines.join("\n"), /MULTIPLAYER_AI_CONTAINER is set, but this does not look like a container, so it is ignored/);
  resetSettings();
});

test("which address is listened on: this computer only, unless a container, unless told", () => {
  assert.equal(listenHostFor({ local: true }), "127.0.0.1");
  assert.equal(listenHostFor({ local: true, container: true }), "0.0.0.0");
  assert.equal(listenHostFor({ local: true, container: true, host: "10.0.0.5" }), "10.0.0.5");
  assert.equal(listenHostFor({ local: false }), undefined);
});

// ── in container mode the sign-in is mandatory and everything fails closed ──

const ROUTES = [
  ["GET", "/api/settings"], ["PUT", "/api/settings"], ["PUT", "/api/settings/key"], ["DELETE", "/api/settings/key"],
  ["POST", "/api/settings/key/test"], ["POST", "/api/settings/base-url/check"], ["POST", "/api/data/export"], ["POST", "/api/data/delete-rooms"]
];
const lan = lanAddress();

async function inContainer(options = {}) {
  const b = await boot({ container: true, host: lan ? "0.0.0.0" : "127.0.0.1", ...options });
  closers.push(() => b.app.close());
  return b;
}
// The request a browser on the host sends through Docker: the right Host, the right Origin, the usual headers.
const fromHost = (b, { method = "GET", path: p = "/api/settings", headers = {}, body, origin = `http://localhost:${b.app.port}` } = {}) =>
  request(b.app, {
    method, path: p, host: lan ?? "127.0.0.1",
    headers: { Host: `localhost:${b.app.port}`, ...(method === "GET" || origin === null ? {} : { Origin: origin }), "Sec-Fetch-Site": "same-origin", ...headers },
    body: method === "GET" ? undefined : body ?? {}
  });

test("container mode: correct Host, Origin and headers but no cookie is refused on every settings, key and data route", async () => {
  const b = await inContainer();
  for (const [method, p] of ROUTES) {
    const res = await fromHost(b, { method, path: p });
    assert.equal(res.status, 401, `${method} ${p}`);
    assert.equal(res.json().code, "ADMIN_LINK_NEEDED");
  }
});

test("container mode: a source that is not this computer is let in by the cookie, and only by the cookie", { skip: lan ? false : "no non-loopback IPv4 address on this computer" }, async () => {
  const b = await inContainer();
  const cookie = await b.cookie(); // signed in the way the printed link does it
  assert.equal((await fromHost(b, { headers: { Cookie: cookie } })).status, 200, "with the cookie, from a non-loopback address (as Docker's gateway looks)");
  assert.equal((await fromHost(b, {})).status, 401, "the same request without it");
});

test("container mode: the cookie alone is not enough; Host, Origin and proxy headers are still enforced", async () => {
  const b = await inContainer({ extraHosts: ["abc.tunnel.example"] });
  const cookie = await b.cookie();
  const check = async (headers, expected, label) => assert.equal((await fromHost(b, { headers: { Cookie: cookie, ...headers } })).status, expected, label);
  await check({}, 200, "baseline");
  await check({ Host: "abc.tunnel.example" }, 403, "a tunnel's Host");
  await check({ Host: `evil.example:${b.app.port}` }, 403, "a foreign Host");
  await check({ Origin: "https://evil.example" }, 403, "a foreign Origin");
  await check({ Origin: "http://localhost:5173" }, 403, "another localhost port");
  await check({ "X-Forwarded-For": "203.0.113.9" }, 403, "a proxy header");
  await check({ "Sec-Fetch-Site": "same-site" }, 403, "a request marked same-site");
  const noOrigin = await fromHost(b, { method: "POST", path: "/api/settings/base-url/check", origin: null, headers: { Cookie: cookie } });
  assert.equal(noOrigin.status, 403, "a change with no Origin, even with the cookie");
  const withOrigin = await fromHost(b, { method: "POST", path: "/api/settings/base-url/check", headers: { Cookie: cookie }, body: { base_url: "https://api.example.com/v1" } });
  assert.equal(withOrigin.status, 200);
});

test("container mode: with no code ever issued there is no way in at all", async () => {
  const b = await inContainer();
  b.app.admin.auth.revokeAll(); // nothing issued, nothing outstanding
  for (const guess of ["", "x", "a".repeat(43), "0".repeat(43), "ONE-TIME-CODE"]) {
    const res = await fromHost(b, { path: "/?admin=" + guess });
    assert.equal(res.status, 303);
    assert.equal(res.headers["set-cookie"], undefined, `guess "${guess.slice(0, 10)}"`);
    assert.equal(res.headers.location, "/signin-expired");
  }
  for (const [method, p] of ROUTES) assert.equal((await fromHost(b, { method, path: p })).status, 401, `${method} ${p}`);
  assert.equal((await fromHost(b, { headers: { Cookie: "multiplayer_ai_admin=guess" } })).status, 401);
});

test("container mode: an expired code gives no cookie and every route stays closed", async () => {
  let t = 1_000_000;
  const adminAuth = createAdminAuth({ now: () => t });
  const b = await inContainer({ adminAuth });
  const link = new URL(b.app.admin.link());
  t += 5 * 60_000 + 1;
  const res = await fromHost(b, { path: link.pathname + link.search });
  assert.equal(res.headers["set-cookie"], undefined);
  assert.equal(res.headers.location, "/signin-expired");
  assert.equal((await fromHost(b)).status, 401);
});

test("container mode: a code that was already used gives no second cookie", async () => {
  const b = await inContainer();
  const link = new URL(b.app.admin.link());
  const first = await fromHost(b, { path: link.pathname + link.search });
  const second = await fromHost(b, { path: link.pathname + link.search });
  assert.ok(first.headers["set-cookie"]);
  assert.equal(second.headers["set-cookie"], undefined);
  assert.equal(second.headers.location, "/signin-expired");
});

test("container mode: a sign-in link opened through a tunnel's Host or with proxy headers is refused and does not spend the code", async () => {
  const b = await inContainer({ extraHosts: ["abc.tunnel.example"] });
  const link = new URL(b.app.admin.link());
  const code = link.pathname + link.search;
  assert.equal((await fromHost(b, { path: code, headers: { Host: "abc.tunnel.example" } })).headers["set-cookie"], undefined);
  assert.equal((await fromHost(b, { path: code, headers: { "X-Forwarded-For": "203.0.113.9" } })).headers["set-cookie"], undefined);
  assert.ok((await fromHost(b, { path: code })).headers["set-cookie"], "the real owner's use still works afterwards");
});

test("outside a container the source address is still checked, so the same request from another address is refused even with the cookie", { skip: lan ? false : "no non-loopback IPv4 address on this computer" }, async () => {
  const b = await boot({ container: false, host: "0.0.0.0" });
  closers.push(() => b.app.close());
  const cookie = await b.cookie();
  const res = await request(b.app, { path: "/api/settings", host: lan, headers: { Host: `localhost:${b.app.port}`, Cookie: cookie, "Sec-Fetch-Site": "same-origin" } });
  assert.equal(res.status, 403);
  assert.equal(res.json().code, "ADMIN_LOCAL_ONLY");
});

test("MULTIPLAYER_AI_PUBLIC_PORT: the Host the browser sends is the published port, and the address shown uses it", async () => {
  const b = await inContainer({ env: { MULTIPLAYER_AI_PUBLIC_PORT: "8080" } });
  assert.match(b.app.url, /:8080$/);
  assert.equal((await fromHost(b, { path: "/api/config", headers: { Host: "localhost:8080" } })).status, 200);
  assert.equal((await fromHost(b, { path: "/api/config", headers: { Host: `localhost:${b.app.port}` } })).status, 403, "the container's own port is no longer the address");
  const link = new URL(b.app.admin.link("/setup?next=%2Fnew"));
  assert.equal(link.port, "8080");
  assert.equal(link.pathname, "/setup");
  assert.equal(link.searchParams.get("next"), "/new");
  assert.ok(link.searchParams.get("admin"));
});

test("MULTIPLAYER_AI_PUBLIC_PORT does nothing outside a container", async () => {
  const b = await boot({ env: { MULTIPLAYER_AI_PUBLIC_PORT: "8080" } });
  closers.push(() => b.app.close());
  assert.doesNotMatch(b.app.url, /:8080$/);
});
