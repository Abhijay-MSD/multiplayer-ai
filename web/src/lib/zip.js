// A zip writer, by hand, with no dependency: every file is stored (not compressed), so an archive is the files' bytes with a
// small header before each and a directory at the end. Used to download a room's files in one go. Plain JavaScript, no React.
//
// Names inside an archive go through zipEntryNames: a name is cut down to the last part of any path, to letters, digits, dot,
// dash and underscore, with no leading dot and nothing a browser would draw or Windows reserves, and two names that end up the
// same (ignoring case) are kept apart. Whatever a name started as, an archive can only ever unpack to plain files in one folder.
import { safeFileName } from "./outputs.js";

export const ZIP_LIMITS = { entries: 1000, bytes: 64 * 1024 * 1024 }; // far above a room's files; a plain zip (not zip64) holds more

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** The CRC-32 of `bytes`, as a number (what a zip stores to check each file). */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Names that are safe and different: [raw names] -> [names for the archive], in the same order. */
export function zipEntryNames(raw) {
  const seen = new Set();
  return raw.map((r) => {
    const base = safeFileName(r) ?? "file.txt";
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    let name = base;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${stem}_${n}${ext}`;
    seen.add(name.toLowerCase());
    return name;
  });
}

const dos = (date) => {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date(1980, 0, 1);
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
};

/** entries: [{ name, data: Uint8Array, date?: Date }]. Returns the archive as a Uint8Array. */
export function createZip(entries) {
  if (entries.length > ZIP_LIMITS.entries) throw new Error(`That is too many files for one archive (the limit is ${ZIP_LIMITS.entries}).`);
  let total = 0;
  for (const e of entries) total += e.data.length;
  if (total > ZIP_LIMITS.bytes) throw new Error(`That is too large for one archive (the limit is ${ZIP_LIMITS.bytes} bytes).`);
  const names = entries.map((e) => new TextEncoder().encode(e.name));
  if (names.some((n) => n.length > 0xffff)) throw new Error("A file name is too long for an archive.");

  const size = entries.reduce((n, e, i) => n + 30 + names[i].length + e.data.length + 46 + names[i].length, 22);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets = [];

  entries.forEach((e, i) => {
    const { time, date } = dos(e.date);
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true); // local file header
    view.setUint16(at + 4, 10, true); // version needed: 1.0, stored
    view.setUint16(at + 6, 0x0800, true); // the name is UTF-8
    view.setUint16(at + 8, 0, true); // method 0: stored
    view.setUint16(at + 10, time, true);
    view.setUint16(at + 12, date, true);
    view.setUint32(at + 14, crc32(e.data), true);
    view.setUint32(at + 18, e.data.length, true);
    view.setUint32(at + 22, e.data.length, true);
    view.setUint16(at + 26, names[i].length, true);
    view.setUint16(at + 28, 0, true);
    out.set(names[i], at + 30);
    out.set(e.data, at + 30 + names[i].length);
    at += 30 + names[i].length + e.data.length;
  });

  const directory = at;
  entries.forEach((e, i) => {
    const { time, date } = dos(e.date);
    view.setUint32(at, 0x02014b50, true); // central directory header
    view.setUint16(at + 4, (3 << 8) | 20, true); // made by: Unix, 2.0
    view.setUint16(at + 6, 10, true);
    view.setUint16(at + 8, 0x0800, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, time, true);
    view.setUint16(at + 14, date, true);
    view.setUint32(at + 16, crc32(e.data), true);
    view.setUint32(at + 20, e.data.length, true);
    view.setUint32(at + 24, e.data.length, true);
    view.setUint16(at + 28, names[i].length, true);
    view.setUint16(at + 30, 0, true); // no extra field
    view.setUint16(at + 32, 0, true); // no comment
    view.setUint16(at + 34, 0, true); // disk 0
    view.setUint16(at + 36, 0, true); // internal attributes
    view.setUint32(at + 38, (0o100644 << 16) >>> 0, true); // a plain file, rw-r--r--
    view.setUint32(at + 42, offsets[i], true);
    out.set(names[i], at + 46);
    at += 46 + names[i].length;
  });

  view.setUint32(at, 0x06054b50, true); // end of central directory
  view.setUint16(at + 4, 0, true);
  view.setUint16(at + 6, 0, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, at - directory, true);
  view.setUint32(at + 16, directory, true);
  view.setUint16(at + 20, 0, true);
  return out;
}

/** Saves bytes as a file. The browser is told it is a zip and nothing is opened. */
export function downloadZip(fileName, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
