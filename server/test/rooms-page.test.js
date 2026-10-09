// Run: node --test test/   (no network beyond this computer)
// "Your rooms": the host's list of rooms, newest activity first, with rename, archive and unarchive, and deleting one room.
// What each action does, what refuses it, and who can reach any of it (this computer's address with the host's cookie, and nobody else).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { boot, request, lanAddress, resetSettings } from "./helpers/http.js";
import { makers, cleanup, ageRoom } from "./helpers/stores.js";
import { createLimits } from "../limits.js";
import { makeFakeSupabase } from "./fakeSupabase.js";
import { asStore } from "../store/index.js";
import { startHttp } from "../http.js";
import * as actions from "../host-actions.js";

const { createSession } = await import("../tools/create_session.js");
const { joinSession } = await import("../tools/join_session.js");
const { sendComment } = await import("../tools/send_comment.js");
const { sendDirective } = await import("../tools/send_directive.js");
const { attachFile } = await import("../tools/files.js");

const closers = [];
after(async () => {
  for (const c of closers.splice(0)) await c();
  resetSettings();
  await cleanup();
});
const DAY = 86_400_000;
const rejects = (promise, status, code) => assert.rejects(promise, (e) => e.status === status && e.code === code, `expected ${status} ${code}`);
const lan = lanAddress();

// ── what the actions do ───────────────────────────────────────────────

