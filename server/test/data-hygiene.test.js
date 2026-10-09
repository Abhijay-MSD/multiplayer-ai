// Run: node --test test/   (no network)
// Multiplayer AI's data folder holds the saved key, the room secret (instance.key) and every room. If someone keeps it
// inside the project, neither git nor a Docker build may pick it up.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROBES = [
  "settings.json", "instance.key", "multiplayer-ai.db", "multiplayer-ai.db-wal", "multiplayer-ai.db-shm", "multiplayer-ai.db.bak-v1-20261008T120000Z",
  "data/settings.json", "server/data/instance.key", ".multiplayer-ai/multiplayer-ai.db", "web/.env", "server/.env.local"
];

// The part of the Docker ignore syntax this file uses: a leading "**/" (any depth), "*" within a name, and plain names; a pattern also covers what is under it.
function dockerIgnores(patterns, file) {
  return patterns.some((p) => {
    const anyDepth = p.startsWith("**/");
    const body = (anyDepth ? p.slice(3) : p).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
    const re = new RegExp(`^${anyDepth ? "(?:.*/)?" : ""}${body}(?:/.*)?$`);
    return re.test(file);
  });
}

test("a data file kept inside the project is ignored by git", () => {
  for (const file of PROBES) {
    const r = spawnSync("git", ["check-ignore", "-q", "--no-index", file], { cwd: ROOT });
    assert.equal(r.status, 0, `${file} must be ignored by .gitignore`);
  }
});

test("a data file kept inside the project is not sent to a Docker build", () => {
  const patterns = fs.readFileSync(path.join(ROOT, ".dockerignore"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  for (const file of PROBES) assert.ok(dockerIgnores(patterns, file), `${file} must be excluded by .dockerignore`);
  assert.ok(!dockerIgnores(patterns, "server/server.js"), "the matcher does not exclude everything");
});
