import { icon } from './icons';

// Document tabs in the middle column: a diff, a note, a file. They sit in the browser column's tab strip, per project.
// While one is on screen the page's native view is hidden, because a native view paints over the DOM.

export interface Doc {
  key: string; title: string; icon: string; element: HTMLElement;
  /// Runs when the person closes the tab, so an editor can save what is unsaved.
  onClose?: () => void;
}

const docs = new Map<string, Doc[]>();
const active = new Map<string, string | null>();
let project: string | null = null;
let changed: () => void = () => {};

/// `onChange` runs when the document on screen changes, so the renderer can place the native view again.
export function setupDocs(onChange: () => void): void {
  changed = onChange;
  // A closed project takes its document tabs with it, each saving what is unsaved first.
  (window as any).vibex?.projects?.onChanged?.((snapshot: { projects: { id: string }[] }) => {
    const open = new Set(snapshot.projects.map((p) => p.id));
    for (const id of [...docs.keys()]) {
      if (open.has(id)) continue;
      for (const doc of docs.get(id) ?? []) doc.onClose?.();
      docs.delete(id);
      active.delete(id);
    }
    if (project && !open.has(project)) project = null;
    paint();
  });
}

export function docOnScreen(): Doc | null {
  if (!project) return null;
  const key = active.get(project);
  return docs.get(project)?.find((d) => d.key === key) ?? null;
}

/// Opens the document, or shows it when this key is open already. A new element replaces the old one.
export function openDoc(projectId: string, doc: Doc): void {
  const list = docs.get(projectId) ?? [];
  const at = list.findIndex((d) => d.key === doc.key);
  if (at >= 0) list[at] = doc;
  else list.push(doc);
  docs.set(projectId, list);
  active.set(projectId, doc.key);
  paint();
}

export function closeDoc(projectId: string, key: string): void {
  (docs.get(projectId) ?? []).find((d) => d.key === key)?.onClose?.();
  const list = (docs.get(projectId) ?? []).filter((d) => d.key !== key);
  docs.set(projectId, list);
  if (active.get(projectId) === key) active.set(projectId, null);
  paint();
}

/// The person went back to the page tab.
export function showPage(): void {
  if (project) active.set(project, null);
  paint();
}

export function showDocsOf(projectId: string | null): void {
  project = projectId;
  paint();
}

function paint(): void {
  const strip = document.getElementById('doc-tabs');
  const view = document.getElementById('doc-view');
  if (!strip || !view) return;
  const shown = docOnScreen();
  strip.replaceChildren(...(project ? docs.get(project) ?? [] : []).map((doc) => {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.dataset.doc = doc.key;
    tab.setAttribute('aria-selected', String(doc === shown));
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = doc.title;
    const close = document.createElement('button');
    close.className = 'close';
    close.title = 'Close';
    close.setAttribute('aria-label', `Close ${doc.title}`);
    close.append(icon('close'));
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      if (project) closeDoc(project, doc.key);
    });
    tab.append(icon(doc.icon, 'tab-icon'), label, close);
    tab.addEventListener('click', () => {
      if (project) openDoc(project, doc);
    });
    return tab;
  }));
  view.replaceChildren(...(shown ? [shown.element] : []));
  view.hidden = !shown;
  document.getElementById('urlbar')!.hidden = !!shown;
  document.getElementById('browser-view')!.hidden = !!shown;
  document.getElementById('browser-tabs')?.querySelector('.tab')?.setAttribute('aria-selected', String(!shown));
  changed();
}
