import { ICONS } from '../../.generated/icons';

// Untitled UI icons, the same set as macOS Vibex.

export function svg(name: string): string {
  const body = ICONS[name];
  if (!body) return '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function paintIcons(): void {
  document.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    if (!el.dataset.painted) {
      el.insertAdjacentHTML('afterbegin', svg(el.dataset.icon!));
      el.dataset.painted = '1';
    }
  });
}

export function icon(name: string, className = ''): HTMLElement {
  const el = document.createElement('span');
  el.dataset.icon = name;
  el.dataset.painted = '1';
  if (className) el.className = className;
  el.innerHTML = svg(name);
  return el;
}
