// Text a stranger controls (a name, a title, the words a provider answers with) can hold characters that
// do things when they reach a terminal: an escape sequence repaints the screen or sets its title, a carriage
// return overwrites the line before it, a line feed starts a fake log line, and a text-direction override
// makes one string read as another. Names and titles that hold any of them are refused when they are set;
// anything untrusted that is written to the terminal goes through escapeForLog first.

// C0 and C1 controls (Cc), format characters (Cf: every text-direction override, isolate and mark, zero-width
// characters, the byte-order mark), lone surrogates (Cs), and the line and paragraph separators (Zl, Zp).
const CLASS = "[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}]";
const UNSAFE = new RegExp(CLASS, "gu");
const HAS_UNSAFE = new RegExp(CLASS, "u");

/** Does the text hold a character that is not safe to print or to show as a name? */
export const hasUnsafeChars = (text) => HAS_UNSAFE.test(String(text ?? ""));

/** Like hasUnsafeChars, but a line feed is allowed: for a short text that is meant to have lines (the room brief). */
export const hasUnsafeCharsExceptNewline = (text) => HAS_UNSAFE.test(String(text ?? "").replace(/\n/g, ""));

/** For a label made from free text: each unsafe character becomes a space, and runs of spaces become one. */
export const plainLabel = (text) => String(text ?? "").replace(UNSAFE, " ").replace(/\s+/g, " ").trim();

const hex = (n, width) => n.toString(16).padStart(width, "0");

/**
 * The text with each unsafe character replaced by a visible escape: \xNN below 256, \u{NNNN} above. The text is
 * otherwise unchanged, so a log line still shows what was really there. A lone surrogate is shown as \u{NNNN}.
 */
export function escapeForLog(value) {
  const text = typeof value === "string" ? value : value instanceof Error ? value.message : String(value ?? "");
  return text.replace(UNSAFE, (c) => {
    const code = c.codePointAt(0);
    return code < 256 ? `\\x${hex(code, 2)}` : `\\u{${hex(code, 4)}}`;
  });
}
