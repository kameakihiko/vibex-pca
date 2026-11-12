import { docOnScreen, openDoc, showPage } from './docs';
import { icon } from './icons';
import { api, clock, h, plain } from './agentsGoUi';

// The Go panel (macOS Vibex: Go/GoPanel.swift): a document tab that shows what Claude asks the owner to approve, exactly.
// Only a hold on Go with the mouse, or a click on Not now, answers it. This file only draws and reports what it shows;
// the main process decides, from the window's own mouse input (main/go.ts). A script here cannot answer.

interface Answer { decision: 'go' | 'declined'; note: string | null; at: number }
interface Request { id: string; title: string; items: string[]; itemsHash: string; reviewUrl: string | null; prUrl: string | null; projectId: string; project: string; createdAt: number; answer?: Answer }
interface GoState { holdMs: number; armMs: number; requests: Request[] }

let state: GoState = { holdMs: 1000, armMs: 1500, requests: [] };
let current: string | null = null;
const panels = new Map<string, HTMLElement>();
const known = new Set<string>();
const selected = new Map<string, string>();
const listeners: ((pending: Map<string, number>) => void)[] = [];
let ticking: ReturnType<typeof setInterval> | null = null;
let drawn = '';

export const onGo = (fn: (pending: Map<string, number>) => void) => listeners.push(fn);

/// The requests that wait for an answer, in every project, oldest first.
export const waitingGo = () => state.requests.filter((r) => !r.answer);

/// Shows the Go panel of the project, also after the person closed its tab. Nothing if no request waits there.
export function openGoPanel(projectId: string): boolean {
  if (!pendingOf(projectId).length) return false;
  const el = panelFor(projectId);
  el.dataset.signature = '';
  openDoc(projectId, { key: 'go', title: 'Go', icon: 'flag', element: el });
  void apply(state);
  return true;
}

const pendingOf = (projectId: string) => state.requests.filter((r) => r.projectId === projectId && !r.answer);

/// The request the panel of this project shows: the newest that arrived, or the one the person picked.
function shownRequest(projectId: string): Request | undefined {
  const pending = pendingOf(projectId);
  return pending.find((r) => r.id === selected.get(projectId)) ?? pending.at(-1);
}

export function startGo(): void {
  api.mod.on('mod:go:changed', (next: GoState) => void apply(next));
  // The same request asked for again, a click on a project's badge, or the menu: the panel opens, shut or not.
  api.mod.on('mod:go:show', (projectId: string) => { openGoPanel(projectId); });
  window.addEventListener('vibex:badge', (e) => { const id = (e as CustomEvent<string>).detail; openGoPanel(id); });
  api.menu.onCommand((name: string) => { if (name === 'go-open' && current) openGoPanel(current); });
  api.projects.onChanged((snapshot: { current: string | null }) => {
    current = snapshot.current;
    tick();
  });
  void api.projects.list().then((snapshot: { current: string | null }) => { current = snapshot.current; });
  void api.mod.invoke('mod:go:state').then((first: GoState) => void apply(first));
}

async function apply(next: GoState): Promise<void> {
  state = next;
  const counts = new Map<string, number>();
  for (const r of state.requests) if (!r.answer) counts.set(r.projectId, (counts.get(r.projectId) ?? 0) + 1);
  for (const fn of listeners) fn(counts);
  // A request nobody has seen opens the panel of its project, and becomes the one shown.
  for (const r of state.requests) {
    if (r.answer || known.has(r.id)) continue;
    known.add(r.id);
    selected.set(r.projectId, r.id);
    openDoc(r.projectId, { key: 'go', title: 'Go', icon: 'flag', element: panelFor(r.projectId) });
  }
  for (const [projectId, el] of panels) {
    const request = shownRequest(projectId);
    const signature = JSON.stringify([projectId, request?.id, pendingOf(projectId).map((r) => r.id), state.requests.filter((r) => r.projectId === projectId && r.answer).map((r) => r.id)]);
    if (el.dataset.signature !== signature) {
      el.dataset.signature = signature;
      draw(projectId, el);
    }
  }
  tick();
}

function panelFor(projectId: string): HTMLElement {
  let el = panels.get(projectId);
  if (!el) {
    el = h('div', 'go-panel');
    el.dataset.project = projectId;
    panels.set(projectId, el);
  }
  return el;
}

