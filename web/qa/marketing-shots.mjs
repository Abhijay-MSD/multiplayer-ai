// Renders the real room, from the recorded session, in every theme and mode,
// plus three crops for the landing page's story. Output: web/public/marketing.
//   npm run qa:marketing-shots      (starts its own dev server on port 5198)
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "..");
const out = path.join(web, "public/marketing");
const recording = JSON.parse(fs.readFileSync(path.join(web, "src/marketing/recorded-session.json"), "utf8"));
const themes = fs
  .readdirSync(path.join(web, "src/themes"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

// Whoever holds control at the end of the recording.
let controller = null;
for (const e of recording.events) {
  if (e.kind === "join" && controller === null) controller = e.author;
  if (e.kind === "takeover") controller = e.author;
}

fs.mkdirSync(out, { recursive: true });
const server = await createServer({ root: web, server: { port: 5198, strictPort: true }, logLevel: "error" });
await server.listen();
const base = "http://localhost:5198";
const browser = await chromium.launch();

async function open(theme, mode, query, dsf = 1) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dsf, reducedMotion: "reduce" });
  await ctx.addInitScript(([t, m]) => {
    localStorage.setItem("multiplayer-ai:theme", t);
    localStorage.setItem("multiplayer-ai:mode", m);
  }, [theme, mode]);
  const page = await ctx.newPage();
  await page.goto(`${base}/__fixture/room?fixture=recorded-session&as=${encodeURIComponent(controller)}${query}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  return { page, ctx };
}

for (const theme of themes) {
  for (const mode of ["light", "dark"]) {
    const { page, ctx } = await open(theme, mode, "");
    await page.screenshot({ path: path.join(out, `room-${theme}-${mode}.jpg`), type: "jpeg", quality: 82 });
    await ctx.close();
  }
}

const crops = [
  ["step-start", "&upto=2", { x: 0, y: 0, width: 1140, height: 520 }],
  ["step-share", "", { x: 1000, y: 110, width: 440, height: 440 }],
  ["step-steer", "", { x: 0, y: 260, width: 1140, height: 640 }]
];
for (const [name, query, clip] of crops) {
  const { page, ctx } = await open("signal-room", "light", query, 2);
  await page.screenshot({ path: path.join(out, `${name}.png`), clip });
  await ctx.close();
}

await browser.close();
await server.close();
console.log(`Wrote ${themes.length * 2 + crops.length} images to ${path.relative(web, out)}`);
