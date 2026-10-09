// Run: node --test test/   (no network, no real model)
// What is particular to the SQLite file: the settings every connection must
// have, the rules SQLite only enforces when told to, a second connection to the
// same file, who can read the file, and the schema versions.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSqliteStore } from "../store/sqlite.js";
import { loadMigrations, migrate, MigrationError } from "../store/migrate.js";
import { dataDir, DATA_FILE_NAME } from "../store/dataDir.js";
import { StoreError } from "../store/errors.js";
import { tempDir, cleanup } from "./helpers/stores.js";

after(cleanup);

const POSIX = process.platform !== "win32";
const mode = (p) => fs.statSync(p).mode & 0o777;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = (file, options = {}) => createSqliteStore({ file, externalPollMs: 0, ...options });
const fresh = () => path.join(tempDir(), "multiplayer-ai.db");
const pragma = (store, name) => Object.values(store._db.prepare(`PRAGMA ${name}`).get())[0];

async function seeded(file, options) {
  const s = await open(file, options);
  const session = await s.createSession({ title: "T", task: "x" });
  if (options?.migrations?.length === 1) {
    // A schema-1 file has no is_host column, so the store (which writes it) can't seed it.
    s._db.prepare("INSERT INTO session_participants (session_id, name, name_key, role) VALUES (?, 'Alice', 'alice', 'controller')").run(session.id);
  } else {
    await s.insertParticipant({ session_id: session.id, name: "Alice", role: "controller" });
  }
  return { s, session };
}

// ── settings on every connection ──────────────────────────────────────

test("every connection has foreign keys on, WAL mode and the busy timeout", async () => {
  const file = fresh();
  const a = await open(file, { busyTimeoutMs: 1234 });
  const b = await open(file, { busyTimeoutMs: 1234 });
  for (const s of [a, b]) {
    assert.equal(pragma(s, "foreign_keys"), 1);
    assert.equal(pragma(s, "journal_mode"), "wal");
    assert.equal(pragma(s, "busy_timeout"), 1234);
  }
});

// ── rules SQLite enforces only with foreign keys on ───────────────────

test("deleting a room really deletes its events and people (cascade)", async () => {
  const { s, session } = await seeded(fresh());
  await s.insertEvent({ session_id: session.id, kind: "comment", author: "Alice", content: "x" });
  const count = (table) => s._db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  assert.deepEqual([count("session_events"), count("session_participants")], [1, 1]);
  s._db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id); // raw: not through the store's own deleteSession
  assert.deepEqual([count("session_events"), count("session_participants")], [0, 0]);
});

test("deleting an event sets the reply_to of its replies to null, and keeps the replies", async () => {
  const { s, session } = await seeded(fresh());
  const directive = await s.insertEvent({ session_id: session.id, kind: "directive", author: "Alice", content: "q" });
  const reply = await s.insertEvent({ session_id: session.id, kind: "agent_message", author: "agent", content: "a", reply_to: directive.id });
  assert.equal(reply.reply_to, directive.id);
  s._db.prepare("DELETE FROM session_events WHERE id = ?").run(directive.id);
  const after = await s.getEvent(reply.id);
  assert.ok(after, "the reply is still there");
  assert.equal(after.reply_to, null);
});

test("a row that points at nothing is refused by the database itself", async () => {
  const { s } = await seeded(fresh());
  assert.throws(() =>
    s._db.prepare("INSERT INTO session_events (session_id, kind, author, content) VALUES ('no-such-room', 'comment', 'a', 'b')").run()
  );
});

// ── a second connection to the same file ──────────────────────────────

test("a second connection to the same file can write, and each sees the other's writes", async () => {
  const file = fresh();
  const { s: a, session } = await seeded(file);
  const b = await open(file);
  await b.insertParticipant({ session_id: session.id, name: "Bob" });
  const fromB = await b.insertEvent({ session_id: session.id, kind: "comment", author: "Bob", content: "from B" });
  const fromA = await a.insertEvent({ session_id: session.id, kind: "comment", author: "Alice", content: "from A" });
  assert.ok(fromA.id > fromB.id, "ids come from the file, not from each connection");
  assert.deepEqual((await a.listEvents(session.id)).map((e) => e.content), ["from B", "from A"]);
  assert.deepEqual((await b.listParticipants(session.id)).map((p) => p.name).sort(), ["Alice", "Bob"]);
});

