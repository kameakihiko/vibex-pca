// A small, safe reader for SKILL.md and Claude's replies: headings, lists, quotes, code, tables and plain paragraphs. Text goes
// in with textContent and no link is made clickable unless the caller says how, so the text cannot run anything in the app window.

export interface MarkdownOptions {
  /// What a link becomes. Without it a link is its words.
  link?: (label: string, url: string) => Node;
}

function inline(parent: HTMLElement, text: string, options: MarkdownOptions): void {
  const re = options.link ? /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]*\)|https?:\/\/[^\s<>)\]]+)/g : /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]*\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) parent.append(text.slice(last, m.index));
    const part = m[0];
    if (part.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = part.slice(1, -1);
      parent.append(code);
    } else if (part.startsWith('**')) {
      const b = document.createElement('strong');
      b.textContent = part.slice(2, -2);
      parent.append(b);
    } else if (part.startsWith('[')) {
      const label = part.slice(1, part.indexOf(']'));
      parent.append(options.link ? options.link(label, part.slice(part.indexOf('](') + 2, -1)) : label);
    } else if (part.startsWith('http')) {
      parent.append(options.link!(part, part));
    } else {
      const i = document.createElement('em');
      i.textContent = part.slice(1, -1);
      parent.append(i);
    }
    last = m.index! + part.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

const TABLE_LINE = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;
const cells = (line: string) => line.trim().slice(1, -1).split('|').map((c) => c.trim());

export function renderMarkdown(source: string, options: MarkdownOptions = {}): HTMLElement {
  const root = document.createElement('article');
  root.className = 'markdown';
  let lines = source.replace(/\r\n?/g, '\n').split('\n');
  // The front matter is shown as a name and a description, not as raw text.
  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) lines = lines.slice(end + 1);
  }
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^```/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      const pre = document.createElement('pre');
      pre.textContent = code.join('\n');
      root.append(pre);
      continue;
    }
    if (TABLE_LINE.test(line) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      const table = document.createElement('table');
      const head = table.createTHead().insertRow();
      for (const cell of cells(line)) {
        const th = document.createElement('th');
        inline(th, cell, options);
        head.append(th);
      }
      const body = table.createTBody();
      i += 2;
      while (i < lines.length && TABLE_LINE.test(lines[i])) {
        const row = body.insertRow();
        for (const cell of cells(lines[i])) inline(row.insertCell(), cell, options);
        i++;
      }
      root.append(table);
      continue;
    }
    // [\s\S]: a line can hold U+2028, which `.` does not match and \s does, and the paragraph below would then take nothing.
    const heading = /^(#{1,6})\s+([\s\S]*)$/.exec(line);
    if (heading) {
      const h = document.createElement(`h${Math.min(heading[1].length + 1, 6)}` as 'h2');
      inline(h, heading[2], options);
      root.append(h);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const li = document.createElement('li');
        inline(li, lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''), options);
        list.append(li);
        i++;
      }
      root.append(list);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = document.createElement('blockquote');
      const text: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) text.push(lines[i++].replace(/^>\s?/, ''));
      inline(quote, text.join(' '), options);
      root.append(quote);
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { root.append(document.createElement('hr')); i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|>|\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    // A line that no rule took must still move on, or this loop never ends.
    if (!para.length) para.push(lines[i++]);
    const p = document.createElement('p');
    inline(p, para.join(' '), options);
    root.append(p);
  }
  return root;
}
