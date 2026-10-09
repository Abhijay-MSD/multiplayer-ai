// Reading a file the person chose, and naming it, for "attach". Plain JavaScript, no React.
//
// A file is attached only if it is text: valid UTF-8 with no NUL character. Anything else (a picture, a PDF, a zip) is
// refused here with a plain message, and the server checks the same again. Nothing here shows the text as markup.

export const NAME_RULE = "A file name can use letters, digits, spaces, dots, dashes and underscores, up to 64 characters.";

export function describeBytes(n) {
  if (n === 1) return "1 byte";
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** { ok: true, text } or { ok: false, message }. `maxBytes` is the server's limit for one file, when known. */
export async function readTextFile(file, maxBytes) {
  if (maxBytes && file.size > maxBytes) return { ok: false, message: `${file.name} is ${describeBytes(file.size)}, more than the ${describeBytes(maxBytes)} a file can be here, so it wasn't attached.` };
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    return { ok: false, message: `${file.name} isn't a text file, so it wasn't attached. Only text can be attached.` };
  }
  if (text.includes("\u0000")) return { ok: false, message: `${file.name} isn't a text file, so it wasn't attached. Only text can be attached.` };
  return { ok: true, text };
}

/** A name the server will accept, made from what the person's file was called. Empty if nothing usable is left. */
export function suggestFileName(raw) {
  let name = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  name = name.normalize("NFKD").replace(/[^A-Za-z0-9 ._-]/g, "_").replace(/\.{2,}/g, ".").replace(/_{2,}/g, "_");
  name = name.replace(/^[. ]+/, "").replace(/[. ]+$/, "");
  if (name.length > 64) {
    const ext = /\.[A-Za-z0-9]{1,10}$/.exec(name)?.[0] ?? "";
    name = name.slice(0, 64 - ext.length) + ext;
  }
  return name;
}