for (const kind of ["memory", "sqlite"]) {
  async function world() {
    const store = await makers[kind]();
    const d = { db: store, trigger: () => {}, limits: createLimits({ env: {}, local: true }), budget: { claim: () => ({}) } };
    const make = (task, name = "Maya") => createSession({ task, creator_name: name }, { ...d, caller: { host: true, sharing: false } });
    return { store, d, make };
  }
  const t = (title, fn) => test(`[${kind}] ${title}`, async () => fn(await world()));

  t("the list has every room with its title, last activity, people and state, newest activity first", async (w) => {
    const a = await w.make("First room");
    const b = await w.make("Second room");
    await joinSession({ session_id: a.session_id, name: "Guest" }, w.d);
    await new Promise((r) => setTimeout(r, 5));
    await sendComment({ session_id: a.session_id, token: a.token, content: "later activity" }, w.d);
    const rooms = await actions.listRooms({ store: w.store });
    assert.deepEqual(rooms.map((r) => r.title), ["First room", "Second room"], "the room with the latest event is first");
    assert.deepEqual(rooms.map((r) => [r.people, r.state, r.archived_by_host]), [[2, "open", false], [1, "open", false]]);
    assert.match(rooms[0].last_activity, /^\d{4}-\d\d-\d\dT/);
    assert.equal(rooms[0].id, a.session_id);
    assert.deepEqual(Object.keys(rooms[0]).sort(), ["agent_working", "archived_by_host", "created_at", "id", "last_activity", "people", "state", "step_count", "title"]);
    assert.ok(!JSON.stringify(rooms).includes(a.token), "no token in the list");
  });

  t("state is open, ended or archived (by silence or by the host)", async (w) => {
    const open = await w.make("open");
    const ended = await w.make("ended");
    await w.store.updateSession(ended.session_id, { status: "done" });
    const quiet = await w.make("quiet");
    ageRoom(w.store, quiet.session_id, 30 * DAY);
    const byHost = await w.make("host archived");
    await actions.setArchived({ store: w.store, sessionId: byHost.session_id, archived: true });
    const states = Object.fromEntries((await actions.listRooms({ store: w.store })).map((r) => [r.title, [r.state, r.archived_by_host]]));
    assert.deepEqual(states, { open: ["open", false], ended: ["ended", false], quiet: ["archived", false], "host archived": ["archived", true] });
  });

  t("an empty list is an empty array", async (w) => {
    assert.deepEqual(await actions.listRooms({ store: w.store }), []);
  });

  t("renaming sets a new title, cut to the title limit on a whole character, with the existing rules for what a title may hold", async (w) => {
    const r = await w.make("Old title");
    await actions.renameRoom({ store: w.store, sessionId: r.session_id, title: "  A new title  " });
    assert.equal((await w.store.getSession(r.session_id)).title, "A new title");
    const long = "x".repeat(200);
    await actions.renameRoom({ store: w.store, sessionId: r.session_id, title: long });
    assert.equal((await w.store.getSession(r.session_id)).title.length, 120);
    await actions.renameRoom({ store: w.store, sessionId: r.session_id, title: "😀".repeat(130) });
    assert.equal([...(await w.store.getSession(r.session_id)).title].length, 120, "never half an emoji");
    await actions.renameRoom({ store: w.store, sessionId: r.session_id, title: "<img src=x onerror=alert(1)> & \"quotes\"" });
    assert.equal((await w.store.getSession(r.session_id)).title, "<img src=x onerror=alert(1)> & \"quotes\"", "markup is just text; it is only ever shown as text");
  });

  t("a hostile title is refused, nothing changes, and the refusal does not repeat it", async (w) => {
    const r = await w.make("Keep me");
    for (const title of ["a‮b", "a\nb", "a\u0000b", "a\u001b[31mb", "a​b", "a\tb", "a b"]) {
      await assert.rejects(actions.renameRoom({ store: w.store, sessionId: r.session_id, title }), (e) => e.status === 400 && e.code === "INVALID_TITLE" && !/[‮​\u001b]/.test(e.message));
    }
    for (const title of ["", "   ", undefined, null, 5, {}, []]) await rejects(actions.renameRoom({ store: w.store, sessionId: r.session_id, title }), 400, title === "" || title === "   " ? "BAD_REQUEST" : "BAD_REQUEST");
    assert.equal((await w.store.getSession(r.session_id)).title, "Keep me");
    await rejects(actions.renameRoom({ store: w.store, sessionId: "00000000-0000-0000-0000-000000000000", title: "x" }), 404, "ROOM_NOT_FOUND");
  });

  t("archiving makes a room read-only for everyone, with its own words, and says so in the room; unarchiving reopens it", async (w) => {
    const r = await w.make("Archive me");
    await actions.setArchived({ store: w.store, sessionId: r.session_id, archived: true });
    await assert.rejects(sendComment({ session_id: r.session_id, token: r.token, content: "hello" }, w.d), (e) => e.status === 410 && e.code === "ROOM_ARCHIVED" && /The host archived this room/.test(e.message));
    await assert.rejects(sendDirective({ session_id: r.session_id, token: r.token, content: "hello" }, w.d), (e) => e.status === 410);
    await assert.rejects(attachFile({ session_id: r.session_id, token: r.token, name: "a.txt", content: "x" }, w.d), (e) => e.status === 410);
    assert.ok((await w.store.listEvents(r.session_id)).some((e) => e.kind === "status" && e.content === "The host archived this room."));
    await actions.setArchived({ store: w.store, sessionId: r.session_id, archived: false });
    const ok = await sendComment({ session_id: r.session_id, token: r.token, content: "back again" }, w.d);
    assert.ok(ok.event);
    assert.ok((await w.store.listEvents(r.session_id)).some((e) => e.content === "The host unarchived this room."));
  });

  t("unarchiving a room that was archived by silence reopens it too", async (w) => {
    const r = await w.make("Quiet");
    ageRoom(w.store, r.session_id, 30 * DAY);
    assert.equal((await actions.listRooms({ store: w.store }))[0].state, "archived");
    await actions.setArchived({ store: w.store, sessionId: r.session_id, archived: false });
    assert.equal((await actions.listRooms({ store: w.store }))[0].state, "open");
    assert.ok((await sendComment({ session_id: r.session_id, token: r.token, content: "alive" }, w.d)).event);
  });

  t("archive and unarchive are idempotent and need a yes or no", async (w) => {
    const r = await w.make("x");
    await actions.setArchived({ store: w.store, sessionId: r.session_id, archived: true });
    await actions.setArchived({ store: w.store, sessionId: r.session_id, archived: true });
    assert.equal((await w.store.listEvents(r.session_id)).filter((e) => e.content === "The host archived this room.").length, 1);
    for (const bad of ["yes", 1, null, undefined]) await rejects(actions.setArchived({ store: w.store, sessionId: r.session_id, archived: bad }), 400, "BAD_REQUEST");
    await rejects(actions.setArchived({ store: w.store, sessionId: "00000000-0000-0000-0000-000000000000", archived: true }), 404, "ROOM_NOT_FOUND");
  });

  t("deleting one room needs the typed words, removes the room with its events, people and files, and leaves the others", async (w) => {
    const a = await w.make("Delete me");
    const b = await w.make("Keep me");
    await attachFile({ session_id: a.session_id, token: a.token, name: "a.txt", content: "FILE-NEEDLE" }, w.d);
    await attachFile({ session_id: b.session_id, token: b.token, name: "b.txt", content: "kept" }, w.d);
    for (const confirm of [undefined, "", "delete", "Delete room", "delete room ", "delete all rooms"]) {
      await rejects(actions.deleteRoom({ store: w.store, sessionId: a.session_id, confirm }), 400, "CONFIRM_MISMATCH");
    }
    assert.ok(await w.store.getSession(a.session_id), "nothing happened yet");
    const out = await actions.deleteRoom({ store: w.store, sessionId: a.session_id, confirm: "delete room" });
    assert.deepEqual(out, { deleted: true });
    assert.equal(await w.store.getSession(a.session_id), null);
    assert.deepEqual(await w.store.listEvents(a.session_id), []);
    assert.deepEqual(await w.store.listParticipants(a.session_id), []);
    assert.deepEqual(await w.store.listFiles(a.session_id), []);
    assert.equal((await w.store.getFile(b.session_id, "b.txt")).content, "kept");
    assert.deepEqual((await actions.listRooms({ store: w.store })).map((r) => r.title), ["Keep me"]);
    await rejects(actions.deleteRoom({ store: w.store, sessionId: a.session_id, confirm: "delete room" }), 404, "ROOM_NOT_FOUND");
  });

  t("a room whose agent is working can't be deleted until it is done", async (w) => {
    const r = await w.make("Busy");
    await w.store.updateSession(r.session_id, { agent_working: true });
    await rejects(actions.deleteRoom({ store: w.store, sessionId: r.session_id, confirm: "delete room" }), 409, "AGENT_WORKING");
    await w.store.updateSession(r.session_id, { agent_working: false });
    assert.deepEqual(await actions.deleteRoom({ store: w.store, sessionId: r.session_id, confirm: "delete room" }), { deleted: true });
  });
}