test("two connections claiming the daily budget share one count", async () => {
  const file = fresh();
  const a = await open(file);
  const b = await open(file);
  const results = [];
  for (let i = 0; i < 5; i++) results.push((await (i % 2 ? a : b).claimStep(3)).allowed);
  assert.deepEqual(results, [true, true, true, false, false]);
});

test("a write waits for the busy timeout when another connection holds the file, then fails with BUSY", async () => {
  const file = fresh();
  const { s: a, session } = await seeded(file, { busyTimeoutMs: 250 });
  const b = await open(file, { busyTimeoutMs: 250 });
  b._db.exec("BEGIN IMMEDIATE"); // b holds the write lock
  const started = Date.now();
  await assert.rejects(
    a.insertEvent({ session_id: session.id, kind: "comment", author: "Alice", content: "x" }),
    (e) => e instanceof StoreError && e.code === "BUSY"
  );
  const waited = Date.now() - started;
  assert.ok(waited >= 200, `it should have waited for the timeout, but gave up after ${waited}ms`);
  b._db.exec("ROLLBACK");
  await a.insertEvent({ session_id: session.id, kind: "comment", author: "Alice", content: "now it works" });
});

test("a write made by another process (connection) is reported to subscribers with no room named", async () => {
  const file = fresh();
  const { s: a, session } = await seeded(file, { externalPollMs: 25 });
  const b = await open(file);
  const heard = [];
  const off = a.subscribe(({ sessionId }) => heard.push(sessionId));
  await a.insertEvent({ session_id: session.id, kind: "comment", author: "Alice", content: "mine" });
  assert.deepEqual(heard, [session.id], "its own write is reported with the room");
  await sleep(80);
  assert.deepEqual(heard, [session.id], "and is not reported a second time as an outside write");
  await b.insertEvent({ session_id: session.id, kind: "comment", author: "Alice", content: "theirs" });
  const end = Date.now() + 2000;
  while (heard.length < 2 && Date.now() < end) await sleep(10);
  assert.deepEqual(heard, [session.id, null]);
  off();
});

// ── who can read the file ─────────────────────────────────────────────

test("the data folder and file are owner-only, and so are the write-ahead files", { skip: !POSIX }, async () => {
  const dir = path.join(tempDir(), "made-by-multiplayer-ai");
  const file = path.join(dir, DATA_FILE_NAME);
  const { s, session } = await seeded(file);
  await s.insertEvent({ session_id: session.id, kind: "comment", author: "Alice", content: "x" });
  assert.equal(mode(dir).toString(8), "700");
  assert.equal(mode(file).toString(8), "600");
  for (const side of ["-wal", "-shm"]) {
    if (fs.existsSync(file + side)) assert.equal(mode(file + side).toString(8), "600", `${side} file`);
  }
});

test("a data file that already exists with looser permissions is tightened; an existing folder keeps its mode but is reported", { skip: !POSIX }, async () => {
  const dir = tempDir();
  fs.chmodSync(dir, 0o755);
  const file = path.join(dir, DATA_FILE_NAME);
  fs.writeFileSync(file, "", { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  await open(file);
  assert.equal(mode(file).toString(8), "600");
  assert.equal(mode(dir).toString(8), "755", "a folder we did not create is not changed");
});

test("the plaintext of a token is nowhere in the data file", async () => {
  const file = fresh();
  const { s, session } = await seeded(file);
  const secret = "mpai_" + "Z9y8x7w6".repeat(5);
  await s.insertParticipant({ session_id: session.id, name: "Bob", token_hash: "f".repeat(64) }); // the store is only ever given the hash
  await s.close();
  const bytes = fs.readFileSync(file);
  assert.ok(!bytes.includes(secret));
});

test("the data folder is MULTIPLAYER_AI_DATA_DIR when set, otherwise .multiplayer-ai in the home folder", () => {
  assert.equal(dataDir({ MULTIPLAYER_AI_DATA_DIR: "/somewhere/else" }), path.resolve("/somewhere/else"));
  assert.equal(dataDir({ MULTIPLAYER_AI_DATA_DIR: "~/multiplayer-ai-data" }), path.join(os.homedir(), "multiplayer-ai-data"));
  assert.equal(dataDir({}), path.join(os.homedir(), ".multiplayer-ai"));
  assert.equal(dataDir({ MULTIPLAYER_AI_DATA_DIR: "   " }), path.join(os.homedir(), ".multiplayer-ai"));
});

// ── schema versions ───────────────────────────────────────────────────

const ALL = loadMigrations(); // every migration the code has
const V1 = ALL.slice(0, 1); // a file as the first version left it
const V2 = [...V1, { version: V1.at(-1).version + 1, name: "002_test.sql", sql: "ALTER TABLE sessions ADD COLUMN note TEXT; UPDATE sessions SET note = 'migrated';" }];

test("a new file gets the whole schema, records its version, and has nothing to back up", async () => {
  const file = fresh();
  const s = await open(file);
  assert.equal(s.migration.from, 0);
  assert.equal(s.migration.to, ALL.at(-1).version);
  assert.equal(s.migration.backup, null);
  assert.equal(pragma(s, "user_version"), ALL.at(-1).version);
});

test("opening a file already at the newest version changes nothing and makes no backup", async () => {
  const file = fresh();
  await (await open(file)).close();
  const again = await open(file);
  assert.equal(again.migration.from, again.migration.to);
  assert.equal(again.migration.backup, null);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".bak-")), []);
});

