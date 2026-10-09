// Run: node --test test/   (no network)
// The room invite secret, and the instance key it comes from.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInvite, INSTANCE_KEY_FILE } from "../invite.js";
import { createSettings, setSettings } from "../settings.js";
import { redact } from "../secrets.js";
import { tempDir, cleanup } from "./helpers/stores.js";

after(async () => {
  setSettings(createSettings({ dir: null }));
  await cleanup();
});
const POSIX = process.platform !== "win32";
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
const ROOM_A = "11111111-2222-4333-8444-555555555555";
const ROOM_B = "99999999-2222-4333-8444-555555555555";
const folder = () => path.join(tempDir("multiplayer-ai-invite-"), "data");

test("a secret is 43 URL-safe characters, the same every time for the same room and version", () => {
  const invite = createInvite({ dir: folder() });
  const a = invite.derive(ROOM_A, 1);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(invite.derive(ROOM_A, 1), a);
});

test("each room and each version has its own secret", () => {
  const invite = createInvite({ dir: folder() });
  const all = new Set([invite.derive(ROOM_A, 1), invite.derive(ROOM_A, 2), invite.derive(ROOM_B, 1), invite.derive(ROOM_B, 2)]);
  assert.equal(all.size, 4);
});

test("the same instance key gives the same secrets after a restart; a different folder gives different ones", () => {
  const dir = folder();
  const first = createInvite({ dir }).derive(ROOM_A, 1);
  assert.equal(createInvite({ dir }).derive(ROOM_A, 1), first);
  assert.notEqual(createInvite({ dir: folder() }).derive(ROOM_A, 1), first);
});

test("verify accepts the right secret for that room and version and nothing else", () => {
  const invite = createInvite({ dir: folder() });
  const secret = invite.derive(ROOM_A, 1);
  assert.equal(invite.verify(ROOM_A, 1, secret), true);
  assert.equal(invite.verify(ROOM_A, 2, secret), false, "the version moved on");
  assert.equal(invite.verify(ROOM_B, 1, secret), false, "another room");
  for (const bad of [undefined, null, "", "x", secret.slice(1), secret + "A", secret.toUpperCase(), 42, {}, [secret], "A".repeat(43), "../".repeat(20)]) {
    assert.equal(invite.verify(ROOM_A, 1, bad), false, JSON.stringify(bad)?.slice(0, 30));
  }
});

test("verify compares in constant time, and never throws on a secret of the wrong length", () => {
  const invite = createInvite({ dir: folder() });
  const secret = invite.derive(ROOM_A, 1);
  const real = crypto.timingSafeEqual;
  let calls = 0;
  crypto.timingSafeEqual = (...a) => (calls++, real(...a));
  try {
    assert.equal(invite.verify(ROOM_A, 1, "A".repeat(43)), false);
    assert.equal(calls, 1, "a same-length wrong secret is compared with timingSafeEqual");
    assert.doesNotThrow(() => invite.verify(ROOM_A, 1, "short"));
    assert.equal(invite.verify(ROOM_A, 1, secret), true);
  } finally {
    crypto.timingSafeEqual = real;
  }
});

test("the instance key is a file in the data folder, readable only by its owner, and made on first use", { skip: !POSIX }, () => {
  const dir = folder();
  const invite = createInvite({ dir });
  const file = path.join(dir, INSTANCE_KEY_FILE);
  assert.equal(fs.existsSync(file), false, "nothing is written until a secret is needed");
  invite.derive(ROOM_A, 1);
  assert.equal(mode(file), "600");
  assert.equal(mode(dir), "700");
  assert.equal(Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64").length, 32);
});

test("a damaged or short instance key file is not trusted: it is replaced, and the old secrets stop working", () => {
  const dir = folder();
  const before = createInvite({ dir }).derive(ROOM_A, 1);
  fs.writeFileSync(path.join(dir, INSTANCE_KEY_FILE), "not a key", { mode: 0o600 });
  const after_ = createInvite({ dir });
  const now = after_.derive(ROOM_A, 1);
  assert.notEqual(now, before);
  assert.equal(Buffer.from(fs.readFileSync(path.join(dir, INSTANCE_KEY_FILE), "utf8").trim(), "base64").length, 32);
});

test("rotating the key replaces the file (still owner-only, nothing left beside it) and every earlier secret stops working", { skip: !POSIX }, () => {
  const dir = folder();
  const invite = createInvite({ dir });
  const old = invite.derive(ROOM_A, 1);
  const oldKey = fs.readFileSync(path.join(dir, INSTANCE_KEY_FILE), "utf8");
  invite.rotate();
  const fresh = invite.derive(ROOM_A, 1);
  assert.notEqual(fresh, old);
  assert.equal(invite.verify(ROOM_A, 1, old), false);
  assert.equal(invite.verify(ROOM_A, 1, fresh), true);
  assert.notEqual(fs.readFileSync(path.join(dir, INSTANCE_KEY_FILE), "utf8"), oldKey);
  assert.equal(mode(path.join(dir, INSTANCE_KEY_FILE)), "600");
  assert.deepEqual(fs.readdirSync(dir), [INSTANCE_KEY_FILE], "no temporary file is left");
  assert.equal(createInvite({ dir }).derive(ROOM_A, 1), fresh, "and the new key is the one on disk");
});

test("the key and the secrets made from it are hidden from logs and error text", () => {
  setSettings(createSettings({ dir: null }));
  const dir = folder();
  const invite = createInvite({ dir });
  const secret = invite.derive(ROOM_A, 1);
  const key = fs.readFileSync(path.join(dir, INSTANCE_KEY_FILE), "utf8").trim();
  assert.ok(!redact(`link http://x/s/${ROOM_A}/join#k=${secret}`).includes(secret));
  assert.ok(!redact(`the key is ${key}`).includes(key));
  invite.rotate();
  assert.ok(!redact(`old ${secret}`).includes(secret), "an earlier secret stays hidden after rotation");
});

test("a share link's fragment is hidden from logs even for a secret this copy never made", () => {
  const unknown = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE";
  assert.ok(!redact(`GET /s/x/join#k=${unknown}`).includes(unknown));
  assert.ok(!redact(`invite=${unknown}`).includes(unknown));
});
