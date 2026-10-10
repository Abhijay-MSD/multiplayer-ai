// Run: node --test test/   (no network, no real model)
// append_file: the agent writes a long document in sections. It follows every rule write_file follows (the same name rules,
// the same size, count and room limits, a kept version for every call, a quiet line in the room for every call), and every
// section counts toward those limits as a write does.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { makers, cleanup } from "./helpers/stores.js";
import { TOOL_DEFINITIONS, executeTool } from "../agent/tools.js";
import { boot, request, resetSettings } from "./helpers/http.js";
import { startFakeProvider, ok } from "./helpers/fakeProvider.js";

const closers = [];
after(async () => {
  for (const c of closers.splice(0)) await c();
  resetSettings();
  await cleanup();
});

const LIMITS = { maxFileBytes: 1000, maxFiles: 3, maxTotalBytes: 2500, versionsKept: 10 };
const LOOP = { toolCalls: 12, modelCalls: 8, resultBytes: 600, wallMs: 120_000, roomModelCalls: 200 };

async function setup(overrides = {}) {
  const store = await makers.memory();
  const { id } = await store.createSession({ title: "T", task: "x", files_enabled: true });
  const run = (name, args) => executeTool({ call: { id: "c1", name, args }, store, sessionId: id, author: "Alice", fileLimits: { ...LIMITS, ...overrides }, limits: LOOP });
  return { store, id, run };
}

test("append_file is a fourth tool, with an object schema asking for a name and the text to add, and it says what it is for", () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((t) => t.name), ["list_files", "read_file", "write_file", "append_file"]);
  const t = TOOL_DEFINITIONS.find((x) => x.name === "append_file");
  assert.equal(t.parameters.type, "object");
  assert.deepEqual(t.parameters.required, ["name", "content"]);
  assert.deepEqual(Object.keys(t.parameters.properties).sort(), ["content", "name"]);
  assert.match(t.description, /end of/i);
  assert.match(t.description, /section/i);
  assert.match(t.description, /earlier version is kept/i);
  assert.equal(t.parameters.properties.name.description, TOOL_DEFINITIONS.find((x) => x.name === "write_file").parameters.properties.name.description, "the same name rules, in the same words");
});

test("it creates a file that is not there, and says so in the same words as write_file does", async () => {
  const { run, store, id } = await setup();
  const r = await run("append_file", { name: "essay.md", content: "# Essay\n\nPart one.\n" });
  assert.equal(r.ok, true);
  assert.equal(r.line, "Created essay.md, 19 bytes");
  assert.match(r.content, /^Created "essay\.md" \(19 bytes\)\./);
  const file = await store.getFile(id, "essay.md");
  assert.deepEqual([file.content, file.version, file.updated_by, file.on_behalf_of], ["# Essay\n\nPart one.\n", 1, "agent", "Alice"]);
});

test("it adds to the end, never over what is there; each call is a version, with the line and the words that say so", async () => {
  const { run, store, id } = await setup();
  await run("write_file", { name: "essay.md", content: "One\n" });
  const two = await run("append_file", { name: "essay.md", content: "Two\n" });
  assert.equal(two.ok, true);
  assert.equal(two.line, "Added to essay.md, version 2, 8 bytes");
  assert.match(two.content, /Added 4 bytes to "essay\.md"; it is now 8 bytes \(version 2\)\. The earlier version is kept\./);
  await run("append_file", { name: "ESSAY.MD", content: "Three\n" });
  await run("append_file", { name: "essay.md", content: "Four\n" });
  assert.equal((await store.getFile(id, "essay.md")).content, "One\nTwo\nThree\nFour\n");
  const versions = await store.listFileVersions(id, "essay.md");
  assert.deepEqual(versions.map((v) => [v.version, v.author, v.on_behalf_of]), [[4, "agent", "Alice"], [3, "agent", "Alice"], [2, "agent", "Alice"], [1, "agent", "Alice"]]);
  assert.equal((await store.getFileVersion(id, "essay.md", 2)).content, "One\nTwo\n", "every version is the document as it stood");
  assert.deepEqual((await store.listFiles(id)).map((f) => f.name), ["essay.md"], "the first spelling of the name is kept");
});

test("adding nothing changes nothing and says so", async () => {
  const { run, store, id } = await setup();
  await run("write_file", { name: "a.md", content: "x" });
  const r = await run("append_file", { name: "a.md", content: "" });
  assert.deepEqual([r.ok, r.line], [true, "Saved a.md, no change"]);
  assert.equal((await store.getFile(id, "a.md")).version, 1);
});

