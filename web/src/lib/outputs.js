// "Outputs": the fenced blocks in the agent's replies, offered for copying and downloading. Plain JavaScript, no React.
//
// Everything here treats a block's text and its label as untrusted text from a model (and, through the model, from
// anyone in the room). Names are cut down to letters, digits, dot, dash and underscore; a download is always plain
// text, never opened, rendered or run by Multiplayer AI; sizes and counts are bounded.
import { parseBlocks } from "./markdownBlocks.js";

export const LIMITS = {
  blockChars: 1_000_000, // a block longer than this is shown but not offered for copy or download
  listed: 200, // outputs listed in the Outputs tab (the newest)
  previewLines: 4,
  previewChars: 240,
  nameChars: 80
};

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// A browser would draw or run these when the saved file is opened, so they get ".txt" added.
const PAGE_LIKE = /\.(html?|xhtml|svg|xml|mhtml|hta)$/i;

/** A file name that is safe to hand to the browser's download, or null if nothing usable is left. */
export function safeFileName(raw) {
  let name = String(raw ?? "");
  name = name.split(/[\\/]/).filter((p) => p.trim() !== "").pop() ?? "";
  name = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_");
  name = name.replace(/^\.+/, "").replace(/[. ]+$/, "");
  if (!name) return null;
  if (WINDOWS_RESERVED.test(name.split(".")[0])) name = `_${name}`;
  if (PAGE_LIKE.test(name)) name += ".txt";
  if (name.length > LIMITS.nameChars) {
    const ext = /\.[A-Za-z0-9]{1,10}$/.exec(name)?.[0] ?? "";
    name = name.slice(0, LIMITS.nameChars - ext.length) + ext;
  }
  return name;
}

const LABEL = /[^A-Za-z0-9+#._-]/g;
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,10}$/;
const cleanLabel = (t) => t.replace(LABEL, "").replace(/^[.]+/, "").slice(0, 24) || null;

/** What follows a code fence's backticks: a language, and perhaps a file name. */
export function parseFenceInfo(info) {
  const tokens = String(info ?? "").trim().slice(0, 200).split(/\s+/).filter(Boolean);
  let language = null;
  let fileName = null;
  tokens.forEach((token, i) => {
    const named = /^(?:title|filename|file|name)=["']?(.*?)["']?$/i.exec(token);
    if (named) {
      fileName ??= safeFileName(named[1]);
      return;
    }
    const colon = token.indexOf(":");
    if (colon > 0 && colon < token.length - 1) {
      language ??= cleanLabel(token.slice(0, colon));
      fileName ??= safeFileName(token.slice(colon + 1));
      return;
    }
    if (HAS_EXTENSION.test(token) && !token.startsWith("{")) {
      fileName ??= safeFileName(token);
      return;
    }
    if (i === 0) language = cleanLabel(token);
  });
  return { language, fileName };
}

const EXTENSIONS = {
  js: "js", javascript: "js", jsx: "jsx", ts: "ts", typescript: "ts", tsx: "tsx", json: "json", html: "html", css: "css",
  py: "py", python: "py", sh: "sh", bash: "sh", shell: "sh", zsh: "sh", md: "md", markdown: "md", yaml: "yaml", yml: "yaml",
  sql: "sql", csv: "csv", diff: "diff", patch: "diff", go: "go", rs: "rs", rust: "rs", java: "java", c: "c", cpp: "cpp",
  rb: "rb", ruby: "rb", php: "php", swift: "swift", kt: "kt", kotlin: "kt", toml: "toml", ini: "ini", xml: "xml"
};
const extensionFor = (language) => EXTENSIONS[String(language ?? "").toLowerCase()] ?? "txt";

export function describeSize(lines, chars) {
  const l = `${lines} ${lines === 1 ? "line" : "lines"}`;
  if (chars < 1024) return `${l}, ${chars} ${chars === 1 ? "character" : "characters"}`;
  if (chars < 1024 * 1024) return `${l}, ${(chars / 1024).toFixed(1)} KB`;
  return `${l}, ${(chars / 1024 / 1024).toFixed(1)} MB`;
}

function previewOf(text) {
  const head = text.split("\n", LIMITS.previewLines).join("\n");
  return head.length > LIMITS.previewChars ? `${head.slice(0, LIMITS.previewChars)}…` : head;
}

/** What a code block is called, from its fence and its place: the Nth block of reply `eventId`. */
export function describeBlock(eventId, info, index, text) {
  const { language, fileName } = parseFenceInfo(info);
  return {
    language,
    fileName: fileName ?? safeFileName(`output-${eventId}-${index}.${extensionFor(language)}`) ?? `output-${index}.txt`,
    tooLarge: text.length > LIMITS.blockChars
  };
}

function toOutput(event, block, index) {
  const text = block.text;
  const { language, fileName: name, tooLarge } = describeBlock(event.id, block.info, index, text);
  return {
    key: `${event.id}:${index}`,
    eventId: event.id,
    author: event.author,
    createdAt: event.created_at,
    index,
    language,
    fileName: name,
    text,
    chars: text.length,
    lines: text.split("\n").length,
    preview: previewOf(text),
    tooLarge
  };
}

const codeBlocksOf = (event) => parseBlocks(event.content ?? "").filter((b) => b.type === "code");

/**
 * { items, total, shown }: the newest outputs (at most LIMITS.listed), the count of every output in the room, and how
 * many are listed. Only the agent's replies count. Newest reply first; inside one reply, the order they were written in.
 */
export function extractOutputs(events) {
  const replies = events.filter((e) => e.kind === "agent_message");
  const items = [];
  let total = 0;
  for (let r = replies.length - 1; r >= 0; r--) {
    const event = replies[r];
    const blocks = codeBlocksOf(event);
    const filled = blocks.filter((b) => b.text.trim() !== "");
    total += filled.length;
    if (items.length >= LIMITS.listed) continue;
    const mine = [];
    blocks.forEach((b, i) => b.text.trim() !== "" && mine.push(toOutput(event, b, i + 1)));
    items.push(...mine.slice(0, LIMITS.listed - items.length));
  }
  return { items, total, shown: items.length };
}

/** Saves `text` as a file with a safe name. The browser is told it is plain text, and the file is never opened or shown here. */
export function downloadText(fileName, text) {
  const name = safeFileName(fileName) ?? "output.txt";
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

/** Copies `text` to the clipboard. Resolves true if it worked. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(area);
      area.select();
      const done = document.execCommand("copy");
      area.remove();
      return done;
    } catch {
      return false;
    }
  }
}
