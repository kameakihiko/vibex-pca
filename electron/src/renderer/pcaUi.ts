import { icon } from './icons';

// Small helpers the PCA tools share. Text always goes in with textContent, never as HTML.

export const api = (): any => (window as any).vibex;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function button(label: string, onClick: () => void, className = 'side-button'): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/// A small icon button for a row. `help` is both the tooltip and the name a screen reader says.
export function iconButton(name: string, help: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'icon-button row-action');
  b.type = 'button';
  b.title = help;
  b.setAttribute('aria-label', help);
  b.append(icon(name));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

export function emptyState(title: string, text: string): HTMLElement {
  const box = el('div', 'side-empty');
  box.append(el('p', 'empty-title', title), el('p', 'empty-text', text));
  return box;
}

export function problem(text: string): HTMLElement {
  const p = el('p', 'tools-problem', text);
  p.setAttribute('role', 'alert');
  return p;
}

export function groupHeader(title: string, count?: number): HTMLElement {
  const h = el('div', 'group-header');
  h.append(el('span', 'group-title', title));
  if (count !== undefined) h.append(el('span', 'group-count', String(count)));
  return h;
}

/// The words of an error from main, without Electron's "Error invoking remote method" wrapper.
export function plain(error: unknown): string {
  return String((error as any)?.message ?? error).replace(/^Error invoking remote method '[^']*': (Error: )?/, '').replace(/^Error: /, '');
}

/// Counts one use of a feature, by a fixed name. Nothing else about it is kept.
export function count(key: string): void {
  api().mod.send('mod:usage:count', key);
}

export const MOD = (): string => (api().platform === 'darwin' ? 'Cmd' : 'Ctrl');
