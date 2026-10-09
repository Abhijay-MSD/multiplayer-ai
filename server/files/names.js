// What a room file may be called and what it may hold.
//
// A name is an allowlist: ASCII letters, digits, space, dot, dash and underscore, 1 to 64 characters. Everything
// else is refused rather than cleaned, so the name someone typed (or the model produced) is the name shown, and a
// look-alike letter, a text-direction mark or a zero-width character can never make two names look the same.
// Files are rows in the database; no path is ever built from a name. These rules exist for what people see and for
// what a download is saved as.
//
// Content must be text: a string with no NUL character that survives a trip through UTF-8 unchanged.

export const MAX_NAME_LENGTH = 64;

const ALLOWED = /^[A-Za-z0-9 ._-]+$/;
// Windows reserves these, with or without an extension, in any case. Refused everywhere so a downloaded file can be opened anywhere.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const NAME_RULE = "A file name can use letters, digits, spaces, dots, dashes and underscores, up to 64 characters.";
const bad = (message) => ({ ok: false, code: "BAD_FILE_NAME", message });

/** The key two names share when they differ only in letter case. Names are ASCII, so lower-casing is exact. */
export const fileNameKey = (name) => String(name).toLowerCase();

/** { ok: true, name, key } or { ok: false, code: "BAD_FILE_NAME", message }. The message never repeats the name. */
export function checkFileName(input) {
  if (typeof input !== "string") return bad("A file needs a name.");
  if (input.length === 0) return bad("A file needs a name.");
  if (input.length > MAX_NAME_LENGTH) return bad(`That file name is too long. ${NAME_RULE}`);
  if (!ALLOWED.test(input)) return bad(`That file name has a character that isn't allowed. ${NAME_RULE}`);
  if (input.startsWith(".")) return bad("A file name can't start with a dot.");
  if (input.startsWith(" ")) return bad("A file name can't start with a space.");
  if (input.endsWith(".") || input.endsWith(" ")) return bad("A file name can't end with a dot or a space.");
  if (input.includes("..")) return bad("A file name can't contain two dots in a row.");
  if (RESERVED.test(input)) return bad("That file name is reserved by Windows. Choose another.");
  return { ok: true, name: input, key: fileNameKey(input) };
}

/** { ok: true } or { ok: false, code: "BAD_FILE_CONTENT", message }. Size is checked elsewhere, against the limits. */
export function checkFileContent(content) {
  const fail = (message) => ({ ok: false, code: "BAD_FILE_CONTENT", message });
  if (typeof content !== "string") return fail("A file's content has to be text.");
  if (content.includes("\0")) return fail("A file's content has to be text without NUL characters.");
  if (Buffer.from(content, "utf8").toString("utf8") !== content) return fail("A file's content has to be valid UTF-8 text.");
  return { ok: true };
}
