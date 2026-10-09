// Which addresses in a reply become links, and where a [text](address) ends. Plain JavaScript, no React.
//
// Only http and https. The address must be written out in full (no relative paths, no scheme-less names), have a host, hold no
// user name or password, no space, control or format character, and be under 2000 characters. What is returned is the browser's
// own reading of it, so what is linked is exactly what was checked. Images are never made: `![alt](address)` stays text.

const MAX_ADDRESS = 2000;
const MAX_LABEL = 200;
const BAD_CHARS = /[\s\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}\p{Cs}]/u;

/** The address as a safe http(s) address, or null. */
export function safeHref(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_ADDRESS || BAD_CHARS.test(raw)) return null;
  if (!/^https?:\/\/[^/?#\\]/i.test(raw)) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || url.username || url.password) return null;
  return url.href;
}

/** At `start` (which must be a "["), a link { text, href, end } where end is just past the ")", or null. */
export function parseLink(text, start) {
  if (text[start] !== "[") return null;
  let depth = 0;
  let i = start;
  for (; i < text.length && i - start <= MAX_LABEL + 1; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) break;
  }
  if (depth !== 0 || text[i] !== "]" || text[i + 1] !== "(") return null;
  const label = text.slice(start + 1, i);
  if (!label.trim() || label.length > MAX_LABEL) return null;
  let j = i + 2;
  let parens = 1;
  for (; j < text.length && j - i <= MAX_ADDRESS + 2; j++) {
    if (text[j] === "(") parens++;
    else if (text[j] === ")" && --parens === 0) break;
    else if (/\s/.test(text[j])) return null;
  }
  if (parens !== 0 || text[j] !== ")") return null;
  const href = safeHref(text.slice(i + 2, j));
  return href ? { text: label, href, end: j + 1 } : null;
}
