import type { ProjectInfo } from './frame';
import type { RendererModule } from './modules';

// The servers part of the window: the add and edit form, the sheets for ssh's questions and the hold, and the Servers
// section with the ports (fork: Servers/AskpassSheet.swift, CommandConfirmation.swift, ServerPortsUI.swift).

const api = () => (window as any).vibex;
const invoke = (channel: string, ...args: unknown[]) => api().mod.invoke(`mod:servers:${channel}`, ...args);
const plainError = (e: unknown) => String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '');

const ARM_MS = 1000;
const HOLD_MS = 1000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// ---------- the form ----------

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return el('label', { className: 'sf-field' }, el('span', { className: 'sf-label' }, label), control, ...(hint ? [el('span', { className: 'sf-hint' }, hint)] : []));
}

function input(id: string, value = '', placeholder = ''): HTMLInputElement {
  return el('input', { id, value, placeholder, type: 'text', spellcheck: false, autocomplete: 'off' });
}

function checkbox(id: string, checked: boolean): HTMLInputElement {
  return el('input', { id, type: 'checkbox', checked });
}

/// A block of a feature inside the add form (the PCA login). `check` says what is missing before Save, in plain words, or null.
export type FormAddOn = (fields: { key: HTMLInputElement; folder: HTMLInputElement }) => { node: HTMLElement; check: () => string | null };

/// `name` null adds a server; `prefill` then fills the form (the PCA offer). The file is the store: main reads it again at
/// Save and refuses what it cannot read.
export async function openServerForm(name: string | null, prefill?: Record<string, any>, addOn?: FormAddOn): Promise<void> {
  document.getElementById('server-form')?.remove();
  let p: any = {};
  const list: { name: string }[] = await api().servers.list();
  if (name) {
    try {
      p = await invoke('get', name);
    } catch {
      return;
    }
  } else if (prefill) {
    p = prefill;
  }
  const nameBox = input('sf-name', p.name ?? '', 'PCA');
  const host = input('sf-host', p.host ?? '', 'server.example');
  const user = input('sf-user', p.user ?? '', 'me');
  const port = input('sf-port', p.port ? String(p.port) : '', '22');
  const login = el('select', { id: 'sf-login' },
    el('option', { value: '' }, 'As my ssh config says'),
    el('option', { value: 'password' }, 'Password'),
    el('option', { value: 'key' }, 'Key file'));
  login.value = p.authentication ?? '';
  const key = input('sf-key', p.identityFile ?? '', '~/.ssh/id_ed25519');
  const folder = input('sf-path', p.projectPath ?? '', '~/app');
  const forward = input('sf-forward', (p.forward ?? []).join(', '), '3000, 8080');
  const jump = el('select', { id: 'sf-jump' }, el('option', { value: '' }, 'None'), ...list.filter((s) => s.name !== name).map((s) => el('option', { value: s.name }, s.name)));
  jump.value = p.jump ?? '';
  const allow = checkbox('sf-allow', !!p.allowClaude);
  const confirm = checkbox('sf-confirm', !!p.confirmCommands);
  const error = el('p', { id: 'sf-error', hidden: true });
  error.setAttribute('role', 'alert');
  const save = el('button', { id: 'sf-save', type: 'submit', className: 'side-button primary' }, 'Save');
  const cancel = el('button', { id: 'sf-cancel', type: 'button', className: 'side-button' }, 'Cancel');
  const remove = el('button', { id: 'sf-remove', type: 'button', className: 'side-button', hidden: !name }, 'Remove Server');
  const extra = addOn?.({ key, folder });
  const form = el('form', { id: 'server-form' },
    el('h2', { className: 'sf-title' }, name ? `Edit ${name}` : 'Add a server'),
    ...(extra ? [extra.node] : []),
    field('Name', nameBox),
    field('Host', host),
    field('User', user),
    field('Port', port),
    field('Login', login, 'A password or passphrase is asked for when ssh needs it, and is never in this file.'),
    field('Key file', key),
    field('Project folder', folder, 'The folder the picker offers first.'),
    field('Forward ports', forward, 'Server ports that open on this computer with the Claude tab.'),
    field('Connect through', jump),
    el('label', { className: 'sf-check' }, allow, el('span', {}, 'Let Claude use this server: list it, open a terminal to it, run in a project on it.')),
    el('label', { className: 'sf-check' }, confirm, el('span', {}, 'Ask before each change: Claude asks, and each command waits until you hold Run.')),
    error,
    el('div', { className: 'sf-buttons' }, remove, cancel, save));
  const close = () => {
    form.remove();
    void invoke('overlay', false);
  };
  const fail = (e: unknown) => {
    error.textContent = plainError(e);
    error.hidden = false;
  };
  cancel.addEventListener('click', close);
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  remove.addEventListener('click', () => {
    void askRemove(name!).then((yes) => {
      if (!yes) return;
      invoke('remove', name).then(close, fail);
    });
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    error.hidden = true;
    const missing = extra?.check();
    if (missing) {
      fail(missing);
      return;
    }
    invoke('save', {
      name: nameBox.value,
      host: host.value,
      user: user.value,
      port: port.value,
      authentication: login.value,
      identityFile: key.value,
      projectPath: folder.value,
      forward: forward.value,
      jump: jump.value,
      allowClaude: allow.checked,
      confirmCommands: confirm.checked,
    }, name).then(close, fail);
  });
  document.body.append(form);
  void invoke('overlay', true);
  nameBox.focus();
}

