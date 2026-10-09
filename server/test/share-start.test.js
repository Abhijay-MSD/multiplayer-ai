// Run: node --test test/   (no network beyond this computer)
// Starting Multiplayer AI shared: MULTIPLAYER_AI_SHARE=wifi (what `npm start -- --share=wifi` sets), the address a container is
// told to share, and that sharing is never remembered.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { start } from "../local.js";
import { validateEnv } from "../env-check.js";
import { lanAddress, resetSettings } from "./helpers/http.js";
import { cleanup, tempDir } from "./helpers/stores.js";

const closers = [];
after(async () => {
  for (const c of closers.splice(0)) await c();
  resetSettings();
  await cleanup();
});
const lan = lanAddress();
const nic = (address, name = "en0") => ({ [name]: [{ address, family: "IPv4", internal: false }] });

async function run(env = {}, options = {}) {
  const lines = [];
  const data = path.join(tempDir("multiplayer-ai-share-"), "d");
  const app = await start({ env: { MULTIPLAYER_AI_NO_DOTENV: "1", MULTIPLAYER_AI_DATA_DIR: data, ...env }, port: 0, log: (l) => lines.push(l), ...options });
  closers.push(async () => (await app.close(), await app.store.close()));
  return { app, lines, text: () => lines.join("\n"), data };
}

test("by default nothing is shared", async () => {
  const r = await run();
  assert.equal(r.app.sharing.status().active, false);
  assert.doesNotMatch(r.text(), /Sharing (is on|was not)|container/);
});

test("MULTIPLAYER_AI_SHARE=wifi with one usable address shares on it, and the terminal names the address but no room link or secret", { skip: lan ? false : "no non-loopback address" }, async () => {
  const r = await run({ MULTIPLAYER_AI_SHARE: "wifi" }, { interfaces: () => nic(lan) });
  const status = r.app.sharing.status();
  assert.deepEqual([status.active, status.address], [true, lan]);
  assert.match(r.text(), new RegExp(`Sharing is on for ${lan.replace(/\./g, "\\.")}`));
  assert.match(r.text(), /plain http/i);
  assert.doesNotMatch(r.text(), /#k=|\/join|invite/i);
});

test("with several usable addresses it does not guess: nothing is shared and the host is told to choose in Settings", async () => {
  const r = await run({ MULTIPLAYER_AI_SHARE: "wifi" }, { interfaces: () => ({ ...nic("192.168.1.9"), eth0: [{ address: "10.0.0.7", family: "IPv4", internal: false }] }) });
  assert.equal(r.app.sharing.status().active, false);
  assert.match(r.text(), /more than one network address/i);
  assert.match(r.text(), /192\.168\.1\.9/);
  assert.match(r.text(), /10\.0\.0\.7/);
  assert.match(r.text(), /Settings/);
});

test("with no usable address nothing is shared and it says why", async () => {
  const r = await run({ MULTIPLAYER_AI_SHARE: "wifi" }, { interfaces: () => ({ lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }] }) });
  assert.equal(r.app.sharing.status().active, false);
  assert.match(r.text(), /no network address/i);
});

test("an address in an unusual range is never chosen automatically", async () => {
  const r = await run({ MULTIPLAYER_AI_SHARE: "wifi" }, { interfaces: () => nic("169.254.8.8") });
  assert.equal(r.app.sharing.status().active, false);
  assert.match(r.text(), /Settings/);
});

test("MULTIPLAYER_AI_SHARE=local is the default spelled out, and anything else is refused by name before starting", async () => {
  assert.equal((await run({ MULTIPLAYER_AI_SHARE: "local" })).app.sharing.status().active, false);
  const { errors } = validateEnv({ MULTIPLAYER_AI_SHARE: "internet" }, { store: "sqlite" });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /MULTIPLAYER_AI_SHARE/);
  assert.match(errors[0], /wifi, local/);
  assert.deepEqual(validateEnv({ MULTIPLAYER_AI_SHARE: "wifi" }, { store: "sqlite" }).errors, []);
  assert.deepEqual(validateEnv({ MULTIPLAYER_AI_SHARE: "" }, { store: "sqlite" }).errors, []);
  await assert.rejects(run({ MULTIPLAYER_AI_SHARE: "everywhere" }), /MULTIPLAYER_AI_SHARE/);
});

