// Run: node --test test/   (no network beyond this computer)
// Room files over real HTTP: who can reach which route, from which address, with what; that nothing serves a file as a page;
// that the agent's tool loop works through the whole stack; and that export and delete-all include the files.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { boot, request, lanAddress, resetSettings } from "./helpers/http.js";
import { startFakeProvider, ok } from "./helpers/fakeProvider.js";
import { cleanup } from "./helpers/stores.js";
import { getInvite } from "../invite.js";

const closers = [];
after(async () => {
  for (const c of closers.splice(0)) await c();
  resetSettings();
  await cleanup();
});
const lan = lanAddress();
const KEY = "sk_files_http_made_up_key_5566778899";

const chat = (message, finish = "stop") => (req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message, finish_reason: finish }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
};
/** A provider that writes notes.md when it is offered tools and has not yet seen a result, and otherwise answers in text. */
const writer = (content = "# From the agent") => (req, res) => {
  const body = JSON.parse(req.body || "{}");
  const sawResult = body.messages?.some((m) => m.role === "tool");
  if (body.tools?.length && !sawResult) {
    return chat({ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ name: "notes.md", content }) } }] }, "tool_calls")(req, res);
  }
  return chat({ role: "assistant", content: sawResult ? "I wrote notes.md." : "Plain answer." })(req, res);
};

