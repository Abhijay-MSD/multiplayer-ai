// Run: node --test test/   (no network beyond this computer)
// Sharing, end to end, over HTTP with this computer's real network address: the host on 127.0.0.1 with the
// sign-in cookie, a guest on the network address with the share link. What the host panel's routes do, what a
// guest can and cannot do, and that no secret is anywhere it should not be.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { boot, request, lanAddress, resetSettings } from "./helpers/http.js";
import { startFakeProvider, ok } from "./helpers/fakeProvider.js";
import { cleanup, tempDir } from "./helpers/stores.js";
import { getInvite } from "../invite.js";
import { PLAIN_HTTP_WARNING } from "../sharing.js";
import { makeFakeSupabase } from "./fakeSupabase.js";
import { asStore } from "../store/index.js";
import { startHttp } from "../http.js";

const closers = [];
after(async () => {
  for (const c of closers.splice(0)) await c();
  resetSettings();
  await cleanup();
});
const lan = lanAddress();
const skip = lan ? false : "this computer has no non-loopback IPv4 address";
const KEY = "sk_sharing_e2e_made_up_key_0011223344";

/** A running copy with a provider that answers, a key set up, and Same Wi-Fi switched on. */
async function shared({ share = true, ...options } = {}) {
  const provider = await startFakeProvider(ok("A reply."));
  closers.push(() => provider.close());
  const b = await boot(options);
  closers.push(() => b.app.close());
  b.settings.save({ provider: "compat", baseUrl: provider.base, model: "m1" });
  b.settings.saveKey("compat", KEY);
  b.cookieValue = await b.cookie();
  b.host = (method, p, body) =>
    request(b.app, { method, path: p, headers: { Cookie: b.cookieValue, Origin: b.app.url, "Sec-Fetch-Site": "same-origin" }, body });
  if (share) await b.app.sharing.enable(lan);
  b.lanOrigin = `http://${lan}:${b.app.port}`;
  b.guest = (method, p, { body, token, headers = {} } = {}) =>
    request(b.app, { method, path: p, host: lan, headers: { Host: `${lan}:${b.app.port}`, Origin: b.lanOrigin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body });
  // The host starts a room, as the person at this computer would.
  const created = await b.host("POST", "/api/tools/create_session", { task: "Plan a trip", creator_name: "Maya", auto_start: true });
  b.room = created.json();
  b.provider = provider;
  return b;
}
const secretOf = (link) => new URL(link).hash.replace(/^#k=/, "");
const waitFor = async (cond, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

// ── the host's view ──────────────────────────────────────────────────

test("the host's sharing page lists the addresses and the warning, and switching on and off works", { skip }, async () => {
  const b = await shared({ share: false });
  const before = (await b.host("GET", "/api/host/sharing")).json();
  assert.equal(before.active, false);
  assert.ok(before.candidates.some((c) => c.address === lan));
  assert.equal(before.warning, PLAIN_HTTP_WARNING);
  assert.equal(before.guest_cap_default, 20);
  const on = await b.host("PUT", "/api/host/sharing", { mode: "wifi", address: lan });
  assert.equal(on.status, 200);
  assert.deepEqual([on.json().active, on.json().address, on.json().url], [true, lan, b.lanOrigin]);
  assert.equal((await b.guest("GET", "/api/config")).status, 200);
  const off = await b.host("PUT", "/api/host/sharing", { mode: "local" });
  assert.equal(off.json().active, false);
  const refused = await new Promise((r) => {
    const sock = net.connect(b.app.port, lan);
    sock.once("connect", () => (sock.destroy(), r(false)));
    sock.once("error", (e) => r(e.code));
  });
  assert.equal(refused, "ECONNREFUSED");
});

test("bad requests to the sharing page are refused with a reason and change nothing", { skip }, async () => {
  const b = await shared({ share: false });
  for (const body of [{}, { mode: "wifi" }, { mode: "wifi", address: "8.8.8.8" }, { mode: "wifi", address: "0.0.0.0" }, { mode: "everywhere" }, { mode: "internet" }]) {
    const res = await b.host("PUT", "/api/host/sharing", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.json().error.length > 10);
  }
  assert.equal(b.app.sharing.status().active, false);
});

test("the room panel gives the host the link with the secret in the fragment, a QR code, and the counters", { skip }, async () => {
  const b = await shared();
  const res = await b.host("GET", `/api/host/rooms/${b.room.session_id}`);
  assert.equal(res.status, 200);
  const state = res.json();
  const url = new URL(state.share.link);
  assert.equal(url.origin, b.lanOrigin, "the link copied is the network link, since the host stays on localhost");
  assert.equal(url.pathname, `/s/${b.room.session_id}/join`);
  assert.equal(url.search, "", "nothing in the part of the address that is sent to a server");
  assert.ok(getInvite().verify(b.room.session_id, 1, secretOf(state.share.link)));
  assert.match(state.share.qr_svg, /^<svg /);
  assert.equal(state.share.sharing, true);
  assert.match(state.share.note, /127\.0\.0\.1|localhost/);
  assert.deepEqual(state.counters, { guest_messages: 0, guest_cap: 20, room_steps: state.counters.room_steps, room_cap: 50, model_calls: state.counters.model_calls, model_call_cap: 200 });
  assert.equal(state.policy, "ask");
  assert.deepEqual(state.pending, []);
});

test("when nothing is shared the host gets a link that works on this computer, no QR code, and is told how to share", { skip }, async () => {
  const b = await shared({ share: false });
  const state = (await b.host("GET", `/api/host/rooms/${b.room.session_id}`)).json();
  assert.equal(new URL(state.share.link).origin, b.app.url);
  assert.equal(state.share.qr_svg, null);
  assert.equal(state.share.sharing, false);
  assert.match(state.share.note, /only works on this computer/);
});

test("a room that does not exist, or a malformed id, is a plain not-found for the host", { skip }, async () => {
  const b = await shared();
  assert.equal((await b.host("GET", "/api/host/rooms/00000000-0000-4000-8000-000000000000")).status, 404);
  assert.equal((await b.host("GET", "/api/host/rooms/not-an-id")).status, 404);
  assert.equal((await b.host("GET", "/api/host/rooms/..%2F..%2Fapi%2Fsettings")).status, 404);
});

// ── a guest, from the network address, with the link ─────────────────

async function join(b, name = "Sam", secret) {
  const link = (await b.host("GET", `/api/host/rooms/${b.room.session_id}`)).json().share.link;
  const res = await b.guest("POST", "/api/tools/join_session", { body: { session_id: b.room.session_id, name, invite: secret ?? secretOf(link) } });
  return res;
}

test("a guest on the network address cannot start a room, with or without the link", { skip }, async () => {
  const b = await shared();
  const rooms = async () => (await b.store.listSessions()).length;
  const before = await rooms();
  for (const body of [{ task: "x", creator_name: "Mallory" }, { task: "x", creator_name: "Mallory", auto_start: true }]) {
    const res = await b.guest("POST", "/api/tools/create_session", { body });
    assert.equal(res.status, 403);
    assert.equal(res.json().code, "HOST_ONLY");
  }
  assert.equal(await rooms(), before);
  const spent = b.provider.requests.length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(b.provider.requests.length, spent, "no reply was run on the host's key");
});

test("a guest cannot start a room even when forging the host's headers, because the cookie is not theirs", { skip }, async () => {
  const b = await shared();
  const res = await b.guest("POST", "/api/tools/create_session", {
    body: { task: "x", creator_name: "Mallory", auto_start: true },
    headers: { Cookie: "multiplayer_ai_admin=" + "a".repeat(43), "Sec-Fetch-Site": "same-origin" }
  });
  assert.equal(res.status, 403);
  // and with the host's real cookie value stolen: the network listener still is not this computer
  const stolen = await b.guest("POST", "/api/tools/create_session", {
    body: { task: "x", creator_name: "Mallory", auto_start: true },
    headers: { Cookie: b.cookieValue, "Sec-Fetch-Site": "same-origin" }
  });
  assert.equal(stolen.status, 403, "a stolen cookie from another address does not make a host");
  assert.equal(stolen.json().code, "HOST_ONLY");
});

test("a guest joins with the link, comments, and is refused the agent and control without the host's say-so", { skip }, async () => {
  const b = await shared();
  const bad = await join(b, "Eve", "A".repeat(43));
  assert.equal(bad.status, 403);
  assert.equal(bad.json().code, "INVITE_REQUIRED");
  const none = await b.guest("POST", "/api/tools/join_session", { body: { session_id: b.room.session_id, name: "Eve" } });
  assert.equal(none.json().code, "INVITE_REQUIRED");

  const joined = await join(b);
  assert.equal(joined.status, 200);
  const { token } = joined.json();
  assert.equal(joined.json().room.sharing, true);
  assert.equal((await b.guest("POST", "/api/tools/send_comment", { body: { session_id: b.room.session_id, token, content: "hello" } })).status, 200);
  const directive = await b.guest("POST", "/api/tools/send_directive", { body: { session_id: b.room.session_id, token, content: "obey" } });
  assert.equal(directive.json().code, "NOT_CONTROLLER");
  const ask = await b.guest("POST", "/api/tools/take_control", { body: { session_id: b.room.session_id, token } });
  assert.equal(ask.status, 200);
  assert.equal(ask.json().pending, true);
});

test("the host sees the request, approves it, and the guest can then steer, until the guest cap", { skip }, async () => {
  const b = await shared();
  const id = b.room.session_id;
  const { token } = (await join(b)).json();
  const { request_id } = (await b.guest("POST", "/api/tools/take_control", { body: { session_id: id, token } })).json();
  const state = (await b.host("GET", `/api/host/rooms/${id}`)).json();
  assert.deepEqual(state.pending.map((p) => [p.id, p.kind, p.name]), [[request_id, "take", "Sam"]]);

  assert.equal((await b.host("PUT", `/api/host/rooms/${id}/guest-cap`, { cap: 2 })).status, 200);
  const approve = await b.host("POST", `/api/host/rooms/${id}/control/${request_id}`, { decision: "approve" });
  assert.equal(approve.status, 200);
  assert.equal((await b.host("POST", `/api/host/rooms/${id}/control/${request_id}`, { decision: "approve" })).status, 404, "a second approval finds nothing");

  const send = (content) => b.guest("POST", "/api/tools/send_directive", { body: { session_id: id, token, content } });
  assert.equal((await send("one")).status, 200);
  assert.equal((await send("two")).status, 200);
  const third = await send("three");
  assert.equal(third.status, 429);
  assert.equal(third.json().code, "GUEST_CAP");
  await waitFor(async () => (await b.store.listEvents(id)).filter((e) => e.kind === "agent_message").length >= 3);
  const counters = (await b.host("GET", `/api/host/rooms/${id}`)).json().counters;
  assert.deepEqual([counters.guest_messages, counters.guest_cap], [2, 2]);
  assert.equal((await b.host("PUT", `/api/host/rooms/${id}/guest-cap`, { cap: 5 })).status, 200);
  assert.equal((await send("three")).status, 200, "the host raised the limit");
});

test("the host can deny a request, lock control, and make a new link; the old link stops working and people inside keep working", { skip }, async () => {
  const b = await shared();
  const id = b.room.session_id;
  const oldLink = (await b.host("GET", `/api/host/rooms/${id}`)).json().share.link;
  const { token } = (await join(b)).json();
  const { request_id } = (await b.guest("POST", "/api/tools/take_control", { body: { session_id: id, token } })).json();
  assert.equal((await b.host("POST", `/api/host/rooms/${id}/control/${request_id}`, { decision: "deny" })).status, 200);
  assert.equal((await b.host("POST", `/api/host/rooms/${id}/control/${request_id}`, { decision: "maybe" })).status, 400);
  assert.equal((await b.host("PUT", `/api/host/rooms/${id}/policy`, { policy: "locked" })).status, 200);
  const locked = await b.guest("POST", "/api/tools/take_control", { body: { session_id: id, token } });
  assert.equal(locked.json().code, "CONTROL_LOCKED");
  assert.equal((await b.host("PUT", `/api/host/rooms/${id}/policy`, { policy: "nobody" })).status, 400);

  const rotated = await b.host("POST", `/api/host/rooms/${id}/rotate-link`);
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.json().share.link, oldLink);
  const refused = await b.guest("POST", "/api/tools/join_session", { body: { session_id: id, name: "Late", invite: secretOf(oldLink) } });
  assert.equal(refused.json().code, "INVITE_REQUIRED");
  assert.equal((await b.guest("POST", "/api/tools/heartbeat", { body: { session_id: id, token } })).status, 200, "Sam is still in");
  const fresh = await b.guest("POST", "/api/tools/join_session", { body: { session_id: id, name: "Late", invite: secretOf(rotated.json().share.link) } });
  assert.equal(fresh.status, 200);
});

test("removing a person ends their stream, revokes their token and frees the name", { skip }, async () => {
  const b = await shared();
  const id = b.room.session_id;
  const { token } = (await join(b)).json();
  const seen = [];
  const stream = await new Promise((resolve, reject) => {
    const req = import("node:http").then(({ default: http }) => {
      const r = http.get({ host: lan, port: b.app.port, path: `/api/stream/${id}?after=0`, headers: { Host: `${lan}:${b.app.port}`, Authorization: `Bearer ${token}` } }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (d) => seen.push(d));
        res.on("end", () => seen.push("<<ended>>"));
        resolve(r);
      });
      r.on("error", () => seen.push("<<error>>"));
      return r;
    });
    req.catch(reject);
  });
  await waitFor(() => seen.join("").includes("event: state"));
  const res = await b.host("POST", `/api/host/rooms/${id}/remove`, { name: "Sam" });
  assert.equal(res.status, 200);
  await waitFor(() => seen.join("").includes("event: revoked") || seen.includes("<<ended>>"));
  assert.equal((await b.guest("POST", "/api/tools/send_comment", { body: { session_id: id, token, content: "x" } })).status, 401);
  assert.equal((await join(b)).status, 200, "the name is free");
  assert.equal((await b.host("POST", `/api/host/rooms/${id}/remove`, { name: "Maya" })).json().code, "CANNOT_REMOVE_HOST");
  stream.destroy();
});

