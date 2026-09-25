// A small Markdown renderer for the subset transcripts use. Escapes first;
// raw HTML in the source stays text; link URLs are checked. No dependencies.
// Exposes window.renderMarkdown(text, { decorate }) where `decorate` may wrap
// already-escaped prose (used for @mentions) and never sees code.

(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const safeUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : null);
  const HOLD = String.fromCharCode(0); // marks a protected code span while inline formatting runs
  const HOLD_RE = new RegExp(`${HOLD}(\\d+)${HOLD}`, "g");

  // Inline: code spans first (protected), then links, bold, italic. Input is escaped text.
  function inline(text, decorate) {
    const codes = [];
    let out = text.replace(/`([^`\n]+)`/g, (m, c) => {
      codes.push(`<code>${c}</code>`);
      return `${HOLD}${codes.length - 1}${HOLD}`;
    });
    out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const href = safeUrl(url.replace(/&amp;/g, "&"));
      return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : m;
    });
    out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
    if (decorate) out = decorate(out);
    return out.replace(HOLD_RE, (m, i) => codes[Number(i)]);
  }

  function renderMarkdown(source, { decorate } = {}) {
    const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
    const html = [];
    let i = 0;
    const para = [];
    const flush = () => {
      if (para.length) {
        html.push(`<p>${inline(esc(para.join("\n")).replace(/\n/g, "<br>"), decorate)}</p>`);
        para.length = 0;
      }
    };
    const isList = (l) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if ((m = line.match(/^```(\w*)\s*$/))) {
        flush();
        const lang = m[1];
        const buf = [];
        i += 1;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
        i += 1;
        html.push(`<pre><code${lang ? ` class="lang-${esc(lang)}"` : ""}>${esc(buf.join("\n"))}</code></pre>`);
        continue;
      }
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        flush();
        const level = Math.min(6, m[1].length + 3); // one step smaller than written; never competes with the page
        html.push(`<h${level}>${inline(esc(m[2]), decorate)}</h${level}>`);
        i += 1;
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flush();
        html.push("<hr>");
        i += 1;
        continue;
      }
      if (/^>\s?/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
        html.push(`<blockquote>${renderMarkdown(buf.join("\n"), { decorate })}</blockquote>`);
        continue;
      }
      if (isList(line)) {
        flush();
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        while (i < lines.length && isList(lines[i])) {
          let item = lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, "");
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !isList(lines[i])) item += ` ${lines[i++].trim()}`;
          items.push(`<li>${inline(esc(item), decorate)}</li>`);
        }
        html.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
        continue;
      }
      if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        flush();
        const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(esc(c.trim()), decorate));
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        html.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }
      if (!line.trim()) {
        flush();
        i += 1;
        continue;
      }
      para.push(line);
      i += 1;
    }
    flush();
    return html.join("");
  }

  window.renderMarkdown = renderMarkdown;
})();