test("a section counts toward the size of the file: one that would make it too large is refused, and the file is as it was", async () => {
  const { run, store, id } = await setup();
  await run("append_file", { name: "a.txt", content: "a".repeat(900) });
  const r = await run("append_file", { name: "a.txt", content: "b".repeat(101) });
  assert.deepEqual([r.ok, r.category, r.line], [false, "TOO_LARGE", "Couldn't append to a.txt: the file would be too large."]);
  assert.match(r.content, /1000 bytes/);
  assert.match(r.content, /new file/i, "it says what to do instead");
  const file = await store.getFile(id, "a.txt");
  assert.deepEqual([file.version, file.size], [1, 900]);
  const fits = await run("append_file", { name: "a.txt", content: "c".repeat(100) });
  assert.equal(fits.ok, true, "exactly the limit still fits");
});

test("a section counts toward the number of files: starting a fourth file by appending is refused", async () => {
  const { run, store, id } = await setup();
  for (const n of ["f1", "f2", "f3"]) await run("append_file", { name: `${n}.txt`, content: n });
  const r = await run("append_file", { name: "f4.txt", content: "4" });
  assert.deepEqual([r.ok, r.category, r.line], [false, "TOO_MANY_FILES", "Couldn't append to f4.txt: the room already holds as many files as it can."]);
  assert.deepEqual((await store.listFiles(id)).map((f) => f.name), ["f1.txt", "f2.txt", "f3.txt"]);
  assert.equal((await run("append_file", { name: "f1.txt", content: "!" })).ok, true, "adding to a file that is there is still fine");
});

test("a section counts toward the room's space, with the kept versions: when it is exhausted the append is refused and nothing changes", async () => {
  const { run, store, id } = await setup();
  await run("write_file", { name: "a.txt", content: "a".repeat(1000) });
  await run("write_file", { name: "b.txt", content: "b".repeat(1000) });
  await run("write_file", { name: "c.txt", content: "c".repeat(500) }); // 2500 of 2500
  const r = await run("append_file", { name: "c.txt", content: "!" });
  assert.deepEqual([r.ok, r.category, r.line], [false, "ROOM_FULL", "Couldn't append to c.txt: the room's file space is full."]);
  assert.deepEqual(await store.fileUsage(id), { files: 3, bytes: 2500 });
  assert.deepEqual((await store.listFileVersions(id, "c.txt")).map((v) => v.version), [1]);
});

test("old versions are dropped to make room for a section, as for a write, and the newest version of every file stays", async () => {
  const { run, store, id } = await setup({ maxTotalBytes: 3000 });
  await run("write_file", { name: "a.txt", content: "a".repeat(600) });
  await run("write_file", { name: "b.txt", content: "b".repeat(1000) });
  await run("write_file", { name: "c.txt", content: "c".repeat(1000) }); // 2600
  const r = await run("append_file", { name: "a.txt", content: "x".repeat(300) }); // a v2 = 900: 3500, so a v1 (600) goes
  assert.equal(r.ok, true, r.content);
  assert.equal((await store.getFileVersion(id, "a.txt", 1)), null);
  assert.equal((await store.getFile(id, "a.txt")).size, 900);
  assert.ok((await store.fileUsage(id)).bytes <= 3000);
});