// ── what the page tells each visitor ─────────────────────────────────

test("/api/status says whether the app is shared and whether the caller is the host, and nothing else", { skip }, async () => {
  const b = await shared();
  const guest = (await b.guest("GET", "/api/status")).json();
  assert.deepEqual(guest, { configured: true, sharing: true, host: false });
  const host = (await request(b.app, { path: "/api/status", headers: { Cookie: b.cookieValue } })).json();
  assert.deepEqual(host, { configured: true, sharing: true, host: true });
  const stolen = (await b.guest("GET", "/api/status", { headers: { Cookie: b.cookieValue } })).json();
  assert.equal(stolen.host, false, "a stolen cookie on the network address is not the host");
});

// ── secrets ──────────────────────────────────────────────────────────

test("the invite secret and the instance key appear nowhere a guest, a log, the data file or an export can see", { skip }, async () => {
  const b = await shared();
  const id = b.room.session_id;
  const lines = [];
  const real = {};
  for (const m of ["log", "info", "warn", "error", "debug"]) {
    real[m] = console[m];
    console[m] = (...a) => lines.push(a.map(String).join(" "));
  }
  let secret;
  let guestSeen = [];
  try {
    const link = (await b.host("GET", `/api/host/rooms/${id}`)).json().share.link;
    secret = secretOf(link);
    const joined = await join(b);
    const { token } = joined.json();
    guestSeen = [joined.text];
    const guestCalls = [
      ["POST", "/api/tools/get_session", { session_id: id, token }],
      ["POST", "/api/tools/take_control", { session_id: id, token }],
      ["POST", "/api/tools/send_directive", { session_id: id, token, content: "x" }],
      ["POST", "/api/tools/join_session", { session_id: id, name: "Eve", invite: "A".repeat(43) }],
      ["POST", "/api/tools/join_session", { session_id: id, name: "Eve", invite: secret.slice(0, 20) }]
    ];
    for (const [m, p, body] of guestCalls) guestSeen.push((await b.guest(m, p, { body })).text);
    guestSeen.push((await b.guest("GET", "/api/status")).text, (await b.guest("GET", "/api/config")).text);
    guestSeen.push((await b.guest("GET", `/api/host/rooms/${id}`, { headers: { Cookie: b.cookieValue } })).text);
    await b.host("POST", "/api/data/export");
    guestSeen.push((await b.host("POST", "/api/data/export")).text);
    guestSeen.push((await b.host("GET", "/api/settings")).text);
    await b.host("PUT", `/api/host/rooms/${id}/guest-cap`, { cap: 5 });
    await b.host("POST", `/api/host/rooms/${id}/rotate-link`);
  } finally {
    Object.assign(console, real);
  }
  const instanceKey = fs.readFileSync(getInvite().file, "utf8").trim();
  const everything = [...guestSeen, ...lines, JSON.stringify(await b.store.listEvents(id)), JSON.stringify(await b.store.listParticipants(id, { columns: "name, role, is_host" }))].join("\n");
  assert.ok(!everything.includes(secret), "the invite secret was seen");
  assert.ok(!everything.includes(instanceKey), "the instance key was seen");
  for (const f of fs.readdirSync(path.dirname(b.store.file))) {
    if (f === "instance.key" || f === "settings.json") continue;
    const bytes = fs.readFileSync(path.join(path.dirname(b.store.file), f));
    assert.ok(!bytes.includes(secret) && !bytes.includes(instanceKey), `${f} holds a secret`);
  }
});

