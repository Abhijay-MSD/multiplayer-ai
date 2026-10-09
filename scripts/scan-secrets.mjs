// Looks for strings shaped like keys in three places: the files git tracks, everything git history ever added, and the
// built web app (web/dist). It reports WHERE (the place, the file, the line, and the name of the pattern) and never
// WHAT: no part of a match is printed.
//
//   node scripts/scan-secrets.mjs           run it from inside the repository
//
// Exit 0 when nothing is found, 1 when something is. A match is a prefix plus enough characters after it to look
// like a real key, so words that merely contain the letters (task-force, a test's made_up_gsk_key) are not matches:
//   gsk_             a Groq-style key
//   AIza             a Google API key
//   sb_secret_       a Supabase secret key
//   sb_publishable_  a Supabase publishable key
//   eyJ              a JSON Web Token (three dot-separated parts that start eyJ): the form of Supabase's older keys
//   sk-              a key in the form several providers use
// This is a net, not a proof: a key in another shape, split over lines, or encoded gets through.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const B = "(?<![A-Za-z0-9_])"; // not in the middle of a longer word
export const PATTERNS = [
  { name: "gsk_", re: new RegExp(`${B}gsk_[A-Za-z0-9]{20,}`, "g") },
  { name: "AIza", re: new RegExp(`${B}AIza[0-9A-Za-z_-]{30,}`, "g") },
  { name: "sb_secret_", re: new RegExp(`${B}sb_secret_[A-Za-z0-9_-]{20,}`, "g") },
  { name: "sb_publishable_", re: new RegExp(`${B}sb_publishable_[A-Za-z0-9_-]{20,}`, "g") },
  { name: "eyJ", re: new RegExp(`(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`, "g") },
  { name: "sk-", re: new RegExp(`(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}`, "g") }
];

const digest = (s) => createHash("sha256").update(s).digest("hex"); // kept in memory to tell two matches apart; never printed

/** Matches in one line: [{ pattern, id }]. `id` identifies the value without being it. */
export function matchesIn(line) {
  const out = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of line.matchAll(re)) out.push({ pattern: name, id: digest(m[0]) });
  }
  return out;
}

const git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString().trim()}`);
  return r.stdout;
};
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

function scanText(text, onHit) {
  let n = 0;
  for (const line of text.split("\n")) {
    n += 1;
    if (line.length < 20) continue;
    for (const m of matchesIn(line)) onHit(n, m);
  }
}

function trackedFiles(root) {
  const hits = [];
  for (const rel of git(["ls-files", "-z"], root).toString("utf8").split("\0").filter(Boolean)) {
    const file = path.join(root, rel);
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch {
      continue; // listed but gone from disk
    }
    if (isBinary(buf)) continue;
    scanText(buf.toString("utf8"), (line, m) => hits.push({ scope: "tracked file", file: rel, where: `${rel}:${line}`, pattern: m.pattern }));
  }
  return hits;
}

function history(root) {
  const log = git(["log", "--all", "--no-color", "--unified=0", "--no-renames", "--format=commit %h", "-p"], root).toString("utf8");
  const found = new Map(); // one report per (file, value): the oldest commit that added it
  let commit = "";
  let file = "";
  let line = 0;
  for (const text of log.split("\n")) {
    if (text.startsWith("commit ")) commit = text.slice(7).trim();
    else if (text.startsWith("+++ ")) file = text.startsWith("+++ b/") ? text.slice(6) : "";
    else if (text.startsWith("@@")) line = Number(/\+(\d+)/.exec(text)?.[1] ?? 1) - 1;
    else if (text.startsWith("+") && file) {
      line += 1;
      if (text.length < 21) continue;
      for (const m of matchesIn(text.slice(1))) found.set(`${file}\0${m.id}`, { scope: "history", file, where: `${commit} ${file}:${line}`, pattern: m.pattern });
    }
  }
  return [...found.values()];
}

function builtApp(root) {
  const dist = path.join(root, "web", "dist");
  if (!fs.existsSync(dist)) return { hits: [], note: "web/dist: not built, so not scanned. Run `npm run build` and scan again." };
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|mjs|css|html|map|json|txt|svg)$/i.test(e.name)) {
        scanText(fs.readFileSync(full, "utf8"), (line, m) => hits.push({ scope: "built app", file: path.relative(root, full).split(path.sep).join("/"), where: `${path.relative(root, full).split(path.sep).join("/")}:${line}`, pattern: m.pattern }));
      }
    }
  };
  walk(dist);
  return { hits, note: null };
}

const ALLOW_FILE = "scripts/scan-secrets-allow.json";

/**
 * Known made-up values (a test's pretend key): { file, pattern, reason }, each one an exact path. Allowed matches are still
 * listed. An entry that matches nothing is an error, so the list can't quietly outlive what it excuses.
 */
function loadAllow(root) {
  const file = path.join(root, ALLOW_FILE);
  if (!fs.existsSync(file)) return { entries: [], problems: [] };
  let list;
  try {
    list = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { entries: [], problems: [`${ALLOW_FILE}: not valid JSON (${e.message})`] };
  }
  const problems = [];
  const names = PATTERNS.map((p) => p.name);
  const entries = [];
  for (const e of Array.isArray(list) ? list : []) {
    const label = `${ALLOW_FILE}: ${e?.file} ${e?.pattern}`;
    if (typeof e?.file !== "string" || /[*?[\]{}]/.test(e.file)) problems.push(`${label} must be an exact path, with no wildcard`);
    else if (!names.includes(e.pattern)) problems.push(`${label}: the pattern must be one of ${names.join(", ")}`);
    else if (typeof e.reason !== "string" || !e.reason.trim()) problems.push(`${label} needs a reason`);
    else entries.push(e);
  }
  return { entries, problems };
}

function main() {
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).toString("utf8").trim();
  const built = builtApp(root);
  const all = [...trackedFiles(root), ...history(root), ...built.hits];
  const { entries, problems } = loadAllow(root);

  const used = new Set();
  const hits = [];
  const allowed = [];
  for (const h of all) {
    const entry = entries.find((e) => e.file === h.file && e.pattern === h.pattern);
    if (entry) {
      used.add(entry);
      allowed.push({ ...h, reason: entry.reason });
    } else hits.push(h);
  }
  for (const e of entries) if (!used.has(e)) problems.push(`${ALLOW_FILE}: ${e.file} ${e.pattern} matches nothing; remove the entry`);

  if (built.note) console.log(built.note);
  for (const h of allowed) console.log(`${"allowed".padEnd(13)} ${h.where}  ${h.pattern}  (${h.reason})`);
  for (const h of hits) console.log(`${h.scope.padEnd(13)} ${h.where}  ${h.pattern}`);
  for (const p of problems) console.log(p);
  if (hits.length || problems.length) {
    if (hits.length) console.log(`\n${hits.length} key-shaped string${hits.length === 1 ? "" : "s"} found. The values are not shown. Treat anything real as exposed: revoke it at the provider, then remove it.`);
    process.exit(1);
  }
  console.log(`No key-shaped strings found in tracked files, in history, or in the built app (where it was built).${allowed.length ? ` ${allowed.length} known made-up value${allowed.length === 1 ? "" : "s"} listed above.` : ""}`);
}

main();