const askRemove = (name: string): Promise<boolean> => api().mod.invoke('mod:servers:confirm-remove', name);

// ---------- the questions: one on screen at a time, from main ----------

interface HoldForm { kind: 'hold'; title: string; info: string; textLabel: string; text: string; holdTitle: string; refuseTitle: string; verb: string }
interface TypedForm { kind: 'typed'; title: string; note: string; prompt: string; savable: boolean; saveUnavailable?: string }

let sheet: HTMLElement | null = null;

function closeSheet(): void {
  sheet?.remove();
  sheet = null;
}

function showQuestion(q: { id: string; form: HoldForm | TypedForm } | null): void {
  closeSheet();
  if (!q) return;
  const answer = (value: unknown) => {
    // A hold stays on screen until main has read its button for the proof; main's next question message closes it.
    if ((value as { run?: boolean }).run !== true) closeSheet();
    void invoke('answer', q.id, value);
  };
  sheet = el('div', { id: 'vx-question' });
  sheet.dataset.question = q.id;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  if (q.form.kind === 'typed') typedSheet(sheet, q.form, answer);
  else holdSheet(sheet, q.form, answer);
  document.body.append(sheet);
  sheet.querySelector<HTMLElement>('[data-first]')?.focus();
}

function typedSheet(box: HTMLElement, form: TypedForm, answer: (value: unknown) => void): void {
  const field = el('input', { id: 'vxq-input', type: 'password', autocomplete: 'off', spellcheck: false });
  field.dataset.first = 'true';
  const save = el('input', { id: 'vxq-save', type: 'checkbox' });
  const saveRow = el('label', { className: 'sf-check', hidden: !form.savable }, save, el('span', {}, 'Save it in the system store'));
  const ok = el('button', { id: 'vxq-ok', className: 'side-button primary', type: 'submit' }, 'OK');
  const cancel = el('button', { id: 'vxq-cancel', className: 'side-button', type: 'button' }, 'Cancel');
  const panel = el('form', { className: 'vxq-panel' },
    el('h2', { id: 'vxq-title', className: 'sf-title' }, form.title),
    el('p', { id: 'vxq-note', className: 'sf-hint' }, form.note),
    el('pre', { id: 'vxq-prompt' }, form.prompt),
    field,
    saveRow,
    ...(form.saveUnavailable ? [el('p', { className: 'sf-hint' }, form.saveUnavailable)] : []),
    el('div', { className: 'sf-buttons' }, cancel, ok));
  panel.addEventListener('submit', (e) => {
    e.preventDefault();
    if (field.value) answer({ typed: field.value, save: save.checked });
  });
  cancel.addEventListener('click', () => answer({ cancel: true }));
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') answer({ cancel: true });
  });
  box.append(panel);
}

