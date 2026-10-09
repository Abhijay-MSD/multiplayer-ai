// The conversation as a Markdown file, made in the browser. Plain JavaScript, no React.
//
// Everything in a conversation is somebody's text, and some of it a model's. So nothing here is passed on as Markdown: a message
// goes in a fenced block that no line inside it can close (the fence is longer than any run of backticks in it), and the few
// things written outside a fence (the title, a person's name) have every Markdown and HTML special character escaped. Control
// characters, text-direction marks and zero-width characters are replaced by visible escapes. Comments are labelled as comments
// the agent never saw.
import { safeFileName } from "./outputs.js";

const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;
const hex = (n, w) => n.toString(16).padStart(w, "0");

/** The text with each unsafe character shown as \xNN or \u{NNNN}; line feeds and tabs are kept. */
export function visible(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").replace(UNSAFE, (c) => {
    if (c === "\n" || c === "\t") return c;
    const code = c.codePointAt(0);
    return code < 256 ? `\\x${hex(code, 2)}` : `\\u{${hex(code, 4)}}`;
  });
}

/** One line of text with every Markdown and HTML special character escaped, so it can't make markup. */
export function inline(text) {
  return visible(text)
    .replace(/\s*\n\s*/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}[\]()#|~]/g, "\\$&")
    .trim();
}

/** A fenced block of verbatim text, with a fence longer than any run of backticks inside it. */
export function fenced(text) {
  const body = visible(text);
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${body}\n${fence}`;
}

const pad = (n) => String(n).padStart(2, "0");
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${day(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** The whole conversation as Markdown. `events` are the room's events in order. */
export function transcriptMarkdown({ session, events, now = new Date() }) {
  const byId = new Map(events.map((e) => [e.id, e]));
  const out = [`# ${inline(session?.title) || "Untitled room"}`, ""];
  out.push(`Exported from Multiplayer AI on ${day(now)}. Comments were never seen by the agent. Nothing in this file is run or rendered as part of the page it came from.`, "");
  out.push("**Task**", "", fenced(session?.task ?? ""), "");
  if (String(session?.brief ?? "").trim()) out.push("**Brief from the host**", "", fenced(session.brief), "");
  out.push("## Conversation", "");

  const shown = events.filter((e) => ["directive", "agent_message", "comment", "status", "takeover", "join"].includes(e.kind));
  if (!shown.length) out.push("No messages yet.", "");
  for (const e of shown) {
    const when = stamp(e.created_at);
    const at = when ? ` — ${when}` : "";
    if (e.kind === "directive") out.push(`**${inline(e.author)}** (message to the agent)${at}`, "", fenced(e.content), "");
    else if (e.kind === "agent_message") {
      const to = e.reply_to != null ? byId.get(e.reply_to)?.author : null;
      out.push(`**Agent** (${to ? `reply to ${inline(to)}` : "reply"})${at}`, "", fenced(e.content), "");
    } else if (e.kind === "comment") out.push(`**${inline(e.author)}** (comment, not seen by the agent)${at}`, "", fenced(e.content), "");
    else out.push(`*${inline(e.content)}*${when ? ` (${when})` : ""}`, "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/** A name to save the file under: made from the title, safe anywhere, always ending in .md. */
export function transcriptFileName(session, now = new Date()) {
  const slug = String(session?.title ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 40)
    .replace(/[._-]+$/g, "");
  return safeFileName(`multiplayer-ai${slug ? `-${slug}` : ""}-${day(now)}.md`) ?? `multiplayer-ai-${day(now)}.md`;
}
