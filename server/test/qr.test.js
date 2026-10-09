// Run: node --test test/   (no network)
// The QR code drawn for a share link. On macOS the test also decodes it with CoreImage's QR detector (through
// scripts/decode-qr.swift) to prove it can really be read; elsewhere that part is skipped.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-generator";
import { qrSvg, MAX_QR_CHARS } from "../qr.js";
import { tempDir, cleanup } from "./helpers/stores.js";

after(cleanup);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LINK = "http://192.168.1.50:3737/s/11111111-2222-4333-8444-555555555555/join#k=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE";

test("the SVG is a black square pattern on white with a four-module quiet zone, sized and labelled", () => {
  const svg = qrSvg(LINK, { label: "Link to join the room" });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 (\d+) \1"/);
  assert.match(svg, /role="img" aria-label="Link to join the room"/);
  assert.match(svg, /<rect [^>]*fill="#ffffff"\/>/);
  assert.match(svg, /<path d="M\d+ \d+h1v1h-1z/);
  const size = Number(/viewBox="0 0 (\d+)/.exec(svg)[1]);
  const q = qrcode(0, "M");
  q.addData(LINK, "Byte");
  q.make();
  assert.equal(size, q.getModuleCount() + 8);
  const cells = [...svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(cells.every(([x, y]) => x >= 4 && y >= 4 && x < size - 4 && y < size - 4), "nothing is drawn in the quiet zone");
  const dark = new Set(cells.map(([x, y]) => `${x},${y}`));
  for (let r = 0; r < q.getModuleCount(); r++) for (let c = 0; c < q.getModuleCount(); c++) assert.equal(dark.has(`${c + 4},${r + 4}`), q.isDark(r, c));
});

test("a label cannot break out of the markup, and nothing but drawing instructions comes from the text", () => {
  const svg = qrSvg("hello", { label: '"><script>alert(1)</script>' });
  assert.ok(!svg.includes("<script"));
  assert.equal((svg.match(/</g) ?? []).length, 4, "svg, rect, path and the closing svg: no tag came from the label"); // tags only
  assert.ok(!svg.includes("hello"), "the text itself is not in the picture, only its pattern");
});

test("empty, non-text and over-long input is refused", () => {
  for (const bad of ["", undefined, null, 42, {}]) assert.throws(() => qrSvg(bad), /needs some text/);
  assert.throws(() => qrSvg("x".repeat(MAX_QR_CHARS + 1)), /too long/);
  assert.ok(qrSvg("x".repeat(MAX_QR_CHARS)).startsWith("<svg"));
});

test("the same text always gives the same picture", () => {
  assert.equal(qrSvg(LINK), qrSvg(LINK));
  assert.notEqual(qrSvg(LINK), qrSvg(LINK + "x"));
});

// ── decoding ─────────────────────────────────────────────────────────

const canDecode = process.platform === "darwin" && spawnSync("swift", ["--version"], { encoding: "utf8" }).status === 0;

/** Renders the SVG's modules to a PNG-free format CoreImage reads: a GIF from the same matrix would test the library, not our drawing, so draw a PBM-free bitmap ourselves from the SVG path. */
function bitmapFromSvg(svg, scale = 8) {
  const size = Number(/viewBox="0 0 (\d+)/.exec(svg)[1]);
  const w = size * scale;
  const px = Buffer.alloc(w * w * 3, 255);
  for (const m of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    const x0 = Number(m[1]) * scale;
    const y0 = Number(m[2]) * scale;
    for (let y = y0; y < y0 + scale; y++) for (let x = x0; x < x0 + scale; x++) px.fill(0, (y * w + x) * 3, (y * w + x) * 3 + 3);
  }
  return { w, px };
}

/** A minimal uncompressed BMP (CoreImage reads it). */
function bmp({ w, px }) {
  const rowBytes = Math.ceil((w * 3) / 4) * 4;
  const data = Buffer.alloc(rowBytes * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const src = ((w - 1 - y) * w + x) * 3; // BMP rows run bottom to top, pixels are BGR
    const dst = y * rowBytes + x * 3;
    data[dst] = px[src + 2]; data[dst + 1] = px[src + 1]; data[dst + 2] = px[src];
  }
  const head = Buffer.alloc(54);
  head.write("BM", 0); head.writeUInt32LE(54 + data.length, 2); head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14); head.writeInt32LE(w, 18); head.writeInt32LE(w, 22); head.writeUInt16LE(1, 26); head.writeUInt16LE(24, 28);
  head.writeUInt32LE(data.length, 34);
  return Buffer.concat([head, data]);
}

const decode = (text) => {
  const file = path.join(tempDir("multiplayer-ai-qr-"), "code.bmp");
  fs.writeFileSync(file, bmp(bitmapFromSvg(qrSvg(text))));
  const r = spawnSync("swift", [path.join(ROOT, "scripts/decode-qr.swift"), file], { encoding: "utf8", timeout: 120_000 });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
};

test("the code drawn for a share link decodes, with CoreImage, to exactly that link", { skip: canDecode ? false : "needs macOS with Swift", timeout: 240_000 }, () => {
  const r = decode(LINK);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, LINK);
});

test("codes for links of several lengths and characters all decode to what was put in", { skip: canDecode ? false : "needs macOS with Swift", timeout: 600_000 }, () => {
  for (const text of [
    "http://10.0.0.5:3737/s/00000000-0000-4000-8000-000000000000/join#k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "http://172.20.10.2:51234/s/ffffffff-ffff-4fff-bfff-ffffffffffff/join#k=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    "http://my-mac.local:3737/s/11111111-2222-4333-8444-555555555555/join#k=_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_",
    "http://192.168.1.2:80/",
    "x".repeat(150)
  ]) {
    const r = decode(text);
    assert.equal(r.status, 0, `${text.slice(0, 40)}: ${r.err}`);
    assert.equal(r.out, text);
  }
});

test("the decoder really can fail: an image with no code in it is not read as one", { skip: canDecode ? false : "needs macOS with Swift", timeout: 240_000 }, () => {
  const w = 120;
  const file = path.join(tempDir("multiplayer-ai-qr-"), "blank.bmp");
  fs.writeFileSync(file, bmp({ w, px: Buffer.alloc(w * w * 3, 255) }));
  const r = spawnSync("swift", [path.join(ROOT, "scripts/decode-qr.swift"), file], { encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), "");
});
