// Fails when banned copy or AI brand names appear in web/src or docs/.
// Run: node scripts/check-copy.mjs
//
// One narrow exception: scripts/copy-exemptions.json lists the exact files that may name
// AI providers (the provider picker's labels and the providers doc), because a person
// choosing a provider has to see its name. Only provider names are excused, only in those
// files, and each entry is an exact path: no wildcards, no folders. Banned phrases are
// still checked in them, and an entry for a file that does not exist is itself an error.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCAN_DIRS = ["web/src", "docs"];
const EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".css", ".html", ".md", ".json"]);

// Marketing filler we do not write. Matched on word boundaries, case-insensitive.
const BANNED_PHRASES = [
  /\bseamless(ly)?\b/i,
  /\bsupercharg\w*/i,
  /\bunlock\w*/i,
  /\belevat(e|es|ed|ing)\b/i,
  /\bempower\w*/i,
  /\bleverag\w*/i,
  /\brevolutioni[sz]\w*/i,
  /\bgame[- ]changing\b/i,
  /\bcutting[- ]edge\b/i,
  /\bnext[- ]generation\b/i,
  /\bin today['’]s\b/i,
  /\btake it to the next level\b/i,
  /\bunleash\w*/i,
  /\btransform your\b/i,
  /\boops\b/i
];

// Names of AI products and providers. Themes are independent designs and the
// UI never names another product.
const BRAND_NAMES = [
  /\bclaude\b/i,
  /\banthropic\b/i,
  /\bchatgpt\b/i,
  /\bopenai\b/i,
  /\bgpt-?\d/i,
  /\bgemini\b/i,
  /\bcopilot\b/i,
  /\bperplexity\b/i,
  /\bgrok\b/i,
  /\bllama\b/i,
  /\bmistral\b/i
];

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walk(full);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

const posix = (p) => p.split(path.sep).join("/");

/** Reads the exemptions file. Returns { files: Set<string>, problems: string[] }. */
export function loadExemptions(root, file = path.join(root, "scripts", "copy-exemptions.json")) {
  const problems = [];
  const files = new Set();
  if (!fs.existsSync(file)) return { files, problems };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { files, problems: [`${posix(path.relative(root, file))}: not valid JSON`] };
  }
  const where = posix(path.relative(root, file));
  for (const entry of data.provider_names ?? []) {
    if (typeof entry !== "string" || !entry || /[*?[\]{}]|\.\.|^\/|\/$|\\/.test(entry)) {
      problems.push(`${where}: "${entry}" is not an exact file path (no wildcards, folders, "..", or absolute paths)`);
      continue;
    }
    if (!SCAN_DIRS.some((d) => entry.startsWith(d + "/"))) {
      problems.push(`${where}: "${entry}" is outside the folders the check scans (${SCAN_DIRS.join(", ")})`);
      continue;
    }
    if (!fs.existsSync(path.join(root, entry)) || !fs.statSync(path.join(root, entry)).isFile()) {
      problems.push(`${where}: "${entry}" does not exist; remove the entry`);
      continue;
    }
    files.add(entry);
  }
  return { files, problems };
}

/** Scans `root`. Returns { problems: string[], scanned: number }. */
export function checkCopy({ root = path.resolve(here, ".."), exemptionsFile } = {}) {
  const { files: exempt, problems } = loadExemptions(root, exemptionsFile);
  let scanned = 0;
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(root, dir))) {
      scanned++;
      const rel = posix(path.relative(root, file));
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const [kind, list] of [["banned phrase", BANNED_PHRASES], ["AI brand name", exempt.has(rel) ? [] : BRAND_NAMES]]) {
          for (const re of list) {
            const m = re.exec(line);
            if (m) problems.push(`${rel}:${i + 1}  ${kind}: "${m[0]}"`);
          }
        }
      });
    }
  }
  return { problems, scanned };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { problems, scanned } = checkCopy();
  if (problems.length) {
    console.error(`Copy check failed (${problems.length}):\n` + problems.map((p) => `  ${p}`).join("\n"));
    process.exit(1);
  }
  console.log(`Copy check passed (${scanned} files in ${SCAN_DIRS.join(", ")}).`);
}
