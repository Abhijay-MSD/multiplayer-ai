// Run: node --test test/   (no network, no real model)
// The rules for a room's files, stated once and run against every store that needs no outside service (memory, a SQLite
// file, in-memory SQLite). Files live in the store, never on disk, so no path is built from a name.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { makers, cleanup } from "./helpers/stores.js";
import { StoreError } from "../store/errors.js";

after(cleanup);

const LIMITS = { maxFileBytes: 1000, maxFiles: 5, maxTotalBytes: 3000, versionsKept: 10 };
const rejectsWith = (promise, code) => assert.rejects(promise, (e) => e instanceof StoreError && e.code === code, `expected a ${code} StoreError`);
const put = (s, id, name, content, extra = {}) => s.putFile(id, { name, content, author: "Alice", limits: LIMITS, ...extra });

for (const [name, make] of Object.entries(makers)) {
  const t = (title, fn) => test(`[${name}] files: ${title}`, async () => fn(await make()));
  const room = async (s) => (await s.createSession({ title: "T", task: "x" })).id;

  t("the store says it supports files", async (s) => assert.equal(s.supportsFiles, true));

  t("a new room has no files; a file is created at version 1 and read back exactly", async (s) => {
    const id = await room(s);
    assert.deepEqual(await s.listFiles(id), []);
    const { file, created } = await put(s, id, "notes.md", "# Plan\nline two\n");
    assert.equal(created, true);
    assert.deepEqual([file.name, file.version, file.size, file.updated_by], ["notes.md", 1, 16, "Alice"]);
    assert.match(file.updated_at, /^\d{4}-\d\d-\d\dT/);
    assert.equal("content" in file, false, "the list and the write result carry no content");
    const got = await s.getFile(id, "notes.md");
    assert.equal(got.content, "# Plan\nline two\n");
    assert.equal(got.version, 1);
    assert.deepEqual((await s.listFiles(id)).map((f) => f.name), ["notes.md"]);
  });

  t("size is counted in bytes, not characters", async (s) => {
    const id = await room(s);
    const { file } = await put(s, id, "u.txt", "héllo 中文 \u{1f600}");
    assert.equal(file.size, Buffer.byteLength("héllo 中文 \u{1f600}"));
  });

  t("writing again replaces the content as a new version; the old one is kept", async (s) => {
    const id = await room(s);
    await put(s, id, "plan.md", "one");
    const { file, created } = await put(s, id, "plan.md", "two!", { author: "Bob" });
    assert.equal(created, false);
    assert.deepEqual([file.version, file.updated_by, file.size], [2, "Bob", 4]);
    assert.equal((await s.getFile(id, "plan.md")).content, "two!");
    const versions = await s.listFileVersions(id, "plan.md");
    assert.deepEqual(versions.map((v) => [v.version, v.author, v.size]), [[2, "Bob", 4], [1, "Alice", 3]], "newest first");
    assert.equal((await s.getFileVersion(id, "plan.md", 1)).content, "one");
    assert.equal(await s.getFileVersion(id, "plan.md", 9), null);
  });

  t("writing the same content again makes no new version", async (s) => {
    const id = await room(s);
    await put(s, id, "a.txt", "same");
    const r = await put(s, id, "a.txt", "same");
    assert.equal(r.unchanged, true);
    assert.equal(r.file.version, 1);
    assert.equal((await s.listFileVersions(id, "a.txt")).length, 1);
  });

  t("an agent write can say whose directive it served", async (s) => {
    const id = await room(s);
    const { file } = await put(s, id, "a.txt", "x", { author: "agent", onBehalfOf: "Alice" });
    assert.deepEqual([file.updated_by, file.on_behalf_of], ["agent", "Alice"]);
    assert.equal((await s.getFile(id, "a.txt")).on_behalf_of, "Alice");
  });

  t("at most 10 versions of a file are kept; the oldest go first and version numbers never repeat", async (s) => {
    const id = await room(s);
    for (let i = 1; i <= 13; i++) await put(s, id, "log.txt", `v${i}`);
    const versions = await s.listFileVersions(id, "log.txt");
    assert.equal(versions.length, 10);
    assert.deepEqual([versions[0].version, versions.at(-1).version], [13, 4]);
    assert.equal(await s.getFileVersion(id, "log.txt", 3), null);
    assert.equal((await s.getFile(id, "log.txt")).version, 13);
  });

  t("names are unique ignoring letter case, and the first spelling is kept", async (s) => {
    const id = await room(s);
    await put(s, id, "Notes.md", "a");
    const r = await put(s, id, "NOTES.MD", "b");
    assert.equal(r.created, false);
    assert.equal(r.file.name, "Notes.md");
    assert.equal((await s.listFiles(id)).length, 1);
    assert.equal((await s.getFile(id, "notes.md")).content, "b");
    assert.equal((await s.getFile(id, "nOtEs.Md")).name, "Notes.md");
  });

  t("hostile names and content are refused by the store itself", async (s) => {
    const id = await room(s);
    for (const bad of ["../x", "a/b", "a\\b", ".hidden", "CON", "a\0b", "‮x", "", "x".repeat(65), undefined, 5]) {
      await rejectsWith(put(s, id, bad, "x"), "CONSTRAINT");
    }
    for (const bad of ["a\0b", "\ud800", undefined, null, 7]) await rejectsWith(put(s, id, "ok.txt", bad), "CONSTRAINT");
    assert.deepEqual(await s.listFiles(id), [], "nothing was written");
  });

  t("a file over the size limit is refused, and exactly the limit is allowed", async (s) => {
    const id = await room(s);
    await put(s, id, "max.txt", "x".repeat(1000));
    await rejectsWith(put(s, id, "big.txt", "x".repeat(1001)), "FILE_TOO_LARGE");
    await rejectsWith(put(s, id, "max.txt", "é".repeat(501)), "FILE_TOO_LARGE", "the limit is in bytes");
    assert.equal((await s.getFile(id, "max.txt")).version, 1);
  });

  t("a room holds at most the allowed number of files; replacing one is still allowed", async (s) => {
    const id = await room(s);
    for (let i = 0; i < 5; i++) await put(s, id, `f${i}.txt`, "x");
    await rejectsWith(put(s, id, "f5.txt", "x"), "TOO_MANY_FILES");
    await put(s, id, "F0.txt", "changed");
    assert.equal((await s.listFiles(id)).length, 5);
  });

  t("the room's total is capped; history is dropped oldest-first to make room, and the current files are never dropped", async (s) => {
    const id = await room(s);
    await put(s, id, "a.txt", "a".repeat(1000));
    await put(s, id, "b.txt", "b".repeat(1000));
    await put(s, id, "a.txt", "A".repeat(1000)); // total 3000: a v1, b v1, a v2
    assert.deepEqual(await s.fileUsage(id), { files: 2, bytes: 3000 });
    await put(s, id, "b.txt", "B".repeat(1000)); // needs 1000 more: a v1 (the oldest history) goes
    assert.equal(await s.getFileVersion(id, "a.txt", 1), null);
    assert.equal((await s.getFile(id, "a.txt")).content, "A".repeat(1000));
    assert.equal((await s.getFile(id, "b.txt")).content, "B".repeat(1000));
    assert.ok((await s.fileUsage(id)).bytes <= 3000);
    await put(s, id, "c.txt", "c".repeat(1000)); // history is gone; this would be 3 current files = 3000: still fits
    await rejectsWith(put(s, id, "d.txt", "d".repeat(1000)), "ROOM_FULL");
    assert.deepEqual((await s.listFiles(id)).map((f) => f.name), ["a.txt", "b.txt", "c.txt"], "a refused write changed nothing");
    assert.equal((await s.getFile(id, "c.txt")).content, "c".repeat(1000));
  });

  t("replacing a file when the room is full drops that file's old version to make room; adding another file is refused and changes nothing", async (s) => {
    const id = await room(s);
    for (const n of ["a", "b", "c"]) await put(s, id, `${n}.txt`, n.repeat(1000));
    await put(s, id, "a.txt", "z".repeat(1000));
    assert.equal((await s.getFile(id, "a.txt")).content, "z".repeat(1000));
    assert.deepEqual((await s.listFileVersions(id, "a.txt")).map((v) => v.version), [2], "version 1 was dropped for the space");
    await rejectsWith(put(s, id, "d.txt", "d"), "ROOM_FULL");
    assert.equal((await s.getFile(id, "b.txt")).content, "b".repeat(1000));
    assert.deepEqual(await s.fileUsage(id), { files: 3, bytes: 3000 });
  });

  t("a file can be deleted, with its history, and the name can be used again from version 1", async (s) => {
    const id = await room(s);
    await put(s, id, "a.txt", "1");
    await put(s, id, "a.txt", "2");
    assert.equal(await s.deleteFile(id, "A.TXT"), true);
    assert.equal(await s.deleteFile(id, "a.txt"), false);
    assert.equal(await s.getFile(id, "a.txt"), null);
    assert.deepEqual(await s.listFileVersions(id, "a.txt"), []);
    assert.equal((await put(s, id, "a.txt", "again")).file.version, 1);
  });

  t("rooms do not see each other's files", async (s) => {
    const a = await room(s);
    const b = await room(s);
    await put(s, a, "secret.txt", "only in a");
    assert.deepEqual(await s.listFiles(b), []);
    assert.equal(await s.getFile(b, "secret.txt"), null);
    assert.equal(await s.deleteFile(b, "secret.txt"), false);
    await put(s, b, "secret.txt", "in b");
    assert.equal((await s.getFile(a, "secret.txt")).content, "only in a");
  });

  t("deleting a room, or every room, deletes its files and their history", async (s) => {
    const a = await room(s);
    const b = await room(s);
    await put(s, a, "x.txt", "1");
    await put(s, a, "x.txt", "2");
    await put(s, b, "y.txt", "1");
    await s.deleteSession(a);
    assert.deepEqual(await s.listFiles(a), []);
    assert.deepEqual(await s.fileUsage(a), { files: 0, bytes: 0 });
    assert.equal((await s.listFiles(b)).length, 1);
    await s.deleteAllSessions();
    assert.deepEqual(await s.listFiles(b), []);
  });

  t("a write to a room that does not exist is refused", async (s) => {
    await rejectsWith(put(s, "00000000-0000-0000-0000-000000000000", "a.txt", "x"), "CONSTRAINT");
  });

  t("two writes at once to one file both land, as two versions", async (s) => {
    const id = await room(s);
    await put(s, id, "race.txt", "0");
    await Promise.all(Array.from({ length: 6 }, (_, i) => put(s, id, "race.txt", `w${i}`)));
    const versions = await s.listFileVersions(id, "race.txt");
    assert.deepEqual(versions.map((v) => v.version), [7, 6, 5, 4, 3, 2, 1]);
  });

  // ── append: the same rules, in the same transaction as the write ───

  const add = (s, id, name, content, extra = {}) => s.putFile(id, { name, content, append: true, author: "Agent", onBehalfOf: "Alice", limits: LIMITS, ...extra });

  t("append creates a file that is not there, and adds to the end of one that is, as a new version each time", async (s) => {
    const id = await room(s);
    const first = await add(s, id, "essay.md", "One\n");
    assert.deepEqual([first.created, first.unchanged, first.file.version, first.file.size], [true, false, 1, 4]);
    const second = await add(s, id, "ESSAY.md", "Two\n");
    assert.deepEqual([second.created, second.file.name, second.file.version, second.file.size, second.file.updated_by, second.file.on_behalf_of], [false, "essay.md", 2, 8, "Agent", "Alice"]);
    assert.equal((await s.getFile(id, "essay.md")).content, "One\nTwo\n");
    assert.equal((await s.getFileVersion(id, "essay.md", 1)).content, "One\n");
    assert.equal((await put(s, id, "essay.md", "whole\n")).file.version, 3, "a write after an append carries on from it");
  });

  t("append of nothing changes nothing", async (s) => {
    const id = await room(s);
    await put(s, id, "a.txt", "x");
    const r = await add(s, id, "a.txt", "");
    assert.deepEqual([r.unchanged, r.file.version], [true, 1]);
  });

  t("append counts toward the size of one file: the whole file is checked, not only the piece", async (s) => {
    const id = await room(s);
    await add(s, id, "a.txt", "a".repeat(900));
    await rejectsWith(add(s, id, "a.txt", "b".repeat(101)), "FILE_TOO_LARGE");
    assert.equal((await s.getFile(id, "a.txt")).size, 900, "a refused append changed nothing");
    assert.equal((await add(s, id, "a.txt", "c".repeat(100))).file.size, 1000);
    await rejectsWith(add(s, id, "new.txt", "n".repeat(1001)), "FILE_TOO_LARGE");
  });

  t("append counts toward the number of files, and toward the room's total with its kept versions", async (s) => {
    const id = await room(s);
    for (const n of ["a", "b", "c", "d", "e"]) await add(s, id, `${n}.txt`, n);
    await rejectsWith(add(s, id, "f.txt", "f"), "TOO_MANY_FILES");
    assert.equal((await add(s, id, "a.txt", "more")).created, false);

    const full = await room(s);
    await put(s, full, "a.txt", "a".repeat(1000));
    await put(s, full, "b.txt", "b".repeat(1000));
    await put(s, full, "c.txt", "c".repeat(500)); // 2500 of 3000
    await put(s, full, "d.txt", "d".repeat(500)); // 3000 of 3000
    await rejectsWith(add(s, full, "d.txt", "!"), "ROOM_FULL");
    assert.deepEqual(await s.fileUsage(full), { files: 4, bytes: 3000 }, "nothing changed");
    assert.deepEqual((await s.listFileVersions(full, "d.txt")).map((v) => v.version), [1]);
  });

  t("append keeps only the newest versions, like a write", async (s) => {
    const id = await room(s);
    for (let i = 0; i < 13; i++) await add(s, id, "log.txt", ".");
    assert.deepEqual((await s.listFileVersions(id, "log.txt")).map((v) => v.version), [13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
  });

  t("append refuses a hostile name and text that is not text, and changes nothing", async (s) => {
    const id = await room(s);
    await put(s, id, "a.txt", "keep");
    for (const name of ["../x", "a/b", ".env", "CON", "a\0b", ""]) await rejectsWith(add(s, id, name, "x"), "CONSTRAINT");
    await rejectsWith(add(s, id, "a.txt", "a\0b"), "CONSTRAINT");
    await rejectsWith(add(s, id, "a.txt", "\ud800"), "CONSTRAINT");
    assert.equal((await s.getFile(id, "a.txt")).content, "keep");
    await rejectsWith(add(s, "00000000-0000-0000-0000-000000000000", "a.txt", "x"), "CONSTRAINT");
  });

  t("many appends at once to one file all land, in some order, none lost and none doubled", async (s) => {
    const id = await room(s);
    await add(s, id, "race.txt", "0|");
    await Promise.all(Array.from({ length: 6 }, (_, i) => add(s, id, "race.txt", `w${i}|`)));
    const got = (await s.getFile(id, "race.txt")).content;
    assert.deepEqual(got.split("|").filter(Boolean).sort(), ["0", "w0", "w1", "w2", "w3", "w4", "w5"]);
    assert.equal((await s.getFile(id, "race.txt")).version, 7);
  });

  t("rooms have a files switch (off unless asked) and a count of model calls", async (s) => {
    const off = await s.createSession({ title: "T", task: "x" });
    assert.strictEqual(off.files_enabled, false);
    assert.strictEqual(off.model_calls, 0);
    const on = await s.createSession({ title: "T", task: "x", files_enabled: true });
    assert.strictEqual(on.files_enabled, true);
    await s.updateSession(on.id, { files_enabled: false, model_calls: 4 });
    const row = await s.getSession(on.id);
    assert.strictEqual(row.files_enabled, false);
    assert.strictEqual(row.model_calls, 4);
    await assert.rejects(s.updateSession(on.id, { model_calls: -1 }), StoreError);
  });

  t("file writes count as activity in the room", async (s) => {
    const id = await room(s);
    const before = (await s.getSession(id)).updated_at;
    await new Promise((r) => setTimeout(r, 5));
    await put(s, id, "a.txt", "x");
    assert.ok((await s.getSession(id)).updated_at > before);
  });
}