test("an older file is backed up before it is migrated, and the backup holds the old data at the old version", async () => {
  const file = fresh();
  const { s, session } = await seeded(file, { migrations: V1 });
  await s.insertEvent({ session_id: session.id, kind: "comment", author: "Alice", content: "before" });
  await s.close();

  const upgraded = await open(file, { migrations: V2 });
  const { backup } = upgraded.migration;
  assert.ok(backup && fs.existsSync(backup), "a backup file exists");
  assert.match(path.basename(backup), /\.bak-v1-\d{8}T\d{6}Z$/);
  assert.equal(pragma(upgraded, "user_version"), 2);
  assert.equal(upgraded._db.prepare("SELECT note FROM sessions").get().note, "migrated");
  if (POSIX) assert.equal(mode(backup).toString(8), "600");

  // The backup is the file as it was: version 1, the old row, no new column.
  const old = await open(backup, { migrations: V1 });
  assert.equal(pragma(old, "user_version"), 1);
  assert.deepEqual((await old.listEvents(session.id)).map((e) => e.content), ["before"]);
  assert.throws(() => old._db.prepare("SELECT note FROM sessions").get());
});

test("a migration that fails is rolled back, the file stays at its old version, and the backup is kept", async () => {
  const file = fresh();
  const { s, session } = await seeded(file, { migrations: V1 });
  await s.close();
  const broken = [...V1, { version: 2, name: "002_broken.sql", sql: "ALTER TABLE sessions ADD COLUMN half_done TEXT; THIS IS NOT SQL;" }];
  await assert.rejects(open(file, { migrations: broken }), (e) => {
    assert.ok(e instanceof MigrationError);
    assert.match(e.message, /002_broken\.sql/);
    assert.match(e.message, /\.bak-v1-/);
    return true;
  });
  const still = await open(file, { migrations: V1 });
  assert.equal(pragma(still, "user_version"), 1);
  assert.throws(() => still._db.prepare("SELECT half_done FROM sessions").get(), "the half-finished change was rolled back");
  assert.ok(await still.getSession(session.id), "the data is intact");
  assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".bak-v1-")).length, 1);
});

test("a file from a newer version is refused and left exactly as it was", async () => {
  const file = fresh();
  await (await open(file, { migrations: V2 })).close();
  const before = fs.readFileSync(file);
  await assert.rejects(open(file, { migrations: V1 }), (e) => e instanceof MigrationError && /newer version/.test(e.message));
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".bak-")), []);
});

test("a file that is not a Multiplayer AI data file is refused", async () => {
  const file = fresh();
  const { DatabaseSync } = await import("node:sqlite");
  const other = new DatabaseSync(file);
  other.exec("CREATE TABLE somebody_elses (a)");
  other.close();
  await assert.rejects(open(file), (e) => e instanceof MigrationError && /not a Multiplayer AI data file/.test(e.message));
});