test("with Supabase storage the rooms page says plainly that it isn't available", async () => {
  const store = asStore(makeFakeSupabase({ sessions: [], session_events: [], session_participants: [] }));
  for (const call of [
    () => actions.listRooms({ store }),
    () => actions.renameRoom({ store, sessionId: "x", title: "t" }),
    () => actions.setArchived({ store, sessionId: "x", archived: true }),
    () => actions.deleteRoom({ store, sessionId: "x", confirm: "delete room" })
  ]) await rejects(call(), 409, "ROOMS_UNAVAILABLE");
});

// ── who can reach it ──────────────────────────────────────────────────

async function up({ share = false, ...options } = {}) {
  const b = await boot(options);
  closers.push(() => b.app.close());
  b.cookieValue = await b.cookie();
  b.host = (method, p, body, headers = {}) => request(b.app, { method, path: p, headers: { Cookie: b.cookieValue, Origin: b.app.url, "Sec-Fetch-Site": "same-origin", ...headers }, body });
  b.anon = (method, p, body, headers = {}) => request(b.app, { method, path: p, headers: { Origin: b.app.url, ...headers }, body });
  if (share) await b.app.sharing.enable(lan);
  b.lanOrigin = lan ? `http://${lan}:${b.app.port}` : null;
  b.lan = (method, p, body, headers = {}) => request(b.app, { method, path: p, host: lan, headers: { Host: `${lan}:${b.app.port}`, Origin: b.lanOrigin, ...headers }, body });
  const made = await b.host("POST", "/api/tools/create_session", { task: "Plan a trip", creator_name: "Maya" });
  b.room = made.json();
  return b;
}
const ROUTES = (id) => [
  ["GET", "/api/host/rooms"],
  ["PUT", `/api/host/rooms/${id}/title`, { title: "New" }],
  ["POST", `/api/host/rooms/${id}/archive`, { archived: true }],
  ["POST", `/api/host/rooms/${id}/delete`, { confirm: "delete room" }]
];

test("the host, on this computer's address, can list, rename, archive, unarchive and delete over HTTP", async () => {
  const b = await up();
  const id = b.room.session_id;
  const list = await b.host("GET", "/api/host/rooms");
  assert.equal(list.status, 200);
  assert.deepEqual(list.json().rooms.map((r) => [r.id, r.title, r.state, r.people]), [[id, "Plan a trip", "open", 1]]);
  assert.equal((await b.host("PUT", `/api/host/rooms/${id}/title`, { title: "Renamed" })).json().rooms[0].title, "Renamed");
  assert.equal((await b.host("POST", `/api/host/rooms/${id}/archive`, { archived: true })).json().rooms[0].state, "archived");
  assert.equal((await b.host("POST", `/api/host/rooms/${id}/archive`, { archived: false })).json().rooms[0].state, "open");
  assert.equal((await b.host("POST", `/api/host/rooms/${id}/delete`, { confirm: "nope" })).status, 400);
  const gone = await b.host("POST", `/api/host/rooms/${id}/delete`, { confirm: "delete room" });
  assert.deepEqual([gone.status, gone.json().rooms], [200, []]);
  assert.equal((await b.host("GET", `/api/host/rooms/${id}`)).status, 404);
});

