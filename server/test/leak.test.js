// Run: node --test test/   (no network beyond this computer)
// A key must not come out anywhere, and a room must never be shown what a provider said.
//
// The providers here are stand-ins that do what real ones sometimes do: answer an error
// with the request repeated back (the Authorization header, the body, the account name).
// The adapters, the step queue, the room and the routes are the real ones. The key is a
// made-up string; nothing here uses a real key.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { boot, request, resetSettings } from "./helpers/http.js";
import { startFakeProvider, echoError, fail, drop, ok } from "./helpers/fakeProvider.js";
import { cleanup } from "./helpers/stores.js";
import { CATEGORY_MESSAGES } from "../providers/failure.js";

const KEY = "sk_made_up_leak_test_key_Zq81Lm40Vb99";
const ACCOUNT = "acme-corp-account-7781";
const closers = [];
after(async () => {
  for (const c of closers.splice(0)) await c();
  resetSettings();
  await cleanup();
});

/** Records what the console prints while `fn` runs. Nothing redacts it: this is what the code itself wrote. */
async function captured(fn) {
  const lines = [];
  const originals = {};
  for (const m of ["log", "info", "warn", "error", "debug"]) {
    originals[m] = console[m];
    console[m] = (...args) => lines.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  }
  try {
    return [await fn(), lines.join("\n")];
  } finally {
    Object.assign(console, originals);
  }
}