test("sharing is never remembered: a start with the same data folder begins on this computer only", { skip: lan ? false : "no non-loopback address" }, async () => {
  const first = await run({ MULTIPLAYER_AI_SHARE: "wifi" }, { interfaces: () => nic(lan) });
  assert.equal(first.app.sharing.status().active, true);
  await first.app.close();
  await first.app.store.close();
  const again = await start({ env: { MULTIPLAYER_AI_NO_DOTENV: "1", MULTIPLAYER_AI_DATA_DIR: first.data }, port: 0, log: () => {} });
  closers.push(async () => (await again.close(), await again.store.close()));
  assert.equal(again.sharing.status().active, false);
});

test("Supabase storage ignores the request to share, with a plain message", async () => {
  const { makeFakeSupabase } = await import("./fakeSupabase.js");
  const { asStore } = await import("../store/index.js");
  const { startHttp } = await import("../http.js");
  const store = asStore(makeFakeSupabase({ sessions: [], session_events: [], session_participants: [] }));
  const app = await startHttp({ store, profile: "local", env: { MULTIPLAYER_AI_SHARE: "wifi" }, port: 0, log: () => {} });
  closers.push(() => app.close());
  assert.equal(app.sharing.status().active, false);
});

// ── in a container ───────────────────────────────────────────────────

test("in a container the host's address is the only extra Host accepted, and it is set from MULTIPLAYER_AI_SHARE_ADDRESS", async () => {
  const r = await run({ MULTIPLAYER_AI_CONTAINER: "1", MULTIPLAYER_AI_SHARE_ADDRESS: "192.168.1.20", MULTIPLAYER_AI_PUBLIC_PORT: "3737" }, { detectContainer: () => true });
  const status = r.app.sharing.status();
  assert.deepEqual([status.container, status.active, status.shareName], [true, true, "192.168.1.20"]);
  assert.equal(status.url, "http://192.168.1.20:3737");
  assert.match(r.text(), /Sharing is on for 192\.168\.1\.20/);
});

test("in a container with no address given, it counts as shared anyway and says the host should enter one", async () => {
  const r = await run({ MULTIPLAYER_AI_CONTAINER: "1" }, { detectContainer: () => true });
  const status = r.app.sharing.status();
  assert.deepEqual([status.active, status.shareName, status.url], [true, null, null]);
  assert.match(r.text(), /container/i);
  assert.match(r.text(), /enter the address/i);
});

test("a bad address for a container is refused with the reason, and the container still counts as shared", async () => {
  for (const bad of ["8.8.8.8", "evil.example", "192.168.1.20:3737", "http://192.168.1.20"]) {
    const r = await run({ MULTIPLAYER_AI_CONTAINER: "1", MULTIPLAYER_AI_SHARE_ADDRESS: bad }, { detectContainer: () => true });
    const status = r.app.sharing.status();
    assert.deepEqual([status.active, status.shareName], [true, null], bad);
    assert.match(r.text(), /MULTIPLAYER_AI_SHARE_ADDRESS/);
  }
});

test("outside a container MULTIPLAYER_AI_SHARE_ADDRESS does nothing, with a note", async () => {
  const r = await run({ MULTIPLAYER_AI_SHARE_ADDRESS: "192.168.1.20" });
  assert.equal(r.app.sharing.status().shareName, null);
  assert.equal(r.app.sharing.status().active, false);
  assert.match(r.text(), /MULTIPLAYER_AI_SHARE_ADDRESS is only used inside a container/);
});

test("a container with Supabase storage is refused, because the host controls need the local data file", async () => {
  const { makeFakeSupabase } = await import("./fakeSupabase.js");
  const { asStore } = await import("../store/index.js");
  const { startHttp } = await import("../http.js");
  const store = asStore(makeFakeSupabase({ sessions: [], session_events: [], session_participants: [] }));
  await assert.rejects(startHttp({ store, profile: "local", env: {}, port: 0, container: true, log: () => {} }), /Container mode needs the local data file/);
});