/// The hold: Refuse is the default, also for Return and Escape. Only a press that stays on the button for a second, after
/// the pointer moved onto it and after the sheet stood for a second, counts. No key and no scripted click does.
function holdSheet(box: HTMLElement, form: HoldForm, answer: (value: unknown) => void): void {
  const status = el('p', { id: 'vxq-status', className: 'sf-hint' }, `Wait a second, then press and hold ${form.verb}.`);
  const fill = el('span', { className: 'vxq-fill' });
  const hold = el('button', { id: 'vxq-hold', className: 'side-button', type: 'button', disabled: true }, fill, el('span', { className: 'vxq-label' }, form.holdTitle));
  const refuse = el('button', { id: 'vxq-refuse', className: 'side-button primary', type: 'button' }, form.refuseTitle);
  refuse.dataset.first = 'true';
  const panel = el('div', { className: 'vxq-panel' },
    el('h2', { id: 'vxq-title', className: 'sf-title' }, form.title),
    el('p', { className: 'sf-hint' }, form.info),
    el('span', { className: 'sf-label' }, form.textLabel),
    el('pre', { id: 'vxq-text' }, form.text),
    status,
    el('div', { className: 'sf-buttons' }, refuse, hold));
  box.append(panel);
  const refuseNow = () => answer({ refused: true });
  refuse.addEventListener('click', refuseNow);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
      e.preventDefault();
      refuseNow();
    }
  });
  let armed = false;
  let moved = false;
  let held: number | null = null;
  let tick = 0;
  const cancelHold = (why: string) => {
    held = null;
    cancelAnimationFrame(tick);
    fill.style.width = '0';
    status.textContent = why;
  };
  setTimeout(() => {
    armed = true;
    hold.disabled = false;
    status.textContent = `${form.verb} is on. Move the pointer onto it, then press and hold it for 1 second.`;
  }, ARM_MS);
  hold.addEventListener('pointermove', (e) => { if (e.isTrusted) moved = true; });
  hold.addEventListener('pointerdown', (e) => {
    if (!armed || !e.isTrusted || !moved || e.button !== 0 || !document.hasFocus()) {
      status.textContent = `Move the pointer onto ${form.verb} with the mouse, then press and hold it.`;
      return;
    }
    hold.setPointerCapture(e.pointerId);
    const started = performance.now();
    held = started;
    const step = () => {
      if (held !== started) return;
      const progress = Math.min(1, (performance.now() - started) / HOLD_MS);
      fill.style.width = `${progress * 100}%`;
      if (progress >= 1) answer({ run: true });
      else tick = requestAnimationFrame(step);
    };
    tick = requestAnimationFrame(step);
  });
  hold.addEventListener('pointerup', () => { if (held !== null) cancelHold(`Released before 1 second; press ${form.verb} and hold it.`); });
  hold.addEventListener('pointercancel', () => { if (held !== null) cancelHold(`The hold ended; press ${form.verb} and hold it.`); });
  hold.addEventListener('pointermove', (e) => {
    if (held === null) return;
    const r = hold.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) cancelHold(`The pointer left ${form.verb} during the hold.`);
  });
}

// ---------- a short message ----------

function toast(title: string, message: string): void {
  const box = el('div', { className: 'vx-toast' }, el('strong', {}, title), el('span', {}, message));
  box.setAttribute('role', 'status');
  document.getElementById('vx-toasts')?.append(box);
  setTimeout(() => box.remove(), 8000);
}

// ---------- the Servers section ----------

let rerender: (() => void) | null = null;

/// A feature adds a block at the top of the Servers section (the PCA offer). It gives back null when it has nothing to show.
export const sectionExtras: (() => Promise<HTMLElement | null>)[] = [];

function row(title: string, detail: string, ...buttons: HTMLElement[]): HTMLElement {
  return el('div', { className: 'sv-row' }, el('div', { className: 'sv-text' }, el('span', { className: 'sv-name' }, title), el('span', { className: 'sv-detail' }, detail)), ...buttons);
}

function small(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { className: `side-button ${className}`, type: 'button' }, label);
  b.addEventListener('click', onClick);
  return b;
}

