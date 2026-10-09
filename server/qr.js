// A QR code as an SVG string, drawn on the server with the qrcode-generator library (MIT, no dependencies).
// Black on white with a four-module quiet zone, whatever the theme: a scanner needs the contrast.
// Only ever sent to the host's browser (see host-routes.js).
import qrcode from "qrcode-generator";

export const MAX_QR_CHARS = 400; // far more than a share link; a bound so nothing can ask for a huge code

/** SVG for `text`, error correction level M. Throws on text that is empty or too long. */
export function qrSvg(text, { label = "QR code" } = {}) {
  if (typeof text !== "string" || !text) throw new Error("A QR code needs some text.");
  if (text.length > MAX_QR_CHARS) throw new Error("That is too long for a QR code.");
  const qr = qrcode(0, "M"); // type 0: the smallest version that fits
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const size = n + quiet * 2;
  let path = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  const safe = String(label).replace(/[<>&"']/g, "");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 6}" height="${size * 6}" role="img" aria-label="${safe}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`
  );
}
