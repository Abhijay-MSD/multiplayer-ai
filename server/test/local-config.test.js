// Run: node --test test/   (no network)
// The settings that decide which storage is used and what a local copy checks at start.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { validateEnv } from "../env-check.js";
import { storeKind, createStoreFromEnv, asStore, createMemoryStore } from "../store/index.js";
import { createSupabaseStoreFromEnv } from "../store/supabase.js";
import { createLimits } from "../limits.js";
import { tempDir, cleanup } from "./helpers/stores.js";

after(cleanup);

test("storage is SQLite unless MULTIPLAYER_AI_STORE says otherwise, and a typo is refused by name", () => {
  assert.equal(storeKind({}), "sqlite");
  assert.equal(storeKind({ MULTIPLAYER_AI_STORE: "" }), "sqlite");
  assert.equal(storeKind({ MULTIPLAYER_AI_STORE: "Supabase" }), "supabase");
  assert.equal(storeKind({ MULTIPLAYER_AI_STORE: "memory" }), "memory");
  assert.throws(() => storeKind({ MULTIPLAYER_AI_STORE: "postgres" }), /MULTIPLAYER_AI_STORE must be one of sqlite, supabase, memory/);
});

test("a local copy needs no database settings and no model key to start", () => {
  const { errors, warnings } = validateEnv({}, { store: "sqlite" });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("a local copy still refuses settings that are wrong", () => {
  const { errors } = validateEnv({ PROVIDER: "nope", MULTIPLAYER_AI_PORT: "99999", MAX_STEPS_PER_SESSION: "abc" }, { store: "sqlite" });
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => /PROVIDER/.test(e)));
  assert.ok(errors.some((e) => /MULTIPLAYER_AI_PORT/.test(e)));
  assert.ok(errors.some((e) => /MAX_STEPS_PER_SESSION/.test(e)));
});

test("with no store named (the way the hosted setup always called it) the database settings are still required", () => {
  const { errors } = validateEnv({});
  assert.ok(errors.some((e) => /SUPABASE_URL is required/.test(e)));
  assert.ok(errors.some((e) => /GEMINI_API_KEY is required/.test(e)));
});

test("createStoreFromEnv opens a data file in MULTIPLAYER_AI_DATA_DIR", async () => {
  const dir = path.join(tempDir(), "mine");
  const store = await createStoreFromEnv({ MULTIPLAYER_AI_DATA_DIR: dir }, { externalPollMs: 0 });
  try {
    assert.equal(store.kind, "sqlite");
    assert.equal(store.file, path.join(dir, "multiplayer-ai.db"));
  } finally {
    await store.close();
  }
});

test("asStore leaves a store alone and wraps anything else as a Supabase client", async () => {
  const mem = createMemoryStore();
  assert.equal(asStore(mem), mem);
  const client = { from: () => ({}) };
  const wrapped = asStore(client);
  assert.equal(wrapped.kind, "supabase");
  assert.equal(asStore(client), wrapped, "the same wrapper each time");
  assert.throws(() => asStore(null), /No storage/);
});

test("the Supabase store says what it needs before it tries to load the library", async () => {
  await assert.rejects(createSupabaseStoreFromEnv({}), /needs SUPABASE_URL and SUPABASE_SERVICE_KEY/);
});

test("per-IP limits are off for a local copy unless set, and a person's pace limits stay on", () => {
  const off = createLimits({ env: {}, local: true });
  for (let i = 0; i < 200; i++) {
    off.checkCreate("203.0.113.9");
    off.checkJoin("203.0.113.9");
  }
  for (let i = 0; i < 6; i++) off.checkDirective("room", "Alice");
  assert.throws(() => off.checkDirective("room", "Alice"), (e) => e.code === "RATE_LIMITED");

  const on = createLimits({ env: { CREATE_LIMIT_PER_HOUR: "1", JOIN_LIMIT_PER_HOUR: "1" }, local: true });
  on.checkCreate("203.0.113.9");
  assert.throws(() => on.checkCreate("203.0.113.9"), (e) => e.code === "RATE_LIMITED");
  on.checkJoin("203.0.113.9");
  assert.throws(() => on.checkJoin("203.0.113.9"), (e) => e.code === "RATE_LIMITED");

  const hosted = createLimits({ env: {}, local: false });
  for (let i = 0; i < 5; i++) hosted.checkCreate("203.0.113.9");
  assert.throws(() => hosted.checkCreate("203.0.113.9"), (e) => e.code === "RATE_LIMITED", "hosted keeps its default of 5 an hour");
});