async function up({ share = false, provider = ok("A reply."), ...options } = {}) {
  const fake = await startFakeProvider(provider);
  closers.push(() => fake.close());
  const b = await boot(options);
  closers.push(() => b.app.close());
  b.settings.save({ provider: "compat", baseUrl: fake.base, model: "m1" });
  b.settings.saveKey("compat", KEY);
  b.provider = fake;
  b.cookieValue = await b.cookie();
  b.host = (method, p, body) => request(b.app, { method, path: p, headers: { Cookie: b.cookieValue, Origin: b.app.url, "Sec-Fetch-Site": "same-origin" }, body });
  b.anon = (method, p, body, headers = {}) => request(b.app, { method, path: p, headers: { Origin: b.app.url, ...headers }, body });
  if (share) await b.app.sharing.enable(lan);
  b.lanOrigin = `http://${lan}:${b.app.port}`;
  b.guest = (method, p, body, headers = {}) => request(b.app, { method, path: p, host: lan, headers: { Host: `${lan}:${b.app.port}`, Origin: b.lanOrigin, ...headers }, body });
  return b;
}
const waitFor = async (cond, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const tool = (b, via, name, body) => via("POST", `/api/tools/${name}`, body);

async function room(b, { autoStart = false } = {}) {
  const r = await b.host("POST", "/api/tools/create_session", { task: "Plan a trip", creator_name: "Maya", auto_start: autoStart });
  assert.equal(r.status, 200, r.text);
  return r.json();
}

test("a room started on this computer with sharing off has the agent's file use on, and the host can turn it off and on", async () => {
  const b = await up();
  const r = await room(b);
  const panel = (await b.host("GET", `/api/host/rooms/${r.session_id}`)).json();
  assert.deepEqual([panel.files.available, panel.files.enabled], [true, true]);
  const off = await b.host("PUT", `/api/host/rooms/${r.session_id}/files`, { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.json().files.enabled, false);
  assert.strictEqual((await b.store.getSession(r.session_id)).files_enabled, false);
  assert.equal((await b.host("PUT", `/api/host/rooms/${r.session_id}/files`, { enabled: true })).json().files.enabled, true);
  assert.equal((await b.host("PUT", `/api/host/rooms/${r.session_id}/files`, { enabled: "yes" })).status, 400);
});

test("the host's file routes need the host: no cookie, a foreign Origin or a foreign site is refused, and a guest token is not enough", async () => {
  const b = await up();
  const r = await room(b);
  const routes = [["PUT", `/api/host/rooms/${r.session_id}/files`, { enabled: false }], ["POST", `/api/host/rooms/${r.session_id}/files/delete`, { name: "a.txt" }], ["POST", `/api/host/rooms/${r.session_id}/files/restore`, { name: "a.txt", version: 1 }]];
  for (const [m, p, body] of routes) {
    assert.equal((await b.anon(m, p, body)).status, 401, `${m} ${p} without the cookie`);
    assert.equal((await b.anon(m, p, body, { Authorization: `Bearer ${r.token}` })).status, 401, "a participant token is not the host's cookie");
    assert.equal((await request(b.app, { method: m, path: p, headers: { Cookie: b.cookieValue, Origin: "http://evil.example" }, body })).status, 403, "foreign Origin");
    assert.equal((await request(b.app, { method: m, path: p, headers: { Cookie: b.cookieValue, Origin: b.app.url, "Sec-Fetch-Site": "cross-site" }, body })).status, 403, "cross-site");
    assert.equal((await request(b.app, { method: m, path: p, headers: { Cookie: b.cookieValue, "X-Forwarded-For": "1.2.3.4", Origin: b.app.url }, body })).status, 403, "a proxy header");
  }
  assert.strictEqual((await b.store.getSession(r.session_id)).files_enabled, true, "nothing changed");
});

test("on the network address the host's file routes do not exist, even with the host's cookie", { skip: lan ? false : "no network address" }, async () => {
  const b = await up({ share: true });
  const r = await room(b);
  for (const [m, p, body] of [["PUT", `/api/host/rooms/${r.session_id}/files`, { enabled: false }], ["POST", `/api/host/rooms/${r.session_id}/files/delete`, { name: "a.txt" }], ["POST", `/api/host/rooms/${r.session_id}/files/restore`, { name: "a.txt", version: 1 }]]) {
    const res = await b.guest(m, p, body, { Cookie: b.cookieValue, "Sec-Fetch-Site": "same-origin" });
    assert.equal(res.status, 404, `${m} ${p}`);
    assert.equal(res.json().code, "NOT_FOUND");
  }
});

test("attaching a file the size of the limit works over HTTP, while any other request keeps the small body limit", async () => {
  const b = await up();
  const r = await room(b);
  const big = "x".repeat(150 * 1024);
  const res = await tool(b, b.host, "attach_file", { session_id: r.session_id, token: r.token, name: "big.txt", content: big });
  assert.equal(res.status, 200, res.text);
  assert.equal((await b.store.getFile(r.session_id, "big.txt")).size, big.length);
  const comment = await tool(b, b.host, "send_comment", { session_id: r.session_id, token: r.token, content: "y".repeat(40 * 1024) });
  assert.equal(comment.status, 413);
  assert.equal(comment.json().code, "BAD_REQUEST");
  const huge = await tool(b, b.host, "attach_file", { session_id: r.session_id, token: r.token, name: "huge.txt", content: "z".repeat(3 * 1024 * 1024) });
  assert.equal(huge.status, 413);
  const heavy = await tool(b, b.host, "attach_file", { session_id: r.session_id, token: r.token, name: "heavy.txt", content: "q".repeat(250 * 1024) });
  assert.equal(heavy.status, 400, "within the body limit but over the file limit");
  assert.equal(heavy.json().code, "FILE_TOO_LARGE");
  const malformed = await request(b.app, { method: "POST", path: "/api/tools/attach_file", headers: { Origin: b.app.url }, body: '{"session_id": "x", "content": ' });
  assert.equal(malformed.status, 400);
});

test("a guest on the network can read the room's files with the room token, but cannot attach, delete, restore or switch anything", { skip: lan ? false : "no network address" }, async () => {
  const b = await up({ share: true });
  const r = await room(b);
  await tool(b, b.host, "attach_file", { session_id: r.session_id, token: r.token, name: "plan.md", content: "the plan" });
  const secret = new URL((await b.host("GET", `/api/host/rooms/${r.session_id}`)).json().share.link).hash.replace(/^#k=/, "");
  const joined = (await tool(b, b.guest, "join_session", { session_id: r.session_id, name: "Guest", invite: secret })).json();
  const read = await tool(b, b.guest, "get_room_file", { session_id: r.session_id, token: joined.token, name: "plan.md" });
  assert.equal(read.status, 200);
  assert.equal(read.json().file.content, "the plan");
  assert.equal((await tool(b, b.guest, "list_room_files", { session_id: r.session_id, token: joined.token })).json().files.length, 1);
  assert.equal((await tool(b, b.guest, "file_versions", { session_id: r.session_id, token: joined.token, name: "plan.md" })).status, 200);
  const attach = await tool(b, b.guest, "attach_file", { session_id: r.session_id, token: joined.token, name: "mine.md", content: "x" });
  assert.deepEqual([attach.status, attach.json().code], [403, "NOT_ALLOWED"]);
  assert.equal((await tool(b, b.guest, "get_room_file", { session_id: r.session_id, token: "mpai_" + "a".repeat(43), name: "plan.md" })).status, 401);
  const other = await room(b);
  assert.equal((await tool(b, b.guest, "get_room_file", { session_id: other.session_id, token: joined.token, name: "plan.md" })).status, 403, "a token for one room does not open another");
  assert.deepEqual((await b.store.listFiles(r.session_id)).map((f) => f.name), ["plan.md"]);
});

test("nothing serves a file as a page: no GET route returns file content, and no token goes in an address", async () => {
  const b = await up();
  const r = await room(b);
  await tool(b, b.host, "attach_file", { session_id: r.session_id, token: r.token, name: "page.html", content: "<script>alert(1)</script>" });
  const routes = b.app.routes();
  assert.deepEqual(routes.filter((x) => x.method === "GET" && /file/i.test(x.path)), []);
  for (const p of [`/api/files/${r.session_id}/page.html`, `/files/page.html`, `/api/tools/get_room_file`, `/api/host/rooms/${r.session_id}/files/page.html`, `/s/${r.session_id}/files/page.html`]) {
    const res = await b.host("GET", p);
    assert.ok(!res.text.includes("<script>alert(1)</script>"), p);
    assert.ok(!/text\/html/.test(res.headers["content-type"] ?? "") || !res.text.includes("alert(1)"), p);
  }
  const get = await tool(b, b.host, "get_room_file", { session_id: r.session_id, token: r.token, name: "page.html" });
  assert.match(get.headers["content-type"], /^application\/json/);
  assert.equal(get.headers["x-content-type-options"], "nosniff");
});

test("the agent's loop through the whole stack: a provider asks for write_file, the file appears, the reply follows, the room shows what happened", async () => {
  const b = await up({ provider: writer("# From the agent") });
  const r = await room(b, { autoStart: true });
  const reply = await waitFor(async () => (await b.store.listEvents(r.session_id)).find((e) => e.kind === "agent_message"));
  assert.equal(reply.content, "I wrote notes.md.");
  const file = await b.store.getFile(r.session_id, "notes.md");
  assert.deepEqual([file.content, file.updated_by, file.on_behalf_of], ["# From the agent", "agent", "Maya"]);
  const lines = (await b.store.listEvents(r.session_id)).filter((e) => e.kind === "status").map((e) => e.content);
  assert.ok(lines.includes("Created notes.md, 16 bytes"), lines.join(" | "));
  assert.equal(b.provider.requests.length, 2, "one call for the tool, one for the answer");
  const first = JSON.parse(b.provider.requests[0].body);
  assert.deepEqual(first.tools.map((t) => t.function.name), ["list_files", "read_file", "write_file", "append_file"]);
  assert.ok(!b.provider.requests.some((q) => q.body.includes(KEY) || q.url.includes(KEY)));
});

test("a room started while sharing is on gets no tools: the provider is never offered any", { skip: lan ? false : "no network address" }, async () => {
  const b = await up({ share: true, provider: writer() });
  const r = await room(b, { autoStart: true });
  await waitFor(async () => (await b.store.listEvents(r.session_id)).find((e) => e.kind === "agent_message"));
  assert.ok(b.provider.requests.every((q) => !("tools" in JSON.parse(q.body))));
  assert.deepEqual(await b.store.listFiles(r.session_id), []);
  assert.strictEqual((await b.store.getSession(r.session_id)).files_enabled, false);
});

test("export includes the files with their history, and no token or key", async () => {
  const b = await up();
  const r = await room(b);
  for (const content of ["one", "two"]) await tool(b, b.host, "attach_file", { session_id: r.session_id, token: r.token, name: "doc.md", content });
  const out = await b.host("POST", "/api/data/export");
  const data = JSON.parse(out.text);
  const files = data.rooms[0].files;
  assert.deepEqual(files.map((f) => [f.name, f.version, f.content, f.versions.map((v) => v.content)]), [["doc.md", 2, "two", ["two", "one"]]]);
  assert.ok(!out.text.includes(r.token) && !out.text.includes(KEY));
});

test("deleting every room removes every file from the data file and replaces the key behind the old share links", async () => {
  const b = await up();
  const r = await room(b);
  const needle = "FILE-CONTENT-NEEDLE-0123456789";
  await tool(b, b.host, "attach_file", { session_id: r.session_id, token: r.token, name: "n.txt", content: needle });
  await tool(b, b.host, "attach_file", { session_id: r.session_id, token: r.token, name: "n.txt", content: needle + " v2" });
  const before = getInvite().derive(r.session_id, 1);
  const res = await b.host("POST", "/api/data/delete-rooms", { confirm: "delete all rooms" });
  assert.equal(res.status, 200, res.text);
  assert.equal(b.store._db.prepare("SELECT count(*) AS n FROM room_files").get().n, 0);
  assert.notEqual(getInvite().derive(r.session_id, 1), before, "old links stop working");
  const file = b.store.file;
  for (const f of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) assert.ok(!fs.readFileSync(f).includes(needle), path.basename(f));
});

test("Stop over HTTP: the host's token may press it, a guest's may not, and with nothing running it says so", { skip: lan ? false : "no network address" }, async () => {
  const b = await up({ share: true });
  const r = await room(b);
  const secret = new URL((await b.host("GET", `/api/host/rooms/${r.session_id}`)).json().share.link).hash.replace(/^#k=/, "");
  const joined = (await tool(b, b.guest, "join_session", { session_id: r.session_id, name: "Guest", invite: secret })).json();
  const guest = await tool(b, b.guest, "stop_agent", { session_id: r.session_id, token: joined.token });
  assert.deepEqual([guest.status, guest.json().code], [403, "NOT_ALLOWED"]);
  const host = await tool(b, b.host, "stop_agent", { session_id: r.session_id, token: r.token });
  assert.deepEqual([host.status, host.json()], [200, { stopped: false, dropped: 0 }]);
  assert.equal((await tool(b, b.host, "stop_agent", { session_id: r.session_id, token: "mpai_" + "b".repeat(43) })).status, 401);
});
