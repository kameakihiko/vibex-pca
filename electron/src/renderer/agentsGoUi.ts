// Small helpers for the Agents, Inbox and Go views (renderer/agents.ts, inbox.ts, go.ts).

export const api = (window as any).vibex;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/// An error from the main process without Electron's wrapper words.
export const plain = (error: unknown) => String(error).replace(/^Error: (Error invoking remote method '[^']+': )?(\w*Error: )?/, '');

export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/// A short message at the bottom right that goes away by itself.
export function toast(title: string, message: string | null, seconds = 6): void {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div');
    box.id = 'toasts';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.append(box);
  }
  const item = h('div', 'toast');
  item.append(h('strong', 'toast-title', title));
  if (message) item.append(h('span', 'toast-text', message));
  box.append(item);
  setTimeout(() => item.remove(), seconds * 1000);
}