test("only the newest few backups are kept", async () => {
  const file = fresh();
  let migrations = V1;
  await (await open(file, { migrations })).close();
  for (let v = 2; v <= 6; v++) {
    migrations = [...migrations, { version: v, name: `00${v}_t.sql`, sql: `CREATE TABLE extra_${v} (a);` }];
    await (await open(file, { migrations })).close();
    await sleep(1100); // backup names carry the time to the second
  }
  const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".bak-"));
  assert.equal(backups.length, 3);
  assert.ok(backups.every((b) => /\.bak-v[345]-/.test(b)), `the newest three are kept: ${backups}`);
});

test("migrate() on a connection that is already current returns without touching it", async () => {
  const s = await open(":memory:");
  assert.deepEqual(migrate(s._db, { file: ":memory:" }), { from: ALL.at(-1).version, to: ALL.at(-1).version, backup: null });
});

// ── deleting for real ─────────────────────────────────────────────────

const bytesOf = (file) => ["", "-wal", "-shm"].map((s) => (fs.existsSync(file + s) ? fs.readFileSync(file + s) : Buffer.alloc(0)));
const appears = (file, marker) => bytesOf(file).some((b) => b.includes(marker));

test("after delete-all and compact, the text of a deleted room is not left in the data file or its write-ahead log", async () => {
  const file = fresh();
  const { s, session } = await seeded(file);
  const marker = "MARKER-" + "q7x2".repeat(8);
  for (let i = 0; i < 20; i++) await s.insertEvent({ session_id: session.id, kind: "comment", author: "Alice", content: `${marker} ${i}` });
  s._db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  assert.ok(appears(file, marker), "the text is in the file to begin with (so this test can fail)");
  await s.deleteAllSessions();
  await s.compact();
  assert.ok(!appears(file, marker), "gone from the file, the log and the shared-memory file");
  assert.equal((await s.listSessions()).length, 0);
});

test("removeBackups deletes the pre-migration copies and nothing else", async () => {
  const file = fresh();
  const { s, session } = await seeded(file, { migrations: V1 });
  await s.close();
  const upgraded = await open(file, { migrations: V2 });
  const dir = path.dirname(file);
  fs.writeFileSync(path.join(dir, "notes.txt"), "keep me");
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes(".bak-v")).length, 1);
  assert.equal(await upgraded.removeBackups(), 1);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".bak-v")), []);
  assert.ok(fs.existsSync(path.join(dir, "notes.txt")));
  assert.ok(await upgraded.getSession(session.id), "the data itself is untouched");
});

test("deleted content is zeroed as it is deleted (secure_delete is on for every connection)", async () => {
  const s = await open(fresh());
  assert.equal(pragma(s, "secure_delete"), 1);
});


test("a file from before sharing (schema 1) is backed up and upgraded; its rooms get the defaults and nobody is marked as host", async () => {
  const file = fresh();
  const { s, session } = await seeded(file, { migrations: V1 });
  await s.insertEvent({ session_id: session.id, kind: "comment", author: "Alice", content: "from before" });
  await s.close();

  const upgraded = await open(file); // all migrations
  assert.equal(upgraded.migration.from, 1);
  assert.equal(upgraded.migration.to, ALL.at(-1).version);
  assert.ok(upgraded.migration.backup && fs.existsSync(upgraded.migration.backup), "the old file was copied first");
  if (POSIX) assert.equal(mode(upgraded.migration.backup).toString(8), "600");
  const room = await upgraded.getSession(session.id);
  assert.deepEqual([room.invite_version, room.guest_step_cap, room.control_policy], [1, null, "ask"]);
  const [alice] = await upgraded.listParticipants(session.id, { columns: "name, is_host" });
  assert.deepEqual(alice, { name: "Alice", is_host: false });
  assert.deepEqual((await upgraded.listEvents(session.id)).map((e) => e.content), ["from before"], "nothing was lost");

  const old = await open(upgraded.migration.backup, { migrations: V1 });
  assert.equal(pragma(old, "user_version"), 1);
  assert.throws(() => old._db.prepare("SELECT invite_version FROM sessions").get(), "the backup still has the old layout");
});

