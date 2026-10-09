// Splits agent text into blocks (code, heading, lists, paragraphs). Plain data, no React, so the renderer
// (markdown.jsx) and the Outputs list (outputs.js) read a reply the same way. A code block keeps the text after
// its opening fence as `info` (a language or a file name); it is only ever shown as text.

// Tables are cut to these sizes (and say so), so a reply can't ask the page to lay out thousands of cells.
export const TABLE_LIMITS = { rows: 200, columns: 20 };

const FENCE = /^\s*```(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;

const splitRow = (line) => {
  const cells = [];
  let cell = "";
  const body = line.trim().replace(/^\|/, "");
  for (let k = 0; k < body.length; k++) {
    if (body[k] === "\\" && body[k + 1] === "|") {
      cell += "|";
      k++;
    } else if (body[k] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += body[k];
  }
  if (cell.trim() !== "" || !/\|\s*$/.test(line)) cells.push(cell.trim());
  return cells;
};
const SEP_CELL = /^:?-+:?$/;
const isTableStart = (lines, i) => {
  if (i + 1 >= lines.length || !lines[i].includes("|") || !lines[i + 1].includes("|")) return false;
  const sep = splitRow(lines[i + 1]);
  return sep.length > 0 && sep.every((c) => SEP_CELL.test(c)) && splitRow(lines[i]).length === sep.length;
};

export function parseBlocks(source) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence (or EOF)
      blocks.push({ type: "code", text: code.join("\n"), info: fence[1].trim() });
      continue;
    }

    if (isTableStart(lines, i)) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      const columns = Math.min(head.length, TABLE_LIMITS.columns);
      i += 2;
      const rows = [];
      let cutRows = 0;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        if (rows.length < TABLE_LIMITS.rows) {
          const cells = splitRow(lines[i]).slice(0, columns);
          while (cells.length < columns) cells.push("");
          rows.push(cells);
        } else cutRows++;
        i++;
      }
      blocks.push({ type: "table", header: head.slice(0, columns), align: align.slice(0, columns), rows, cutRows, cutColumns: head.length - columns });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", text: heading[1] });
      i++;
      continue;
    }

    const listRe = BULLET.test(line) ? BULLET : ORDERED.test(line) ? ORDERED : null;
    if (listRe) {
      const items = [];
      while (i < lines.length && listRe.test(lines[i])) items.push(listRe.exec(lines[i++])[1]);
      blocks.push({ type: listRe === BULLET ? "ul" : "ol", items });
      continue;
    }

    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !BULLET.test(lines[i]) &&
      !ORDERED.test(lines[i]) &&
      !isTableStart(lines, i)
    ) {
      para.push(lines[i++]);
    }
    blocks.push({ type: "p", lines: para });
  }
  return blocks;
}
