// WCAG AA check on theme token files. Reads web/src/themes/<id>/tokens.css,
// resolves each [data-theme][data-mode] block, and tests the pairs below.
// Run: node scripts/check-contrast.mjs
// This covers tokens only. The axe run in web/qa covers the rendered pages.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const themesDir = path.join(root, "web/src/themes");

const TEXT = 4.5;
const GRAPHIC = 3;

// [foreground, background, minimum ratio, note]
const PAIRS = [
  ["text", "bg", TEXT], ["text", "bg-sunk", TEXT], ["text", "surface", TEXT], ["text", "tint", TEXT],
  ["text-muted", "bg", TEXT], ["text-muted", "bg-sunk", TEXT], ["text-muted", "surface", TEXT], ["text-muted", "tint", TEXT],
  ["on-accent", "accent", TEXT],
  ["control", "bg", TEXT], ["link", "bg", TEXT], ["danger", "bg", TEXT], ["danger", "surface", TEXT],
  ["accent", "bg", GRAPHIC], ["focus", "bg", GRAPHIC], ["signal-a", "bg", GRAPHIC],
  ...[1, 2, 3, 4, 5].flatMap((n) => [
    [`identity-${n}`, "bg", TEXT], ["on-identity", `identity-${n}`, TEXT]
  ])
];

// Known gaps in the original Signal Room look, kept as shipped. Listed so the
// report is honest about them; remove an entry once the token is changed.
const ACCEPTED = new Set(["signal-room/light: focus on bg", "signal-room/light: accent on bg", "signal-room/light: signal-a on bg"]);

function parseHex(h) {
  const m = /^#([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

let failures = 0;
let checked = 0;
for (const id of fs.readdirSync(themesDir)) {
  const file = path.join(themesDir, id, "tokens.css");
  if (!fs.existsSync(file)) continue;
  const css = fs.readFileSync(file, "utf8");
  const blocks = {};
  for (const m of css.matchAll(/\[data-theme="([^"]+)"\]\[data-mode="(light|dark)"\]\s*\{([^}]*)\}/g)) {
    const vars = {};
    for (const d of m[3].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars[d[1]] = d[2].trim();
    blocks[m[2]] = vars;
  }
  for (const mode of ["light", "dark"]) {
    const vars = blocks[mode];
    if (!vars) {
      console.error(`${id}: no ${mode} block`);
      failures++;
      continue;
    }
    const get = (k) => {
      let v = vars[k];
      const ref = /^var\(--([\w-]+)\)$/.exec(v ?? "");
      return parseHex(ref ? vars[ref[1]] ?? "" : v ?? "");
    };
    for (const [fg, bg, min] of PAIRS) {
      const a = get(fg), b = get(bg);
      if (!a || !b) {
        console.error(`${id}/${mode}: cannot resolve ${fg} or ${bg}`);
        failures++;
        continue;
      }
      checked++;
      const r = ratio(a, b);
      if (r < min) {
        const key = `${id}/${mode}: ${fg} on ${bg}`;
        const accepted = ACCEPTED.has(key);
        console.log(`${accepted ? "known " : "FAIL  "} ${key}  ${r.toFixed(2)} < ${min}`);
        if (!accepted) failures++;
      }
    }
  }
}
console.log(failures ? `\n${failures} contrast failure(s) of ${checked} checks.` : `\nContrast check passed (${checked} token pairs).`);
process.exit(failures ? 1 : 0);
