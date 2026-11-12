import { openDoc } from './docs';
import { api, el, emptyState, iconButton, plain, problem } from './pcaUi';

// Usage, as a tab in the middle column: how often each feature was used on this computer (Support/Usage.swift).
// Counts only, kept on this computer, never sent anywhere.

interface Row { feature: string; last7: number; last30: number }

async function fill(page: HTMLElement): Promise<void> {
  let rows: Row[];
  try {
    rows = await api().mod.invoke('mod:usage:rows');
  } catch (error) {
    page.replaceChildren(problem(plain(error)));
    return;
  }
  const head = el('header', 'doc-head');
  head.append(el('h1', '', 'Usage'), el('p', 'doc-sub', 'Counts only: the name of a feature and how many times. No addresses, commands or names. They stay on this computer.'));
  const bar = el('div', 'tool-head');
  bar.append(el('span', 'tool-head-title', 'Last 30 days'), iconButton('refresh', 'Refresh', () => void fill(page)));
  const parts: HTMLElement[] = [head, bar];
  if (!rows.length) parts.push(emptyState('Nothing counted yet', 'Each time you use a feature, Vibex adds one to its count.'));
  else {
    const table = el('table', 'usage-table');
    const header = el('tr');
    for (const t of ['Feature', '7 days', '30 days']) header.append(el('th', '', t));
    table.append(header);
    for (const r of rows) {
      const line = el('tr');
      line.dataset.feature = r.feature;
      line.append(el('td', 'feature', r.feature), el('td', 'num', String(r.last7)), el('td', 'num', String(r.last30)));
      table.append(line);
    }
    parts.push(table);
  }
  page.replaceChildren(...parts);
}

export function openUsage(projectId: string): void {
  const page = el('div', 'doc-page');
  openDoc(projectId, { key: 'usage', title: 'Usage', icon: 'barChart', element: page });
  void fill(page);
}