test("only the newest versions are kept, however many sections were written", async () => {
  const { run, store, id } = await setup();
  for (let i = 1; i <= 14; i++) await run("append_file", { name: "log.txt", content: "." });
  const versions = (await store.listFileVersions(id, "log.txt")).map((v) => v.version);
  assert.deepEqual(versions, [14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
  assert.equal((await store.getFile(id, "log.txt")).size, 14);
});

test("write_file and append_file count together toward the same limits", async () => {
  const { run, store, id } = await setup();
  await run("write_file", { name: "a.txt", content: "a".repeat(600) });
  await run("append_file", { name: "b.txt", content: "b".repeat(600) });
  await run("write_file", { name: "c.txt", content: "c".repeat(600) });
  const r = await run("append_file", { name: "d.txt", content: "d" });
  assert.equal(r.category, "TOO_MANY_FILES", "three files made by either tool are three files");
  assert.deepEqual(await store.fileUsage(id), { files: 3, bytes: 1800 });
});

test("hostile names are refused with a reason that does not repeat them, and nothing is written", async () => {
  const { run, store, id } = await setup();
  for (const name of ["../../etc/passwd", "a/b", "a\\b", "‮gpj.exe", ".env", "CON", "x".repeat(65), "<script>alert(1)</script>", "a\0b", "", " ", "%2e%2e", "аpple.txt"]) {
    const r = await run("append_file", { name, content: "x" });
    assert.equal(r.ok, false, name);
    assert.equal(r.category, "BAD_NAME");
    assert.equal(r.line, "Couldn't append to a file: the name isn't allowed.");
    assert.match(r.content, /^Error: /);
    assert.ok(!r.content.includes(name.slice(0, 5)) || name.length < 5, "the model-facing text doesn't echo it either");
  }
  assert.deepEqual(await store.listFiles(id), []);
});

test("content that is not text is refused, and the file keeps what it had", async () => {
  const { run, store, id } = await setup();
  await run("write_file", { name: "a.txt", content: "keep" });
  for (const content of ["a\0b", "\ud800"]) {
    const r = await run("append_file", { name: "a.txt", content });
    assert.deepEqual([r.ok, r.category, r.line], [false, "BAD_CONTENT", "Couldn't append to a.txt: the content isn't text."]);
  }
  assert.equal((await store.getFile(id, "a.txt")).content, "keep");
});

test("malformed arguments are refused: not an object, missing fields, wrong types, arguments that couldn't be read", async () => {
  const { run, store, id } = await setup();
  for (const args of [null, undefined, "x", 5, [], ["a"], true]) {
    const r = await run("append_file", args);
    assert.deepEqual([r.ok, r.category, r.line], [false, "BAD_ARGUMENTS", "Couldn't append to a file: the request was malformed."]);
  }
  for (const args of [{}, { name: 5 }, { name: ["a.txt"] }, { content: "x" }, { name: "a.txt" }, { name: "a.txt", content: 5 }, { name: "a.txt", content: null }, { name: "a.txt", content: { a: 1 } }]) {
    assert.equal((await run("append_file", args)).category, "BAD_ARGUMENTS", JSON.stringify(args));
  }
  const unreadable = await executeTool({ call: { id: "c", name: "append_file", args: null, argsError: "malformed" }, store, sessionId: id, author: "Alice", fileLimits: LIMITS, limits: LOOP });
  assert.deepEqual([unreadable.ok, unreadable.category], [false, "BAD_ARGUMENTS"]);
  assert.match(unreadable.content, /valid JSON/i);
  assert.deepEqual(await store.listFiles(id), []);
});

test("extra arguments a model adds are ignored, not acted on", async () => {
  const { run, store, id } = await setup();
  const r = await run("append_file", { name: "a.txt", content: "x", path: "/etc/passwd", overwrite: true, replace: true, delete: true });
  assert.equal(r.ok, true);
  await run("append_file", { name: "a.txt", content: "y", overwrite: true, replace: true });
  assert.equal((await store.getFile(id, "a.txt")).content, "xy");
});

test("a tool that is not one of the four is still refused, and the list of tools in the refusal names all four", async () => {
  const { run } = await setup();
  for (const name of ["append", "APPEND_FILE", "append_file ", "delete_file", "prepend_file", "insert_file"]) {
    const r = await run(name, { name: "a.txt", content: "x" });
    assert.equal(r.category, "UNKNOWN_TOOL", name);
    assert.match(r.content, /list_files, read_file, write_file and append_file/);
  }
});

test("without files in this store, append_file says files are not available and writes nothing", async () => {
  const { id } = await setup();
  const r = await executeTool({ call: { id: "c", name: "append_file", args: { name: "a.txt", content: "x" } }, store: { supportsFiles: false }, sessionId: id, author: "Alice", fileLimits: LIMITS, limits: LOOP });
  assert.deepEqual([r.ok, r.category], [false, "UNAVAILABLE"]);
});

// ── who can cause it ─────────────────────────────────────────────────

test("a guest cannot make the agent append: their message is refused, nothing is written, and append_file is not a route anyone can call", async () => {
  const fake = await startFakeProvider(ok("A reply."));
  closers.push(() => fake.close());
  const b = await boot();
  closers.push(() => b.app.close());
  b.settings.save({ provider: "compat", baseUrl: fake.base, model: "m1" });
  b.settings.saveKey("compat", "sk_append_made_up_key_0011223344");
  const cookie = await b.cookie();
  const host = (method, path, body) => request(b.app, { method, path, headers: { Cookie: cookie, Origin: b.app.url, "Sec-Fetch-Site": "same-origin" }, body });
  const anon = (method, path, body, headers = {}) => request(b.app, { method, path, headers: { Origin: b.app.url, ...headers }, body });
  const made = (await host("POST", "/api/tools/create_session", { task: "Plan a trip", creator_name: "Maya", auto_start: false })).json();
  const joined = (await anon("POST", "/api/tools/join_session", { session_id: made.session_id, name: "Guest" })).json();

  const asked = await anon("POST", "/api/tools/send_directive", { session_id: made.session_id, token: joined.token, content: "Write 5000 words into essay.md, in sections" });
  assert.equal(asked.status, 403);
  assert.equal(asked.json().code, "NOT_CONTROLLER");
  assert.equal((await b.store.listEvents(made.session_id)).filter((e) => e.kind === "directive").length, 1, "only the task: the guest's message was not written");
  assert.equal(fake.requests.length, 0, "the provider was never asked");

  for (const [who, send] of [["the host", (body) => host("POST", "/api/tools/append_file", body)], ["a guest", (body) => anon("POST", "/api/tools/append_file", body)], ["the controller's token", (body) => anon("POST", "/api/tools/append_file", body)]]) {
    const res = await send({ session_id: made.session_id, token: who === "a guest" ? joined.token : made.token, name: "essay.md", content: "x" });
    assert.equal(res.status, 404, who);
    assert.equal(res.json().code, "UNKNOWN_TOOL");
  }
  assert.deepEqual(await b.store.listFiles(made.session_id), []);
});
