// A small Markdown renderer for notes: headings, paragraphs, lists and task lists, quotes, code, tables, emphasis,
// links, [[wiki links]] and #tags. A note is untrusted text: every character from the note is escaped, no raw HTML passes,
// and only http(s) links are links. It needs no DOM, so the tests run it in plain Node.

export interface LinkTarget {
  /// The note a link opens (its id), or null when no note has that name.
  wiki: (target: string) => string | null;
  path: (target: string) => string | null;
}

/// The text as a textarea gives it: a textarea turns each CRLF and each lone CR into LF.
export const lf = (text: string) => text.replace(/\r\n?/g, '\n');

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
const unescapeHtml = (text: string) => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[n as string]!);

function inline(raw: string, links: LinkTarget): string {
  const stash: string[] = [];
  const keep = (html: string) => `\u0000${stash.push(html) - 1}\u0000`;
  let text = raw.replace(/\u0000/g, '');
  // Code first: nothing inside it is read.
  text = text.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${escapeHtml(code)}</code>`));
  text = escapeHtml(text);
  text = text.replace(/!?\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g, (_, target: string, shown?: string) => {
    const name = unescapeHtml(target).split('#')[0].trim();
    const label = shown?.trim() || target;
    const id = name ? links.wiki(name) : null;
    return keep(id ? `<a href="#" class="wiki" data-note="${escapeHtml(id)}">${label}</a>` : `<span class="wiki missing" title="No note with that name">${label}</span>`);
  });
  text = text.replace(/!?\[([^\]\n]*)\]\(([^)\s]+)\)/g, (all, shown: string, url: string) => {
    if (all.startsWith('!')) return keep(shown ? `<span class="image">${shown}</span>` : '');
    if (/^https?:\/\//i.test(url)) return keep(`<a href="${url}" class="web" data-web="${url}">${shown || url}</a>`);
    if (/\.md(#.*)?$/i.test(url) && !url.includes('://')) {
      const id = links.path(unescapeHtml(url));
      return keep(id ? `<a href="#" class="wiki" data-note="${escapeHtml(id)}">${shown || url}</a>` : `<span class="wiki missing" title="No note at that path">${shown || url}</span>`);
    }
    // Any other address (javascript:, data:, file:) is shown as text and never becomes a link.
    return keep(`${shown} (${url})`);
  });
  text = text.replace(/(^|[\s(,])#([\p{L}\p{N}_\-/]+)/gu, (all, lead: string, tag: string) =>
    /\P{N}/u.test(tag) ? lead + keep(`<a href="#" class="tag" data-tag="${tag}">#${tag}</a>`) : all);
  text = text
    .replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '<strong>$1</strong>')
    .replace(/~~(?!\s)(.+?)(?<!\s)~~/g, '<del>$1</del>')
    .replace(/==(?!\s)(.+?)(?<!\s)==/g, '<mark>$1</mark>')
    .replace(/(^|[^\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\p{L}\p{N}_])_(?!\s)(.+?)(?<!\s)_(?![\p{L}\p{N}_])/gu, '$1<em>$2</em>');
  return text.replace(/\u0000(\d+)\u0000/g, (_, n) => stash[Number(n)]);
}

interface Item { indent: number; ordered: boolean; text: string }
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*(```|~~~)/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function listItem(line: string): Item | null {
  const m = LIST.exec(line);
  return m ? { indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), text: m[3] } : null;
}

function renderList(items: Item[], links: LinkTarget): string {
  let i = 0;
  const walk = (level: number): string => {
    const tag = items[i].ordered ? 'ol' : 'ul';
    let out = `<${tag}>`;
    while (i < items.length && items[i].indent >= level) {
      if (items[i].indent > level) { out += walk(items[i].indent); continue; }
      const it = items[i++];
      const task = /^\[([ xX])\]\s+(.*)$/.exec(it.text);
      let li = task ? `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ${inline(task[2], links)}` : inline(it.text, links);
      if (i < items.length && items[i].indent > level) li += walk(items[i].indent);
      out += `<li${task ? ' class="task"' : ''}>${li}</li>`;
    }
    return out + `</${tag}>`;
  };
  return walk(items[0].indent);
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

function blocks(lines: string[], links: LinkTarget): string {
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) out.push(`<p>${inline(para.join('\n'), links)}</p>`); para = []; };
  const startsBlock = (i: number) => FENCE.test(lines[i]) || /^#{1,6}\s/.test(lines[i]) || RULE.test(lines[i]) || /^\s*>/.test(lines[i]) || !!listItem(lines[i]);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { flush(); out.push(`<h${heading[1].length}>${inline(heading[2], links)}</h${heading[1].length}>`); continue; }
    if (RULE.test(line)) { flush(); out.push('<hr>'); continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const quote: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
      i--;
      out.push(`<blockquote>${blocks(quote, links)}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(cells(lines[i]));
      i--;
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c, links)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '', links)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (listItem(line)) {
      flush();
      const items: Item[] = [];
      for (; i < lines.length && listItem(lines[i]); i++) items.push(listItem(lines[i])!);
      i--;
      out.push(renderList(items, links));
      continue;
    }
    para.push(line);
    if (i + 1 < lines.length && startsBlock(i + 1)) flush();
  }
  flush();
  return out.join('\n');
}

/// The HTML of a note. The front matter is not shown; it is metadata.
export function renderMarkdown(text: string, links: LinkTarget): string {
  let lines = text.split(/\r\n|\n|\r/);
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end > 0) lines = lines.slice(end + 1);
  }
  return blocks(lines, links);
}