test("no cookie, a foreign Origin, a foreign site and a proxy header are each refused, for every route, and nothing changes", async () => {
  const b = await up();
  const id = b.room.session_id;
  for (const [m, p, body] of ROUTES(id)) {
    assert.equal((await b.anon(m, p, body)).status, 401, `${m} ${p} without a cookie`);
    assert.equal((await b.anon(m, p, body, { Authorization: `Bearer ${b.room.token}` })).status, 401, "a room token is not the host's cookie");
    assert.equal((await request(b.app, { method: m, path: p, headers: { Cookie: b.cookieValue, Origin: "http://evil.example" }, body })).status, 403, "foreign Origin");
    assert.equal((await request(b.app, { method: m, path: p, headers: { Cookie: b.cookieValue, Origin: b.app.url, "Sec-Fetch-Site": "cross-site" }, body })).status, 403, "cross-site");
    for (const header of [{ "X-Forwarded-For": "1.2.3.4" }, { Forwarded: "for=1.2.3.4" }, { Via: "1.1 tunnel" }, { "CF-Connecting-IP": "1.2.3.4" }]) {
      assert.equal((await request(b.app, { method: m, path: p, headers: { Cookie: b.cookieValue, Origin: b.app.url, ...header }, body })).status, 403, `${m} ${p} ${Object.keys(header)}`);
    }
    assert.equal((await request(b.app, { method: m, path: p, headers: { Cookie: b.cookieValue, Origin: b.app.url, Host: "rebind.example" }, body })).status, 403, "a wrong Host");
  }
  assert.deepEqual((await b.store.getSession(b.room.session_id)).title, "Plan a trip");
  assert.equal((await b.store.listSessions()).length, 1);
});

test("on the network address the routes do not exist, even with the host's cookie, a good Origin and the host's token", { skip: lan ? false : "no network address" }, async () => {
  const b = await up({ share: true });
  const id = b.room.session_id;
  for (const [m, p, body] of ROUTES(id)) {
    const res = await b.lan(m, p, body, { Cookie: b.cookieValue, "Sec-Fetch-Site": "same-origin", Authorization: `Bearer ${b.room.token}` });
    assert.equal(res.status, 404, `${m} ${p}`);
    assert.equal(res.json().code, "NOT_FOUND");
  }
  assert.equal((await b.store.listSessions()).length, 1);
});

test("the /rooms page: the host gets the app's page; everyone else gets a plain 404", async () => {
  const b = await up({ webDir: undefined });
  const html = await b.host("GET", "/rooms", undefined, { Accept: "text/html" });
  assert.ok([200, 404].includes(html.status));
  for (const p of ["/rooms", "/rooms/", "/rooms/anything", "/rooms?x=1"]) {
    const none = await b.anon("GET", p, undefined, { Accept: "text/html" });
    assert.equal(none.status, 404, `${p} without the cookie`);
    assert.ok(!/<div id="root"/.test(none.text), "and no page");
    const tunnel = await request(b.app, { path: p, headers: { Cookie: b.cookieValue, "X-Forwarded-For": "9.9.9.9" } });
    assert.equal(tunnel.status, 403, `${p} through a proxy header is refused like everything else`);
  }
  const wrongHost = await request(b.app, { path: "/rooms", headers: { Cookie: b.cookieValue, Host: "evil.example" } });
  assert.equal(wrongHost.status, 403);
});

test("the /rooms page is a plain 404 on the network address, with or without the host's cookie", { skip: lan ? false : "no network address" }, async () => {
  const b = await up({ share: true });
  for (const headers of [{}, { Cookie: b.cookieValue }]) {
    const res = await b.lan("GET", "/rooms", undefined, headers);
    assert.equal(res.status, 404);
    assert.ok(!/<div id="root"/.test(res.text));
  }
});

test("with Supabase storage the host's routes answer that rooms aren't available", async () => {
  const store = asStore(makeFakeSupabase({ sessions: [], session_events: [], session_participants: [] }));
  const app = await startHttp({ store, profile: "local", env: {}, port: 0, log: () => {} });
  closers.push(() => app.close());
  const link = new URL(app.admin.link());
  const signed = await request(app, { path: link.pathname + link.search });
  const cookie = signed.headers["set-cookie"][0].split(";")[0];
  const res = await request(app, { path: "/api/host/rooms", headers: { Cookie: cookie, Origin: app.url } });
  assert.equal(res.status, 409);
  assert.ok(["ROOMS_UNAVAILABLE", "SHARING_UNAVAILABLE"].includes(res.json().code));
});

test("deleting one room over HTTP removes its files from the data file", async () => {
  const b = await up();
  const id = b.room.session_id;
  const needle = "ROOM-DELETE-NEEDLE-998877";
  await b.anon("POST", "/api/tools/attach_file", { session_id: id, token: b.room.token, name: "n.txt", content: needle });
  await b.host("POST", `/api/host/rooms/${id}/delete`, { confirm: "delete room" });
  assert.equal(b.store._db.prepare("SELECT count(*) AS n FROM room_files").get().n, 0);
  await b.store.compact();
  for (const f of [b.store.file, `${b.store.file}-wal`]) if (fs.existsSync(f)) assert.ok(!fs.readFileSync(f).includes(needle));
});
