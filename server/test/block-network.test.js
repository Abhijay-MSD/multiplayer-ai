// Run: node --test test/   (no network)
// The test-only network blocker used by the smoke test does what it says, so that a pass
// under it means something.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const preload = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "helpers/block-network.cjs");

const run = (script) =>
  spawnSync(process.execPath, ["--require", preload, "--input-type=module", "-e", script], { encoding: "utf8", timeout: 20000 });

test("with the blocker, this computer still works and everything else is refused", () => {
  const r = run(`
    import http from "node:http"; import dns from "node:dns"; import net from "node:net";
    const server = http.createServer((q, s) => s.end("local ok")).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const port = server.address().port;
    const out = {};
    out.loopback = await (await fetch("http://127.0.0.1:" + port)).text();
    out.localhostName = await (await fetch("http://localhost:" + port)).text().catch((e) => "failed: " + e.cause?.code);
    out.fetchOutside = await fetch("https://example.com").then(() => "reached", (e) => e.cause?.code ?? e.message);
    out.httpsOutside = await fetch("http://93.184.216.34/").then(() => "reached", (e) => e.cause?.code ?? e.message);
    out.rawSocket = await new Promise((res) => net.connect(80, "93.184.216.34").once("error", (e) => res(e.code)).once("connect", () => res("reached")));
    out.lookup = await new Promise((res) => dns.lookup("example.com", (e) => res(e?.code ?? "resolved")));
    out.lookupPromise = await dns.promises.lookup("example.com").then(() => "resolved", (e) => e.code);
    console.log(JSON.stringify(out));
    process.exit(0);
  `);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
  assert.equal(out.loopback, "local ok");
  assert.equal(out.localhostName, "local ok");
  assert.equal(out.fetchOutside, "ENETBLOCKED");
  assert.equal(out.httpsOutside, "ENETBLOCKED");
  assert.equal(out.rawSocket, "ENETBLOCKED");
  assert.equal(out.lookup, "ENETBLOCKED");
  assert.equal(out.lookupPromise, "ENETBLOCKED");
});

test("with the blocker, this computer's own network address works too (sharing listens on it), and a neighbour's does not", () => {
  const own = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
  if (!own) return; // no network address on this computer: nothing to check
  const r = run(`
    import http from "node:http"; import net from "node:net";
    const server = http.createServer((q, s) => s.end("own ok")).listen(0, ${JSON.stringify(own)});
    await new Promise((r) => server.once("listening", r));
    const out = { own: await (await fetch("http://${own}:" + server.address().port)).text() };
    const parts = ${JSON.stringify(own)}.split(".");
    parts[3] = String((Number(parts[3]) % 250) + 2 === Number(parts[3]) ? 3 : (Number(parts[3]) % 250) + 2);
    out.neighbour = await new Promise((res) => net.connect(9, parts.join(".")).once("error", (e) => res(e.code)).once("connect", () => res("reached")));
    console.log(JSON.stringify(out));
    process.exit(0);
  `);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
  assert.equal(out.own, "own ok");
  assert.equal(out.neighbour, "ENETBLOCKED");
});

test("without the blocker, nothing is changed in this process (it is loaded only by being asked for)", async () => {
  const net = await import("node:net");
  assert.equal(net.default.Socket.prototype.connect.toString().includes("network blocked"), false);
});