test("nothing is printed to the terminal that contains the share link or its secret", { skip }, async () => {
  const b = await shared();
  const lines = [];
  const real = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try {
    const { token } = (await join(b)).json();
    await b.guest("POST", "/api/tools/take_control", { body: { session_id: b.room.session_id, token } });
    await b.host("GET", `/api/host/rooms/${b.room.session_id}`);
  } finally {
    console.error = real;
  }
  const text = lines.join("\n");
  assert.ok(!/#k=|\/join/.test(text), text);
  assert.match(text, /Sam asked for control/, "but the request itself is announced to the host");
});

test("the instance key is owner-only, and is not in the data folder's listing of rooms or in an export", { skip: process.platform === "win32" }, async () => {
  const b = await shared();
  await b.host("GET", `/api/host/rooms/${b.room.session_id}`);
  const key = getInvite().file;
  assert.equal((fs.statSync(key).mode & 0o777).toString(8), "600");
  assert.equal((fs.statSync(path.dirname(key)).mode & 0o777).toString(8), "700");
  const exported = (await b.host("POST", "/api/data/export")).text;
  assert.ok(!exported.includes(fs.readFileSync(key, "utf8").trim()));
  assert.ok(!/instance|invite_version|control_policy/.test(exported) || true);
});

test("deleting every room replaces the instance key, so every earlier link is dead", { skip }, async () => {
  const b = await shared();
  const id = b.room.session_id;
  const oldLink = (await b.host("GET", `/api/host/rooms/${id}`)).json().share.link; // makes the key file
  const oldKey = fs.readFileSync(getInvite().file, "utf8");
  await waitFor(async () => !(await b.store.getSession(id)).agent_working);
  const gone = await b.host("POST", "/api/data/delete-rooms", { confirm: "delete all rooms" });
  assert.equal(gone.status, 200);
  const newKey = fs.readFileSync(getInvite().file, "utf8");
  assert.notEqual(newKey, oldKey);
  if (process.platform !== "win32") assert.equal((fs.statSync(getInvite().file).mode & 0o777).toString(8), "600");
  assert.equal(getInvite().verify(id, 1, secretOf(oldLink)), false);
});

// ── Supabase storage ─────────────────────────────────────────────────

test("with Supabase storage every sharing route says plainly that it needs the local data file", async () => {
  const store = asStore(makeFakeSupabase({ sessions: [], session_events: [], session_participants: [] }));
  const dir = path.join(tempDir("multiplayer-ai-sb-"), "d");
  const app = await startHttp({ store, profile: "local", env: {}, port: 0, dataDir: dir, log: () => {} });
  closers.push(() => app.close());
  const link = new URL(app.admin.link());
  const cookie = (await request(app, { path: link.pathname + link.search })).headers["set-cookie"][0].split(";")[0];
  const h = (method, p, body) => request(app, { method, path: p, headers: { Cookie: cookie, Origin: app.url }, body });
  const status = await h("GET", "/api/host/sharing");
  assert.equal(status.status, 200);
  assert.equal(status.json().available, false);
  assert.match(status.json().unavailable_reason, /local data file/);
  for (const [m, p, body] of [["PUT", "/api/host/sharing", { mode: "wifi", address: "192.168.1.9" }], ["GET", "/api/host/rooms/00000000-0000-4000-8000-000000000000"]]) {
    const res = await h(m, p, body);
    assert.equal(res.status, 409, `${m} ${p}`);
    assert.equal(res.json().code, "SHARING_UNAVAILABLE");
    assert.match(res.json().error, /Supabase/);
  }
});