async function renderSection(body: HTMLElement, project: ProjectInfo, live: () => boolean): Promise<void> {
  const state = await invoke('list');
  if (!live()) return;
  const ports = project.server ? await invoke('ports', project.id) : null;
  if (!live()) return;
  const error = el('p', { id: 'sv-error', hidden: true });
  error.setAttribute('role', 'alert');
  const fail = (e: unknown) => {
    error.textContent = plainError(e);
    error.hidden = false;
  };
  const parts: HTMLElement[] = [];
  if (state.problem) parts.push(el('p', { className: 'sv-problem' }, state.problem));
  if (state.askpassProblem) parts.push(el('p', { className: 'sv-problem' }, state.askpassProblem));

  if (project.server && ports) {
    parts.push(el('h3', { className: 'sv-head' }, 'Forwarded ports'));
    if (!ports.forwards.length) parts.push(el('p', { className: 'empty-text' }, 'No port is forwarded. A new port on the server appears here.'));
    for (const f of ports.forwards) {
      const line = row(String(f.serverPort), `127.0.0.1:${f.macPort}${f.auto ? ' · detected' : ''}`,
        small('Open', 'sv-open', () => void api().browser.navigate(`http://127.0.0.1:${f.macPort}/`).catch(fail)),
        small('Stop', 'sv-stop', () => void invoke('stop', project.id, f.macPort).catch(fail)));
      line.classList.add('sv-forward');
      line.dataset.serverPort = String(f.serverPort);
      parts.push(line);
    }
    const number = el('input', { id: 'sv-forward-port', type: 'text', placeholder: 'Server port', autocomplete: 'off', spellcheck: false });
    const go = el('button', { id: 'sv-forward-go', className: 'side-button', type: 'submit' }, 'Forward');
    const forwardForm = el('form', { className: 'sv-forward-form' }, number, go);
    forwardForm.addEventListener('submit', (e) => {
      e.preventDefault();
      error.hidden = true;
      go.disabled = true;
      invoke('forward', project.id, number.value.trim()).catch(fail).finally(() => { go.disabled = false; });
    });
    parts.push(forwardForm);

    parts.push(el('h3', { className: 'sv-head' }, 'Ports on the server'));
    const forwarded = new Set(ports.forwards.map((f: any) => f.serverPort));
    if (ports.error) parts.push(el('p', { className: 'sv-problem' }, ports.error));
    if (!ports.listening.length) parts.push(el('p', { className: 'empty-text' }, 'None seen yet. Press Detect Ports.'));
    for (const l of ports.listening) {
      const line = row(String(l.port), l.host, ...(forwarded.has(l.port) ? [] : [small('Forward', 'sv-port-go', () => void invoke('forward', project.id, l.port).catch(fail))]));
      line.classList.add('sv-port');
      line.dataset.port = String(l.port);
      parts.push(line);
    }
    const detect = el('button', { id: 'sv-detect', className: 'side-button', type: 'button' }, 'Detect Ports');
    detect.addEventListener('click', () => {
      detect.disabled = true;
      invoke('detect', project.id).catch(fail).finally(() => { detect.disabled = false; });
    });
    const auto = el('input', { id: 'sv-auto', type: 'checkbox', checked: ports.auto });
    auto.addEventListener('change', () => void invoke('auto', project.id, auto.checked).catch(fail));
    parts.push(detect, el('label', { className: 'sf-check' }, auto, el('span', {}, 'Forward new ports by themselves')));
  }

  for (const extra of sectionExtras) {
    const block = await extra().catch(() => null);
    if (!live()) return;
    if (block) parts.push(block);
  }

  parts.push(el('h3', { className: 'sv-head' }, 'Saved servers'));
  if (!state.servers.length && !state.problem) parts.push(el('p', { className: 'empty-text' }, 'No servers yet.'));
  for (const s of state.servers) {
    const title = s.secret === 'password' ? 'password' : 'key passphrase';
    const secret = el('input', { type: 'password', className: 'sv-secret', placeholder: `Save a ${title}`, autocomplete: 'off' });
    const form = el('form', { className: 'sv-forward-form', hidden: !state.secretsAvailable }, secret, el('button', { className: 'side-button sv-secret-save', type: 'submit' }, 'Save'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      error.hidden = true;
      invoke('save-secret', s.name, secret.value).then(() => { secret.value = ''; rerender?.(); }, fail);
    });
    const line = row(s.name, `${s.address}${s.confirmCommands ? ' · asks before each change' : ''}${s.hasSecret ? ` · ${title} saved` : ''}`,
      small('Edit', 'sv-edit', () => void openServerForm(s.name)),
      ...(s.hasSecret ? [small('Forget', 'sv-secret-forget', () => void invoke('forget-secret', s.name).then(() => rerender?.(), fail))] : []));
    parts.push(line, form);
  }
  parts.push(small('Add Server', 'sv-add', () => void openServerForm(null)), error);
  body.replaceChildren(...parts);
}

export const serversRenderer: RendererModule = {
  name: 'servers',
  sections: [{
    id: 'servers',
    title: 'Servers',
    icon: 'server',
    label: 'Servers',
    help: 'Servers: saved logins and forwarded ports',
    render: async (body, project, live) => {
      rerender = () => { if (live()) void renderSection(body, project, live); };
      await renderSection(body, project, live);
    },
  }],
  start: () => {
    document.body.append(el('div', { id: 'vx-toasts' }));
    api().mod.on('mod:servers:question', showQuestion);
    api().mod.on('mod:servers:toast', toast);
    api().mod.on('mod:servers:changed', () => rerender?.());
    // A question can come before this window finished loading.
    void invoke('ready');
  },
};
