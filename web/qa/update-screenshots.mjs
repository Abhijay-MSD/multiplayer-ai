// The one command that replaces the tracked screenshots in web/qa/screenshots.
// Run it from web/: npm run qa:update-screenshots
// (A plain test run writes to web/qa/.results/screenshots instead, which git ignores.)
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(npx, ["playwright", "test", "screenshots.spec.js"], {
  cwd: here,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, UPDATE_SCREENSHOTS: "1" }
});
process.exit(result.status ?? 1);