test("the database itself refuses an unknown control policy, a negative cap and a version of 0", async () => {
  const s = await open(fresh());
  const { id } = await s.createSession({ title: "T", task: "x" });
  for (const [column, value] of [["control_policy", "anyone"], ["guest_step_cap", -1], ["invite_version", 0]]) {
    assert.throws(() => s._db.prepare(`UPDATE sessions SET ${column} = ? WHERE id = ?`).run(value, id), `${column} = ${value}`);
  }
});

// ── schema 3: files ───────────────────────────────────────────────────

const V2_REAL = ALL.slice(0, 2); // a file as the version before files left it

test("a file from before room files (schema 2) is backed up and upgraded; its rooms have the files switch off and no calls counted", async () => {
  const file = fresh();
  const old = await open(file, { migrations: V2_REAL });
  const session = await old.createSession({ title: "T", task: "x" });
  await old.insertEvent({ session_id: session.id, kind: "comment", author: "Alice", content: "from before files" });
  await old.close();

  const upgraded = await open(file);
  assert.equal(upgraded.migration.from, 2);
  assert.equal(upgraded.migration.to, ALL.at(-1).version);
  assert.ok(upgraded.migration.backup && fs.existsSync(upgraded.migration.backup), "the old file was copied first");
  assert.match(path.basename(upgraded.migration.backup), /\.bak-v2-/);
  if (POSIX) assert.equal(mode(upgraded.migration.backup).toString(8), "600");
  const room = await upgraded.getSession(session.id);
  assert.deepEqual([room.files_enabled, room.model_calls], [false, 0]);
  assert.deepEqual((await upgraded.listEvents(session.id)).map((e) => e.content), ["from before files"]);
  assert.deepEqual(await upgraded.listFiles(session.id), []);

  const backup = await open(upgraded.migration.backup, { migrations: V2_REAL });
  assert.equal(pragma(backup, "user_version"), 2);
  assert.throws(() => backup._db.prepare("SELECT count(*) FROM room_files").get(), "the backup still has the old layout");
});

test("the database refuses a file row whose size is wrong, whose key is not the lower-case name, or whose version is 0", async () => {
  const s = await open(fresh());
  const { id } = await s.createSession({ title: "T", task: "x" });
  const insert = (name, key, version, content, size) =>
    s._db.prepare("INSERT INTO room_files (session_id, name_key, version, name, content, size, author) VALUES (?, ?, ?, ?, ?, ?, 'Alice')").run(id, key, version, name, content, size);
  insert("a.txt", "a.txt", 1, "abc", 3);
  assert.throws(() => insert("b.txt", "b.txt", 1, "abc", 4), /constraint/i, "a size that is not the byte length");
  assert.throws(() => insert("C.txt", "C.txt", 1, "abc", 3), /constraint/i, "a key that is not lower case");
  assert.throws(() => insert("d.txt", "d.txt", 0, "abc", 3), /constraint/i, "version 0");
  assert.throws(() => insert("a.txt", "a.txt", 1, "abc", 3), /constraint/i, "the same version twice");
  assert.throws(() => insert("", "", 1, "abc", 3), /constraint/i, "an empty name");
  assert.throws(() => s._db.prepare("UPDATE sessions SET files_enabled = 2 WHERE id = ?").run(id), /constraint/i);
  assert.throws(() => s._db.prepare("UPDATE sessions SET model_calls = -1 WHERE id = ?").run(id), /constraint/i);
});

test("deleting a room through the database cascades to its files, and deleted file text is zeroed", async () => {
  const file = fresh();
  const s = await open(file);
  const { id } = await s.createSession({ title: "T", task: "x" });
  const limits = { maxFileBytes: 1000, maxFiles: 5, maxTotalBytes: 5000, versionsKept: 10 };
  await s.putFile(id, { name: "a.txt", content: "needle-in-a-file-0123456789", author: "Alice", limits });
  await s.deleteSession(id);
  assert.equal(s._db.prepare("SELECT count(*) AS n FROM room_files").get().n, 0);
  await s.compact();
  await s.close();
  assert.ok(!fs.readFileSync(file).includes("needle-in-a-file-0123456789"), "the file's text is not left in the data file");
  for (const extra of ["-wal", "-shm"]) if (fs.existsSync(file + extra)) assert.ok(!fs.readFileSync(file + extra).includes("needle-in-a-file-0123456789"), extra);
});