// ── the optional Supabase library ─────────────────────────────────────

import fs from "node:fs";
import { loadSupabaseLibrary, missingLibraryMessage } from "../store/supabase.js";

/** A folder shaped like supabase-lib with a stand-in library installed (CommonJS only, with an exports map, as the real one has). */
function fakeLibraryDir() {
  const dir = tempDir("multiplayer-ai-lib-");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", type: "module" }));
  const pkg = path.join(dir, "node_modules", "@supabase", "supabase-js");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@supabase/supabase-js", version: "0.0.0", main: "./index.cjs", exports: { ".": { require: "./index.cjs", default: "./index.cjs" } } }));
  fs.writeFileSync(path.join(pkg, "index.cjs"), "exports.createClient = (url, key) => ({ fromStandIn: true, url });\n");
  return dir;
}

test("the Supabase library is found in the supabase-lib folder when it is installed there", async () => {
  const dir = fakeLibraryDir();
  const createClient = await loadSupabaseLibrary({ dir });
  assert.deepEqual(createClient("https://x.example", "k"), { fromStandIn: true, url: "https://x.example" });
  const store = await createSupabaseStoreFromEnv({ SUPABASE_URL: "https://x.example", SUPABASE_SERVICE_KEY: "k" }, { dir });
  assert.equal(store.kind, "supabase");
  assert.equal(store.client.fromStandIn, true);
});

test("when the library is not installed the message gives the command that installs it, with the real folder", async () => {
  const dir = tempDir("multiplayer-ai-nolib-");
  await assert.rejects(loadSupabaseLibrary({ dir }), (e) => {
    assert.equal(e.message, missingLibraryMessage(dir));
    assert.match(e.message, /not installed by default/);
    assert.ok(e.message.includes(`cd "${dir}" && npm ci`), e.message);
    return true;
  });
});

test("the folder the message names is the real supabase-lib folder, which has a lockfile", async () => {
  const { LIBRARY_DIR } = await import("../store/supabase.js");
  assert.ok(LIBRARY_DIR.endsWith("supabase-lib/") || LIBRARY_DIR.endsWith("supabase-lib\\"));
  assert.ok(fs.existsSync(path.join(LIBRARY_DIR, "package-lock.json")), "npm ci needs a lockfile");
  assert.ok(fs.existsSync(path.join(LIBRARY_DIR, "package.json")));
});

// ── a data folder that can't be used says so, in words ────────────────

test("a data folder that can't be created is explained, with what to do about it", async () => {
  const base = tempDir();
  const blocker = path.join(base, "a-file");
  fs.writeFileSync(blocker, "not a folder");
  await assert.rejects(
    () => createStoreFromEnv({ MULTIPLAYER_AI_DATA_DIR: path.join(blocker, "inside") }),
    (e) => {
      assert.match(e.message, /^Multiplayer AI can't use its data folder, /);
      assert.match(e.message, /part of that path is a file, not a folder/);
      assert.match(e.message, /MULTIPLAYER_AI_DATA_DIR/);
      assert.doesNotMatch(e.message, /ENOTDIR|mkdir/, "no raw system error as the headline");
      return true;
    }
  );
});

test("a data folder you may not write to is explained too", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "needs a non-root POSIX user" : false }, async () => {
  const base = tempDir();
  const locked = path.join(base, "locked");
  fs.mkdirSync(locked, { mode: 0o500 });
  try {
    await assert.rejects(
      () => createStoreFromEnv({ MULTIPLAYER_AI_DATA_DIR: path.join(locked, "data") }),
      /^Error: Multiplayer AI can't use its data folder, .*isn't allowed to create or write there.*MULTIPLAYER_AI_DATA_DIR/s
    );
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});
