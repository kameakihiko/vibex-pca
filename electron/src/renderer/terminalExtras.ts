import type { Terminal } from '@xterm/xterm';

// Find and web addresses in a terminal tab, with the xterm core only (no addon, no new dependency).

/// Each web address in a line of text, with no trailing punctuation.
export function linkRanges(text: string): { start: number; end: number; url: string }[] {
  const out: { start: number; end: number; url: string }[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s"'`<>\\^{}|]+/g)) {
    let url = match[0].replace(/[.,;:!?'"]+$/, '');
    // A closing bracket stays only when the address opened one: (see http://a.b/c) ends at c, http://a.b/(c) keeps it.
    while (/[)\]]$/.test(url) && (url.match(/[([]/g)?.length ?? 0) < (url.match(/[)\]]/g)?.length ?? 0)) url = url.slice(0, -1).replace(/[.,;:!?'"]+$/, '');
    if (url.length > 'https://'.length) out.push({ start: match.index, end: match.index + url.length, url });
  }
  return out;
}

/// A wrapped line is one line of text across several rows; an address often wraps. Rows are 0-based here.
function logicalLine(term: Terminal, row: number): { first: number; text: string } {
  const buffer = term.buffer.active;
  let first = row;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let last = row;
  while (buffer.getLine(last + 1)?.isWrapped) last++;
  let text = '';
  for (let r = first; r <= last; r++) text += buffer.getLine(r)?.translateToString(r === last) ?? '';
  return { first, text };
}

/// Opens a web address with Ctrl or Cmd and a click: a plain click selects text, as in any terminal, and output from a
/// program or a server opens nothing by itself.
export function addLinks(term: Terminal, open: (url: string) => void): void {
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const row = y - 1;
      const { first, text } = logicalLine(term, row);
      const at = (index: number) => ({ x: (index % term.cols) + 1, y: first + Math.floor(index / term.cols) + 1 });
      const links = linkRanges(text).map((link) => ({
        text: link.url,
        range: { start: at(link.start), end: at(link.end - 1) },
        activate: (event: MouseEvent) => {
          if (event.ctrlKey || event.metaKey) open(link.url);
        },
      })).filter((link) => link.range.start.y <= y && link.range.end.y >= y);
      callback(links.length ? links : undefined);
    },
  });
}

interface Match { row: number; col: number }

function matchesIn(term: Terminal, query: string): Match[] {
  const wanted = query.toLowerCase();
  const out: Match[] = [];
  if (!wanted) return out;
  const buffer = term.buffer.active;
  for (let row = 0; row < buffer.length; row++) {
    if (buffer.getLine(row)?.isWrapped) continue;
    const { first, text } = logicalLine(term, row);
    const lower = text.toLowerCase();
    for (let at = lower.indexOf(wanted); at >= 0; at = lower.indexOf(wanted, at + wanted.length)) {
      out.push({ row: first + Math.floor(at / term.cols), col: at % term.cols });
    }
  }
  return out;
}

/// The Find bar of one terminal column. Enter goes to the next match, Shift+Enter to the one before, Escape closes.
export function openFind(pane: HTMLElement, term: Terminal, close: () => void): void {
  let bar = pane.querySelector<HTMLElement>('.term-find');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'term-find';
    const box = document.createElement('input');
    box.type = 'text';
    box.placeholder = 'Find';
    box.setAttribute('aria-label', 'Find in this terminal tab');
    box.spellcheck = false;
    const count = document.createElement('span');
    count.className = 'term-find-count';
    bar.append(box, count);
    pane.appendChild(bar);
  }
  const box = bar.querySelector('input')!;
  const count = bar.querySelector<HTMLElement>('.term-find-count')!;
  let matches: Match[] = [];
  let index = 0;
  const show = () => {
    if (!matches.length) {
      term.clearSelection();
      count.textContent = box.value ? 'No results' : '';
      return;
    }
    const match = matches[index];
    term.select(match.col, match.row, box.value.length);
    term.scrollToLine(Math.max(0, match.row - Math.floor(term.rows / 2)));
    count.textContent = `${index + 1} of ${matches.length}`;
  };
  const search = () => {
    matches = matchesIn(term, box.value);
    // The latest output is what a person looks for first.
    index = matches.length - 1;
    show();
  };
  box.oninput = search;
  box.onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      term.clearSelection();
      bar!.remove();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!matches.length) return;
      index = (index + (e.shiftKey ? matches.length - 1 : 1)) % matches.length;
      show();
    }
  };
  box.focus();
  box.select();
  search();
}