async function until(cond, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const dataFileBytes = (store) =>
  ["", "-wal", "-shm"].map((s) => (fs.existsSync(store.file + s) ? fs.readFileSync(store.file + s) : Buffer.alloc(0)));

/** A running copy set up for an OpenAI-compatible provider at `provider`, with KEY saved. */
async function setUp(provider) {
  const b = await boot();
  closers.push(() => b.app.close());
  b.settings.save({ provider: "compat", baseUrl: provider.base, model: "m1" });
  b.settings.saveKey("compat", KEY);
  return b;
}
const startRoom = async (b) =>
  (await request(b.app, { method: "POST", path: "/api/tools/create_session", body: { task: "Plan a trip", creator_name: "Maya", auto_start: true } })).json();
const statusLine = async (b, id) =>
  until(async () => (await b.store.listEvents(id)).find((e) => e.kind === "status" && /^Agent could not reply/.test(e.content)));

// ── what a room is shown ──────────────────────────────────────────────

const CASES = [
  ["a bad key", () => echoError(401, { account: ACCOUNT }), "BAD_KEY"],
  ["an unknown model", () => fail(404, `The model m1 does not exist for ${ACCOUNT}`), "MODEL_NOT_FOUND"],
  ["a provider that is down", () => fail(500, `Internal error for ${ACCOUNT}`), "BUSY"],
  ["a dropped connection", () => drop(), "NETWORK"],
  ["an error nobody recognises", () => fail(400, `Weird thing about ${ACCOUNT} and ${KEY}`), "UNKNOWN"]
];

for (const [title, handler, category] of CASES) {
  test(`${title}: the room is shown the category message only, and the host's terminal gets the detail without the key`, async () => {
    const provider = await startFakeProvider(handler());
    closers.push(() => provider.close());
    const b = await setUp(provider);
    const [room, terminal] = await captured(async () => {
      const r = await startRoom(b);
      await statusLine(b, r.session_id);
      return r;
    });

    // What every participant can read: the events, as the room serves them to a guest.
    const guest = (await request(b.app, { method: "POST", path: "/api/tools/join_session", body: { session_id: room.session_id, name: "Guest" } })).json();
    const seen = JSON.stringify(guest.events);
    const line = guest.events.find((e) => e.kind === "status" && /^Agent could not reply/.test(e.content));
    assert.equal(line.content, `Agent could not reply: ${CATEGORY_MESSAGES[category]}`);
    assert.ok(!seen.includes(ACCOUNT), "the account name is not in the room");
    assert.ok(!seen.includes(KEY), "the key is not in the room");
    assert.ok(!/authorization|bearer/i.test(seen), "no header text is in the room");

    // The host's terminal: the category, and (except for a plain network drop) what the provider said, with the key hidden.
    assert.ok(terminal.includes(category), terminal);
    assert.ok(!terminal.includes(KEY), "the key is not in the terminal output");
    if (category !== "NETWORK") assert.ok(terminal.includes(ACCOUNT), "the host can still read what the provider said");
  });
}

test("the room's own step-cap message is unchanged (it is ours, not a provider's)", async () => {
  // Covered in steering.test.js; here only that a category is not substituted for it.
  assert.ok(!Object.values(CATEGORY_MESSAGES).some((m) => /step limit/.test(m)));
});

// ── the key, everywhere ───────────────────────────────────────────────

test("a key echoed by a failing provider is in no log line, no room event, no HTTP response and not in the data file", async () => {
  const provider = await startFakeProvider(echoError(401, { account: ACCOUNT }));
  closers.push(() => provider.close());
  const b = await setUp(provider);
  const cookie = await b.cookie();
  const responses = [];
  const [, terminal] = await captured(async () => {
    const room = await startRoom(b);
    responses.push(JSON.stringify(room));
    await statusLine(b, room.session_id);
    const call = async (method, route, body) => {
      const res = await request(b.app, { method, path: route, headers: { Cookie: cookie, Origin: b.app.url }, body });
      responses.push(res.text);
      return res;
    };
    await call("GET", "/api/settings");
    await call("POST", "/api/settings/key/test", { provider: "compat", key: KEY, base_url: provider.base, model: "m1" });
    await call("POST", "/api/settings/key/test", { provider: "compat", base_url: provider.base, model: "m1" });
    await call("PUT", "/api/settings/key", { provider: "compat", key: KEY });
    await call("PUT", "/api/settings/key", { provider: "compat", key: "bad key with spaces " + KEY });
    await call("POST", "/api/data/export");
    responses.push(JSON.stringify(await b.store.listEvents(room.session_id)));
    responses.push(JSON.stringify(await b.store.listParticipants(room.session_id)));
  });
  assert.ok(!terminal.includes(KEY), "console output");
  for (const r of responses) assert.ok(!r.includes(KEY), "a response or stored event contained the key");
  for (const bytes of dataFileBytes(b.store)) assert.ok(!bytes.includes(KEY), "the rooms' data file");
  // The one place it is supposed to be: the settings file, readable only by its owner.
  assert.ok(fs.readFileSync(path.join(b.dir, "settings.json"), "utf8").includes(KEY));
});

test("Groq: an error that repeats the request does not put the key in a room or the terminal", async () => {
  const b = await boot();
  closers.push(() => b.app.close());
  b.settings.save({ provider: "groq" });
  b.settings.saveKey("groq", KEY);
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("api.groq.com")) return real(url, init);
    return new Response(
      JSON.stringify({ error: { message: `Invalid key for ${ACCOUNT}. Sent: ${init.headers.Authorization}`, type: "invalid_request_error", code: "invalid_api_key", failed_generation: KEY } }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  };
  try {
    const [room, terminal] = await captured(async () => {
      const r = await startRoom(b);
      await statusLine(b, r.session_id);
      return r;
    });
    const events = JSON.stringify(await b.store.listEvents(room.session_id));
    assert.ok(!events.includes(KEY) && !events.includes(ACCOUNT));
    assert.ok(!terminal.includes(KEY), terminal);
    assert.match(events, /didn't accept the API key/);
  } finally {
    globalThis.fetch = real;
  }
});

test("Gemini: an error that repeats the request does not put the key in a room or the terminal", async () => {
  const b = await boot();
  closers.push(() => b.app.close());
  b.settings.save({ provider: "gemini" });
  b.settings.saveKey("gemini", KEY);
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("generativelanguage.googleapis.com")) return real(url, init);
    const sent = new Headers(init.headers).get("x-goog-api-key");
    return new Response(
      JSON.stringify({ error: { code: 403, message: `Permission denied for ${ACCOUNT}: x-goog-api-key: ${sent} at ${url}`, status: "PERMISSION_DENIED" } }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  };
  try {
    const [room, terminal] = await captured(async () => {
      const r = await startRoom(b);
      await statusLine(b, r.session_id);
      return r;
    });
    const events = JSON.stringify(await b.store.listEvents(room.session_id));
    assert.ok(!events.includes(KEY) && !events.includes(ACCOUNT));
    assert.ok(!terminal.includes(KEY), terminal);
    assert.match(events, /didn't accept the API key/);
  } finally {
    globalThis.fetch = real;
  }
});

test("the key reaches the provider in a header only: never in the address, the body or a query", async () => {
  const provider = await startFakeProvider(ok("fine"));
  closers.push(() => provider.close());
  const b = await setUp(provider);
  const room = await startRoom(b);
  await until(async () => (await b.store.listEvents(room.session_id)).find((e) => e.kind === "agent_message"));
  for (const req of provider.requests) {
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.ok(!req.url.includes(KEY));
    assert.ok(!req.body.includes(KEY));
    assert.ok(!Object.entries(req.headers).some(([k, v]) => k !== "authorization" && String(v).includes(KEY)));
  }
});

test("no process is started with the key as an argument, and none inherits it from Multiplayer AI beyond the environment it was given", async () => {
  // Multiplayer AI starts no child process except the browser opener, which gets only the address.
  const { openCommand } = await import("../../scripts/start.mjs");
  const [cmd, args] = openCommand("http://127.0.0.1:3737/?admin=ONE-TIME-CODE");
  assert.ok(!JSON.stringify([cmd, args]).includes(KEY));
  const sources = ["../server.js", "../local.js", "../http.js", "../key-test.js", "../admin-routes.js"].map((f) => fs.readFileSync(new URL(f, import.meta.url), "utf8")).join("\n");
  assert.ok(!/child_process|spawn\(|exec\(|execFile/.test(sources), "the server code starts no other programs");
});
