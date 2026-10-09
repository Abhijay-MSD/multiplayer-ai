// Tiny markdown renderer for agent replies. Builds React elements only (never
// HTML strings), so model output can't inject markup: React escapes all text.
// Supports: **bold**, *italic* / _italic_, `inline code`, ``` code blocks ```,
// -, *, + and 1. lists (flat), # headings (shown as bold lines), line breaks, simple tables, and [text](address) links for
// http and https addresses only (with rel="noopener noreferrer nofollow", opening in a new tab, the full address as the hover
// text). No images and no raw HTML: `![alt](address)` and anything else stay text.

import { parseBlocks } from "./markdownBlocks.js";
import { parseLink } from "./links.js";
import { CodeBlock } from "../components/CodeBlock";
import styles from "../components/Transcript.module.css";

const isWordChar = (c) => c !== undefined && /[A-Za-z0-9]/.test(c);

function renderInline(text, { links = true } = {}) {
  const out = [];
  let buf = "";
  let i = 0;
  let k = 0;
  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
  };

  while (i < text.length) {
    const ch = text[i];

    if (links && ch === "[" && text[i - 1] !== "!") {
      const link = parseLink(text, i);
      if (link) {
        flush();
        out.push(
          <a key={k++} href={link.href} target="_blank" rel="noopener noreferrer nofollow" title={link.href}>
            {renderInline(link.text, { links: false })}
          </a>
        );
        i = link.end;
        continue;
      }
    }

    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push(<code key={k++}>{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }

    if (text.startsWith("**", i) || text.startsWith("__", i)) {
      const mark = text.slice(i, i + 2);
      const end = text.indexOf(mark, i + 2);
      const boundaryOk = mark === "**" || (!isWordChar(text[i - 1]) && !isWordChar(text[end + 2]));
      if (end > i + 2 && boundaryOk && !/^\s/.test(text[i + 2])) {
        flush();
        out.push(<strong key={k++}>{renderInline(text.slice(i + 2, end), { links })}</strong>);
        i = end + 2;
        continue;
      }
    }

    if ((ch === "*" || ch === "_") && text[i + 1] !== ch && text[i + 1] !== undefined && !/\s/.test(text[i + 1])) {
      let end = i + 1;
      while ((end = text.indexOf(ch, end)) !== -1) {
        const closes = !/\s/.test(text[end - 1]) && text[end + 1] !== ch;
        const boundaryOk = ch === "*" || (!isWordChar(text[i - 1]) && !isWordChar(text[end + 1]));
        if (closes && boundaryOk) break;
        end++;
      }
      if (end > i + 1) {
        flush();
        out.push(<em key={k++}>{renderInline(text.slice(i + 1, end), { links })}</em>);
        i = end + 1;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

// Soft line breaks inside a paragraph become <br />.
function renderLines(lines) {
  const out = [];
  lines.forEach((line, idx) => {
    if (idx > 0) out.push(<br key={`br${idx}`} />);
    out.push(...renderInline(line));
  });
  return out;
}

// `eventId` (agent replies) gives each code block Copy and Download buttons and the name the Outputs tab uses for it.
export function Markdown({ text, eventId }) {
  let codeIndex = 0;
  return parseBlocks(text ?? "").map((b, idx) => {
    switch (b.type) {
      case "code":
        codeIndex += 1;
        if (eventId !== undefined) return <CodeBlock key={idx} text={b.text} info={b.info} eventId={eventId} index={codeIndex} />;
        return (
          <pre key={idx} tabIndex={0}>
            <code>{b.text}</code>
          </pre>
        );
      case "heading":
        return <p key={idx}><strong>{renderInline(b.text)}</strong></p>;
      case "ul":
        return <ul key={idx}>{b.items.map((t, j) => <li key={j}>{renderInline(t)}</li>)}</ul>;
      case "ol":
        return <ol key={idx}>{b.items.map((t, j) => <li key={j}>{renderInline(t)}</li>)}</ol>;
      case "table":
        return (
          <div key={idx} className={styles.mdTable} role="region" aria-label="Table" tabIndex={0}>
            <table>
              <thead>
                <tr>{b.header.map((c, j) => <th key={j} scope="col" style={b.align[j] ? { textAlign: b.align[j] } : undefined}>{renderInline(c)}</th>)}</tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r}>{row.map((c, j) => <td key={j} style={b.align[j] ? { textAlign: b.align[j] } : undefined}>{renderInline(c)}</td>)}</tr>
                ))}
              </tbody>
            </table>
            {(b.cutRows > 0 || b.cutColumns > 0) && (
              <p className={styles.mdTableNote}>
                The table is cut here: {b.cutRows > 0 ? `${b.cutRows} more ${b.cutRows === 1 ? "row" : "rows"}` : ""}
                {b.cutRows > 0 && b.cutColumns > 0 ? " and " : ""}
                {b.cutColumns > 0 ? `${b.cutColumns} more ${b.cutColumns === 1 ? "column" : "columns"}` : ""} not shown.
              </p>
            )}
          </div>
        );
      default:
        return <p key={idx}>{renderLines(b.lines)}</p>;
    }
  });
}
