// Exports one recorded session to web/src/marketing/recorded-session.json,
// the file the landing page replays. It only reads: it calls get_session on a
// running Multiplayer AI server and writes nothing to the database.
//
//   node scripts/export-session.mjs <session_id> [--api http://localhost:3001]
//                                   [--rename "Old name=New name"] ...
//
// --rename swaps a participant's name everywhere (author fields and event
// text) so the file can carry a display name instead of a real one.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const sessionId = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
const flag = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const api = flag("--api")[0] || "http://localhost:3001";
const renames = Object.fromEntries(flag("--rename").map((r) => r.split("=")));

if (!sessionId) {
  console.error("Usage: node scripts/export-session.mjs <session_id> [--api URL] [--rename \"Old=New\"]");
  process.exit(1);
}

const res = await fetch(`${api}/api/tools/get_session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ session_id: sessionId })
});
const data = await res.json();
if (!res.ok || data.error) {
  console.error(`get_session failed: ${data.error || res.status}`);
  process.exit(1);
}

const swap = (text) => Object.entries(renames).reduce((t, [from, to]) => t.split(from).join(to), text ?? "");

const out = {
  source: "recorded",
  recordedAt: new Date().toISOString(),
  session: {
    title: swap(data.session.title),
    task: swap(data.session.task),
    step_count: data.session.step_count
  },
  participants: data.participants.map((p) => ({ name: swap(p.name), role: p.role })),
  events: data.events.map((e) => ({
    id: e.id,
    kind: e.kind,
    author: swap(e.author),
    content: swap(e.content),
    reply_to: e.reply_to,
    created_at: e.created_at
  }))
};

const file = path.join(root, "web/src/marketing/recorded-session.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`Wrote ${path.relative(root, file)}: ${out.events.length} events, ${out.participants.length} participants.`);