function draw(projectId: string, el: HTMLElement): void {
  const pending = pendingOf(projectId);
  const request = shownRequest(projectId);
  const oldNote = (el.querySelector('.go-note') as HTMLInputElement | null)?.value ?? '';
  if (!request) {
    const empty = h('div', 'go-empty');
    empty.append(icon('check', 'go-empty-icon'), h('p', 'empty-title', 'No request is waiting'), h('p', 'empty-text', 'When Claude asks for your go, what it wants to ship or run shows here.'));
    const answered = state.requests.filter((r) => r.projectId === projectId && r.answer).slice(-5).reverse();
    if (answered.length) {
      const last = h('ul', 'go-answered');
      for (const r of answered) last.append(h('li', 'go-answered-item', `${r.answer!.decision === 'go' ? 'Go' : 'Not now'} · ${r.title} · ${clock(r.answer!.at)}`));
      empty.append(last);
    }
    el.replaceChildren(empty);
    return;
  }

  const head = h('div', 'go-head');
  head.append(icon('flag', 'go-head-icon'), h('span', 'go-head-text', pending.length === 1 ? 'Claude asks for your go' : `${pending.length} requests wait for your go`));
  el.replaceChildren(head);
  if (pending.length > 1) {
    const choose = h('div', 'go-choose');
    pending.forEach((r, i) => {
      const b = h('button', 'go-pick', `${i + 1}. ${r.title}`);
      b.setAttribute('aria-pressed', String(r.id === request.id));
      b.addEventListener('click', () => {
        selected.set(projectId, r.id);
        (el.dataset as DOMStringMap).signature = '';
        void apply(state);
      });
      choose.append(b);
    });
    el.append(choose);
  }
  el.append(h('h2', 'go-title', request.title), h('p', 'go-origin', `${request.project} · asked at ${clock(request.createdAt)}`));
  const links = [request.reviewUrl ? { label: 'Review page', url: request.reviewUrl, which: 'review' } : null, request.prUrl ? { label: 'Pull request', url: request.prUrl, which: 'pr' } : null].filter(Boolean) as { label: string; url: string; which: string }[];
  el.append(h('p', 'go-items-head', `What will ship or run (${request.items.length})${links.length ? ', and the links' : ''}:`));
  const scroll = h('div', 'go-scroll');
  const ol = h('ol', 'go-items');
  for (const item of request.items) ol.append(h('li', 'go-item', item));
  scroll.append(ol);
  for (const link of links) {
    const row = h('div', 'go-link');
    row.append(h('span', 'go-link-label', link.label), h('span', 'go-link-url', link.url));
    const open = h('button', 'side-button go-open', 'Open');
    open.addEventListener('click', async () => {
      await api.mod.invoke('mod:go:open', request.id, link.which).catch(() => undefined);
      if (/^https?:/i.test(link.url)) showPage();
    });
    row.append(open);
    scroll.append(row);
  }
  el.append(scroll);

  const note = h('input', 'go-note');
  note.type = 'text';
  note.placeholder = 'A note with your answer (optional)';
  note.setAttribute('aria-label', 'Note with your answer');
  note.maxLength = 300;
  note.value = oldNote;
  const blocker = h('p', 'go-blocker');
  blocker.setAttribute('role', 'status');
  const error = h('p', 'go-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const no = h('button', 'go-no side-button', 'Not now');
  const yes = h('button', 'go-yes', '');
  yes.append(h('span', 'go-bar'), h('span', 'go-yes-label', 'Hold to Go'));
  yes.setAttribute('aria-disabled', 'true');
  const actions = h('div', 'go-actions');
  actions.append(no, yes);
  el.append(note, blocker, error, actions, h('p', 'go-id', `id ${request.id} · items ${request.itemsHash.slice(0, 12)}`));

  const answer = async (decision: 'go' | 'declined') => {
    // The text stays until main has answered: hiding it now would move the button, and main reads the button's place.
    try {
      await api.mod.invoke('mod:go:answer', request.id, decision, note.value || null);
      error.hidden = true;
    } catch (e) {
      error.textContent = plain(e);
      error.hidden = false;
    }
  };
  // Not now: a click by the mouse. The main process checks that its own pointer record has the press and the release.
  no.addEventListener('pointerup', (e) => {
    if (e.isTrusted && e.button === 0) void answer('declined');
  });
  // Go: a hold. The bar fills while the button is held; the answer is asked for when it is full.
  let started = 0;
  let frame = 0;
  const stop = () => {
    started = 0;
    cancelAnimationFrame(frame);
    (yes.querySelector('.go-bar') as HTMLElement).style.width = '0';
  };
  yes.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted || e.button !== 0 || yes.getAttribute('aria-disabled') === 'true') return;
    started = performance.now();
    const hold = state.holdMs + 40;
    const step = () => {
      if (!started) return;
      const elapsed = performance.now() - started;
      (yes.querySelector('.go-bar') as HTMLElement).style.width = `${Math.min(100, (elapsed / hold) * 100)}%`;
      if (elapsed >= hold) {
        started = 0;
        void answer('go');
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) yes.addEventListener(type, stop);
}

let lastShown: string | null = null;
let lastFits: boolean | null = null;

async function tick(): Promise<void> {
  const watching = [...panels.keys()].some((id) => pendingOf(id).length);
  if (!watching) {
    if (ticking) clearInterval(ticking);
    ticking = null;
    if (lastShown !== null) {
      lastShown = null;
      api.mod.send('mod:go:shown', current, null);
    }
    return;
  }
  if (!ticking) ticking = setInterval(() => void tick(), 250);
  const projectId = current;
  const el = projectId ? panels.get(projectId) : undefined;
  const request = projectId ? shownRequest(projectId) : undefined;
  const visible = !!(projectId && el && request && el.isConnected && docOnScreen()?.key === 'go' && !document.hidden);
  const id = visible ? request!.id : null;
  const key = `${projectId}|${id}`;
  if (key !== lastShown) {
    lastShown = key;
    api.mod.send('mod:go:shown', projectId, id);
  }
  if (!visible || !el || !request || !projectId) return;
  const yes = el.querySelector('.go-yes') as HTMLElement | null;
  const no = el.querySelector('.go-no') as HTMLElement | null;
  const scroll = el.querySelector('.go-scroll') as HTMLElement | null;
  if (!yes || !no || !scroll) return;
  const fits = [yes, no].every((b) => {
    const r = b.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
  });
  if (fits !== lastFits) {
    lastFits = fits;
    api.mod.send('mod:go:fits', fits);
  }
  // Every item and link has been on screen when the list fits, or was scrolled to its end.
  if (scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 2) api.mod.send('mod:go:read', request.id);
  const blocker: string | null = await api.mod.invoke('mod:go:blocker', projectId, request.id).catch(() => 'Go is not available now.');
  const text = el.querySelector('.go-blocker');
  if (text && el.isConnected) {
    text.textContent = blocker ?? `Go is on. Move the pointer onto it, then hold it down for ${state.holdMs / 1000} s, until the bar is full. It needs the mouse.`;
    (text as HTMLElement).dataset.armed = String(blocker === null);
  }
  yes.setAttribute('aria-disabled', String(blocker !== null));
}

