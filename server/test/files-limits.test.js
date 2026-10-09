// Run: node --test test/   (no network)
// The limits on room files and on the agent's tool loop: defaults, what a blank or bad value does, and that every one is
// documented and listed in both .env.example files.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../config.js";
import { validateEnv } from "../env-check.js";
import { fileLimits, loopLimits, FILE_SETTINGS } from "../files/limits.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("the defaults are the ones the brief names", () => {
  assert.deepEqual(fileLimits({}), { maxFileBytes: 200 * 1024, maxFiles: 50, maxTotalBytes: 2048 * 1024, versionsKept: 10 });
  assert.deepEqual(loopLimits({}), { toolCalls: 12, modelCalls: 8, resultBytes: 20 * 1024, wallMs: 120_000, roomModelCalls: 200 });
});

test("a setting is read in the unit its name says", () => {
  const f = fileLimits({ MAX_FILE_KB: "10", MAX_FILES_PER_ROOM: "3", MAX_ROOM_FILES_KB: "64" });
  assert.deepEqual([f.maxFileBytes, f.maxFiles, f.maxTotalBytes], [10240, 3, 65536]);
  const l = loopLimits({ TOOL_CALLS_PER_DIRECTIVE: "2", MODEL_CALLS_PER_DIRECTIVE: "3", TOOL_RESULT_KB: "1", DIRECTIVE_SECONDS: "5", MODEL_CALLS_PER_ROOM: "9" });
  assert.deepEqual(l, { toolCalls: 2, modelCalls: 3, resultBytes: 1024, wallMs: 5000, roomModelCalls: 9 });
});

test("a blank, zero, negative or fractional value falls back to the default (validateEnv refuses it first, at startup)", () => {
  for (const bad of ["", " ", "0", "-3", "1.5", "abc"]) {
    assert.equal(fileLimits({ MAX_FILES_PER_ROOM: bad }).maxFiles, 50, bad);
    assert.equal(loopLimits({ TOOL_CALLS_PER_DIRECTIVE: bad }).toolCalls, 12, bad);
  }
});

test("validateEnv names every bad file or loop setting, and accepts blanks and good values", () => {
  const names = ["MAX_FILE_KB", "MAX_FILES_PER_ROOM", "MAX_ROOM_FILES_KB", "TOOL_CALLS_PER_DIRECTIVE", "MODEL_CALLS_PER_DIRECTIVE", "TOOL_RESULT_KB", "DIRECTIVE_SECONDS", "MODEL_CALLS_PER_ROOM"];
  assert.deepEqual(validateEnv(Object.fromEntries(names.map((n) => [n, ""])), { store: "sqlite" }).errors, []);
  assert.deepEqual(validateEnv(Object.fromEntries(names.map((n) => [n, "5"])), { store: "sqlite" }).errors, []);
  for (const n of names) {
    for (const bad of ["abc", "0", "-1", "2.5"]) {
      const { errors } = validateEnv({ [n]: bad }, { store: "sqlite" });
      assert.ok(errors.some((e) => e.startsWith(`${n}:`)), `${n}=${bad}`);
    }
  }
});

test("a single file can't be allowed to be larger than a room's total, and nothing absurd is accepted", () => {
  let { errors } = validateEnv({ MAX_FILE_KB: "300", MAX_ROOM_FILES_KB: "100" }, { store: "sqlite" });
  assert.ok(errors.some((e) => e.startsWith("MAX_FILE_KB:") && /MAX_ROOM_FILES_KB/.test(e)));
  ({ errors } = validateEnv({ MAX_FILE_KB: "300" }, { store: "sqlite" }));
  assert.deepEqual(errors, [], "300 KB is under the default room total of 2048 KB");
  ({ errors } = validateEnv({ MAX_FILE_KB: "20000" }, { store: "sqlite" }));
  assert.ok(errors.some((e) => e.startsWith("MAX_FILE_KB:")), "above the ceiling");
  ({ errors } = validateEnv({ MODEL_CALLS_PER_DIRECTIVE: "1000", TOOL_CALLS_PER_DIRECTIVE: "5000", DIRECTIVE_SECONDS: "999999", MAX_FILES_PER_ROOM: "100000" }, { store: "sqlite" }));
  assert.equal(errors.length, 4);
});

test("each setting has a default in config.js, is in both .env.example files, and is described in docs/limits.md", () => {
  const rootEnv = read(".env.example");
  const serverEnv = read("server/.env.example");
  const limits = read("docs/limits.md");
  for (const name of FILE_SETTINGS) {
    assert.ok(name in DEFAULTS, `${name} has a default`);
    assert.match(rootEnv, new RegExp(`^${name}=$`, "m"), `${name} in .env.example`);
    assert.match(serverEnv, new RegExp(`^${name}=$`, "m"), `${name} in server/.env.example`);
    assert.ok(limits.includes(`\`${name}\``), `${name} in docs/limits.md`);
    assert.ok(limits.includes(String(DEFAULTS[name])), `its default appears in docs/limits.md`);
  }
});
