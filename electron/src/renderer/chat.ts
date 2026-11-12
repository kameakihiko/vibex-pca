import { api, count, plain, toast } from './agentsGoUi';
import { chatFirstEdition } from './chatFirst';
import { openFile } from './filesGit';
import { icon } from './icons';
import { renderMarkdown } from './markdown';
import { button, el } from './pcaUi';
import { openSetup } from './setup';
import { answerOn, reachedEnd, MODES, modeOf, nextMode, suggestions, toolSummary, verbFor, type Suggestion } from './chatText';
import { uploadLine, type ChipUpload } from './chatUploadText';
import type { createFrame, ProjectInfo } from './frame';

// The native Claude tab in the window (macOS Vibex: Vibex/Claude/ClaudeChatView.swift). The process and the state live in main
// (main/chat.ts); this file mirrors them, as the terminal tabs mirror their PTYs. Everything Claude says goes in with
// textContent or through markdown.ts, which makes no element from its text. An answer to a card goes to main with how the
// person gave it, and main checks that against the window's own input; a click here alone answers nothing (main/chatGate.ts).

type Item =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'attachments'; images: { mediaType: string; data: string }[]; files: string[] }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'tool'; tool: { id: string; name: string; input: Record<string, string> }; result: { text: string; images: { mediaType: string; data: string }[]; isError: boolean } | null }
  | { id: string; kind: 'notice'; message: string; isError: boolean; action?: 'signin' | 'setup' }
  | { id: string; kind: 'needsTerminal'; command: string }
  | { id: string; kind: 'done'; seconds: number };

interface Card {
  card: string; name: string; toolId: string; input: Record<string, string>; rows: { key: string; value: string }[]; canAlways: boolean; alwaysHelp: string;
  /// Only the start of a long value is here. Why Allow is off for good. What to know about the marks in a file's text.
  cut?: boolean; noAllow?: string | null; note?: string | null;
}

interface State {
  session: string | null; busy: boolean; mode: string; model: string; modelTitle: string; contextPercent: number | null; status: string | null;
  pendingTool: { name: string; input: Record<string, string> } | null; turnStarted: number | null; title: string; loadingHistory: boolean; trusted: boolean;
  project: string; folder: string;
  /// A chat of a project on a server: its name, and whether the server is being asked about the folder now.
  server?: string | null; trustChecking?: boolean;
  commands: { name: string; summary: string; argumentHint: string }[];
  models: { value: string; title: string; summary: string; effortLevels: string[] }[];
  attachments: { id: string; kind: 'image' | 'file'; name: string | null; preview?: string; upload?: ChipUpload | null }[];
  /// Files of a server chat are going to the server (main/chatUpload.ts).
  uploading?: boolean;
  permissions: Card[];
}

export interface ChatHost {
  /// Shows a tab a person asked for, and gives it the keyboard.
  opened: (id: number) => void;
  /// Shows a tab, with the keyboard or without.
  select: (id: number, focus?: boolean) => void;
  frame: () => ReturnType<typeof createFrame>;
}

let host: ChatHost | null = null;
export const setChatHost = (next: ChatHost) => { host = next; };

const views = new Map<number, ChatView>();
const isMac = () => api.platform === 'darwin';
const CTRL = () => (isMac() ? 'Cmd' : 'Ctrl');

/// Main stamps a card's time when it hears of it. The buttons turn on after that, so the first press counts.
const ARM_SHOWN_MS = 560;
const AGENTS_EVERY_MS = 15_000;
const STARTERS: [string, string][] = [
  ['Explain how this project is put together', 'book'],
  ['Find a bug and fix it', 'search'],
  ['Build and run this project, then check it works', 'play'],
];

const duration = (seconds: number) => (seconds < 60 ? `${Math.round(seconds)}s` : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`);
const shortName = (file: string) => file.split(/[\\/]/).pop() ?? file;
const imageSource = (i: { mediaType: string; data: string }) => `data:${i.mediaType};base64,${i.data}`;

function image(source: string, className: string): HTMLImageElement {
  const img = el('img', className);
  img.src = source;
  img.alt = '';
  return img;
}

/// Claude's words. A link opens in the side browser only, under the same rule as a link in a terminal; any other kind of link
/// stays plain words.
function markdown(text: string): HTMLElement {
  const root = renderMarkdown(`\n${text}`, {
    link: (label, url) => {
      if (!/^https?:\/\//i.test(url)) return document.createTextNode(label);
      const a = el('a', 'chat-link', label);
      a.href = '#';
      a.title = url;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        void api.mod.invoke('mod:browser:terminal-link', url).then((answer: { opened: boolean; message?: string }) => {
          if (!answer.opened) toast('The link did not open', answer.message ?? null);
        }).catch((error: unknown) => toast('The link did not open', plain(error)));
      });
      return a;
    },
  });
  root.classList.add('chat-md');
  return root;
}

class ChatView {
  readonly root = el('div', 'chat');
  private state: State | null = null;
  private items: Item[] = [];
  private rows = new Map<string, HTMLElement>();
  private expanded = new Set<string>();
  private cards = new Map<string, { el: HTMLElement }>();
  private following = true;
  private lastTop = 0;
  private lastHeight = 0;
  private menu: Suggestion[] = [];
  private highlighted = 0;
  private menuDismissed = false;
  private files: string[] | null = null;
  private sessions: { id: string; title: string; date: number }[] = [];
  private historyIndex: number | null = null;
  private agentMode = false;
  private agentsReady = false;
  private agentTimer: ReturnType<typeof setInterval> | undefined;
  private clock: ReturnType<typeof setInterval> | undefined;
  private popup: HTMLElement | null = null;
  private recentsShown = '';

  private readonly agents = el('div', 'chat-agents');
  private readonly trust = el('div', 'chat-trust');
  private readonly trustTitle = el('p', 'chat-trust-title', 'Claude Code has not been trusted in this folder');
  private readonly trustText = el('p', 'chat-trust-text', 'A folder\'s own settings and hooks run once it is trusted. A chat cannot show that question, so answer it once in a terminal Claude tab, then check again.');
  private readonly scroll = el('div', 'chat-scroll');
  private readonly list = el('div', 'chat-items');
  private readonly cardBox = el('div', 'chat-cards');
  private readonly working = el('div', 'chat-working');
  private readonly workingText = el('span', 'chat-working-text');
  private readonly workingTime = el('span', 'chat-working-time');
  private readonly empty = el('div', 'chat-empty');
  private readonly recents = el('div', 'chat-recents');
  private readonly follow = el('button', 'chat-follow');
  private readonly composer = el('div', 'chat-composer');
  private readonly suggest = el('div', 'chat-suggest');
  private readonly chips = el('div', 'chat-chips');
  readonly input = el('textarea', 'chat-input');
  private readonly modeButton = el('button', 'chat-control chat-mode');
  private readonly modelButton = el('button', 'chat-control chat-model');
  /// The chat-first edition folds the mode and the model into this one button (chat-first plan, part P3).
  private readonly moreButton = el('button', 'chat-control chat-more');
  private readonly folded = chatFirstEdition();
  private readonly context = el('button', 'chat-control chat-context');
  private readonly agentToggle = el('button', 'chat-control chat-agent-toggle');
  private readonly stop = el('button', 'chat-stop');
  private readonly send = el('button', 'chat-send');

  constructor(readonly id: number, readonly surface: HTMLElement) {
    surface.classList.add('chat-surface');
    surface.dataset.tab = String(id);
    surface.append(this.root);
    this.build();
    void api.mod.invoke('mod:chat:open', id).then((first: { items: Item[]; state: State }) => {
      this.setItems(first.items);
      this.setState(first.state);
    }).catch(() => undefined);
    this.agentTimer = setInterval(() => { if (this.onScreen()) void this.loadAgents(); }, AGENTS_EVERY_MS);
  }

  waitsIn(project: string): boolean {
    return this.state?.project === project && this.state.permissions.length > 0;
  }

  private onScreen(): boolean {
    return this.surface.classList.contains('active') && this.state?.project === host?.frame().current()?.id;
  }

  // ---------- building

  private build(): void {
    this.agents.hidden = true;
    this.trust.hidden = true;
    this.trust.append(this.trustTitle, this.trustText);
    const trustRow = el('div', 'chat-row');
    trustRow.append(
      button('Open Claude in Terminal', () => this.openTerminal(), 'side-button primary chat-trust-open'),
      button('Check Again', () => void api.mod.invoke('mod:chat:check-trust', this.id), 'side-button chat-trust-check'),
    );
    this.trust.append(trustRow);

    this.empty.hidden = true;
    const welcome = el('div', 'chat-welcome');
    welcome.append(icon('sparkles', 'chat-welcome-icon'), el('h2', 'chat-welcome-title', 'What should we build?'), el('p', 'chat-welcome-text', 'Claude can see the browser next to this tab, and check its own work.'));
    const starters = el('div', 'chat-starters');
    for (const [text, name] of STARTERS) {
      const row = button('', () => void this.submit(text), 'chat-starter');
      row.append(icon(name), el('span', 'chat-starter-text', text));
      starters.append(row);
    }
    welcome.append(starters, this.recents);
    this.recents.hidden = true;
    welcome.append(
      el('p', 'chat-tip', `Want to try several ideas at once? ${CTRL()}+Return starts a message as its own agent, on its own branch.`),
      button('Open a terminal instead', () => this.openTerminal(), 'chat-open-terminal'),
    );
    this.empty.append(welcome);

    const spinner = el('span', 'chat-spinner');
    this.working.hidden = true;
    this.working.append(spinner, this.workingText, this.workingTime);
    this.scroll.append(this.list, this.cardBox, this.working);
    this.scroll.addEventListener('scroll', () => this.scrolled());
    // The composer grew, or the agents' strip came: the end stays in view.
    new ResizeObserver(() => { if (this.following && !this.scroll.hidden) this.toEnd(); }).observe(this.scroll);
    this.follow.hidden = true;
    this.follow.type = 'button';
    this.follow.addEventListener('click', () => {
      this.following = true;
      this.toEnd();
      this.follow.hidden = true;
    });

    const stage = el('div', 'chat-stage');
    stage.append(this.empty, this.scroll, this.follow);

    this.suggest.hidden = true;
    this.chips.hidden = true;
    this.input.rows = 1;
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', 'Message to Claude');
    this.input.addEventListener('input', () => this.typed());
    this.input.addEventListener('keydown', (e) => this.key(e));
    this.input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      this.takeFiles(files);
    });
    this.root.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.root.classList.add('chat-dropping');
    });
    this.root.addEventListener('dragleave', (e) => {
      if (e.target === this.root) this.root.classList.remove('chat-dropping');
    });
    this.root.addEventListener('drop', (e) => {
      e.preventDefault();
      this.root.classList.remove('chat-dropping');
      this.takeFiles([...(e.dataTransfer?.files ?? [])]);
      this.input.focus();
    });

    const attach = el('button', 'chat-control chat-attach');
    attach.type = 'button';
    attach.title = 'Attach images or files. You can also drop them here, or paste a screenshot.';
    attach.setAttribute('aria-label', 'Attach');
    attach.append(icon('plus'));
    attach.addEventListener('click', () => void api.mod.invoke('mod:chat:attach', this.id).catch((e: unknown) => toast('Nothing was attached', plain(e))));

    this.modeButton.type = 'button';
    this.modeButton.addEventListener('click', () => this.openModeMenu());
    this.modelButton.type = 'button';
    this.modelButton.title = 'Model';
    this.modelButton.addEventListener('click', () => this.openModelMenu());
    this.moreButton.type = 'button';
    this.moreButton.setAttribute('aria-haspopup', 'menu');
    this.moreButton.addEventListener('click', () => this.openMoreMenu());
    this.modeButton.hidden = this.folded;
    this.modelButton.hidden = this.folded;
    this.moreButton.hidden = !this.folded;
    this.context.type = 'button';
    this.context.hidden = true;
    this.context.addEventListener('click', () => void this.submit('/compact'));
    this.agentToggle.type = 'button';
    this.agentToggle.hidden = true;
    this.agentToggle.append(icon('branch'), el('span', 'chat-control-text', 'Agent'));
    this.agentToggle.title = `Run this message as a parallel agent, on its own branch (${CTRL()}+Return)`;
    this.agentToggle.addEventListener('click', () => {
      this.agentMode = !this.agentMode;
      this.paintComposer();
      this.input.focus();
    });
    this.stop.type = 'button';
    this.stop.hidden = true;
    this.stop.title = 'Stop (Esc)';
    this.stop.setAttribute('aria-label', 'Stop');
    this.stop.append(icon('stop'));
    this.stop.addEventListener('click', () => void api.mod.invoke('mod:chat:stop', this.id));
    this.send.type = 'button';
    this.send.setAttribute('aria-label', 'Send');
    this.send.addEventListener('click', () => void this.submit(this.input.value));

    const controls = el('div', 'chat-controls');
    controls.append(attach, this.modeButton, this.modelButton, this.moreButton, el('span', 'chat-spacer'), this.context, this.agentToggle, this.stop, this.send);
    this.composer.append(this.suggest, this.chips, this.input, controls);
    const dock = el('div', 'chat-dock');
    dock.append(this.composer);
    this.root.append(this.agents, this.trust, stage, dock);
    this.composer.addEventListener('mousedown', (e) => {
      if (e.target === this.composer || (e.target as HTMLElement).classList.contains('chat-controls')) {
        e.preventDefault();
        this.input.focus();
      }
    });
    this.paintComposer();
  }

  dispose(): void {
    clearInterval(this.agentTimer);
    clearInterval(this.clock);
    this.closePopup();
    this.root.remove();
  }

  // ---------- from main

  setItems(items: Item[]): void {
    this.items = items;
    this.rows.clear();
    this.list.replaceChildren(...items.map((item) => this.rowOf(item)));
    this.afterPaint();
  }

  setItem(item: Item): void {
    const at = this.items.findIndex((i) => i.id === item.id);
    if (at >= 0) this.items[at] = item;
    else this.items.push(item);
    const old = this.rows.get(item.id);
    const row = this.rowOf(item);
    if (old) old.replaceWith(row);
    else this.list.append(row);
    this.afterPaint();
  }

  setState(state: State): void {
    const before = this.state;
    this.state = state;
    if (state.session) this.surface.dataset.session = state.session;
    else delete this.surface.dataset.session;
    this.paintTab(state);
    // While the server is asked, the card waits for its answer instead of showing for a moment.
    this.trust.hidden = state.trusted || state.trustChecking === true;
    if (state.server) {
      this.trustTitle.textContent = `Claude Code has not been trusted in this folder on ${state.server}`;
      this.trustText.textContent = 'A folder\'s own settings and hooks run once it is trusted. A chat cannot show that question, so answer it once in the Claude terminal tab of this project, which runs on the server. Then check again.';
    }
    this.paintCards(state);
    this.paintWorking(state);
    this.paintComposer();
    this.afterPaint();
    // The catalog came while the person was typing.
    if (before?.commands.length !== state.commands.length || before?.models.length !== state.models.length) this.refreshMenu();
    if (!before) {
      void this.loadAgents();
      if (!this.items.length && !state.loadingHistory) void this.loadSessions();
    }
    // A card waits behind nothing: it comes into view however far the person had scrolled.
    if (state.permissions.length > (before?.permissions.length ?? 0)) {
      this.following = true;
      this.toEnd();
    }
    // The turn ended: a tool with no result is no longer running.
    if (before?.busy && !state.busy) {
      for (const item of this.items) if (item.kind === 'tool' && !item.result) this.setItem(item);
    }
    // Tool rows wait behind their card.
    if (before && before.permissions.length !== state.permissions.length) {
      for (const item of this.items) if (item.kind === 'tool') this.rows.get(item.id)!.hidden = this.awaiting(item.tool.id);
    }
  }

  private awaiting(toolId: string): boolean {
    return !!this.state?.permissions.some((p) => p.toolId === toolId);
  }

  private paintTab(state: State): void {
    const tab = document.querySelector<HTMLElement>(`.terminal-pane[data-pane="agent"] .tab[data-tab="${this.id}"]`);
    if (!tab) return;
    tab.classList.toggle('waiting', state.permissions.length > 0);
    tab.title = state.title;
    const label = tab.querySelector<HTMLElement>('.label');
    if (label && label.textContent !== state.title) label.textContent = state.title;
    tab.querySelector('.close')?.setAttribute('aria-label', `Close ${state.title}`);
  }

  // ---------- rows

  private rowOf(item: Item): HTMLElement {
    const row = el('div', 'chat-item');
    row.dataset.kind = item.kind;
    switch (item.kind) {
      case 'user':
        row.append(el('div', 'chat-bubble', item.text));
        break;
      case 'attachments':
        for (const file of item.files) row.append(this.fileChip(file));
        for (const picture of item.images) row.append(image(imageSource(picture), 'chat-sent-image'));
        break;
      case 'text':
        row.append(markdown(item.text));
        break;
      case 'tool':
        this.fillTool(row, item);
        row.hidden = this.awaiting(item.tool.id);
        break;
      case 'needsTerminal': {
        row.classList.add('chat-notice');
        row.append(icon('terminal'), el('span', 'chat-notice-text', `/${item.command} needs Claude Code's terminal view. Open a terminal Claude tab and type it there.`), button('Open in Terminal', () => this.openTerminal(), 'side-button'));
        break;
      }
      case 'notice': {
        row.classList.add('chat-notice');
        row.classList.toggle('error', item.isError);
        row.append(icon(item.isError ? 'alert' : 'info'), el('span', 'chat-notice-text', item.message));
        if (item.action === 'signin') row.append(button('Open Claude in Terminal', () => this.openTerminal(), 'side-button'));
        if (item.action === 'setup') row.append(button('Open Setup', () => openSetup(this.state?.project ?? null), 'side-button'));
        break;
      }
      case 'done':
        row.textContent = item.seconds > 0 ? `Finished in ${duration(item.seconds)}` : 'Finished';
        break;
    }
    this.rows.set(item.id, row);
    return row;
  }

  private fileChip(name: string): HTMLElement {
    const chip = el('span', 'chat-file');
    chip.append(icon('file'), el('span', 'chat-file-name', name));
    return chip;
  }

  private fillTool(row: HTMLElement, item: Extract<Item, { kind: 'tool' }>): void {
    const { tool, result } = item;
    const summary = toolSummary(tool);
    row.classList.toggle('failed', !!result?.isError);
    const head = el('button', 'chat-tool-head');
    head.type = 'button';
    const title = el('span', `chat-tool-title${summary.isCode ? ' code' : ''}`, summary.title);
    head.append(icon(summary.icon, 'chat-tool-icon'), title);
    if (result?.isError) head.append(icon('alert', 'chat-tool-alert'));
    else if (!result && this.state?.busy) head.append(el('span', 'chat-spinner'));
    const open = this.expanded.has(item.id);
    head.setAttribute('aria-expanded', String(open));
    head.append(icon(open ? 'chevronUp' : 'chevronDown', 'chat-tool-chevron'));
    head.addEventListener('click', () => {
      if (open) this.expanded.delete(item.id);
      else this.expanded.add(item.id);
      this.setItem(item);
    });
    row.append(head);
    // A screenshot is the point of the call, so it shows without opening.
    for (const picture of result?.images ?? []) row.append(image(imageSource(picture), 'chat-tool-image'));
    if (open) row.append(this.toolDetails(item));
  }

  private toolDetails({ tool, result }: Extract<Item, { kind: 'tool' }>): HTMLElement {
    const box = el('div', 'chat-tool-details');
    const summary = toolSummary(tool);
    const clip = (text: string) => (text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text);
    const mono = (text: string, tone = '') => box.append(el('pre', `chat-mono ${tone}`, text));
    if (summary.path) {
      const folder = this.state?.folder ?? '';
      const inside = folder && (summary.path.startsWith(`${folder}/`) || summary.path.startsWith(`${folder}\\`));
      const rel = inside ? summary.path.slice(folder.length + 1) : summary.path;
      const project = host?.frame().current();
      if (inside && project) box.append(button(rel, () => void openFile(project as ProjectInfo, rel.replaceAll('\\', '/')), 'chat-path'));
      else box.append(el('span', 'chat-path', rel));
    }
    if (tool.input.old_string !== undefined && tool.input.new_string !== undefined) {
      mono(tool.input.old_string.split('\n').map((l) => `- ${l}`).join('\n'), 'minus');
      mono(tool.input.new_string.split('\n').map((l) => `+ ${l}`).join('\n'), 'plus');
    } else if (tool.name === 'Write' && tool.input.content !== undefined) {
      mono(clip(tool.input.content));
    } else if (result?.text) {
      mono(clip(result.text), result.isError ? 'minus' : '');
    } else if (!summary.path) {
      // Typed text can be a password.
      const typed = /_type$/.test(tool.name);
      mono(Object.keys(tool.input).sort().filter((k) => !(typed && k === 'text')).map((k) => `${k}: ${tool.input[k]}`).join('\n'), 'muted');
    }
    return box;
  }

  // ---------- cards

  private paintCards(state: State): void {
    const live = new Set(state.permissions.map((p) => p.card));
    for (const [card, entry] of this.cards) {
      if (!live.has(card)) {
        entry.el.remove();
        this.cards.delete(card);
      }
    }
    for (const permission of state.permissions) {
      if (this.cards.has(permission.card)) continue;
      const element = this.cardOf(permission);
      this.cards.set(permission.card, { el: element });
      this.cardBox.append(element);
      this.watchCard(permission.card, element);
    }
  }

  /// Main counts a card's time from when it is on screen: another tab or another project hides it, and the time starts over.
  private watchCard(card: string, element: HTMLElement): void {
    const buttons = () => element.querySelectorAll<HTMLButtonElement>('button[data-answer]');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let armed = false;
    // Allow counts only once all of it was there to read. An approval card asks this; a plan or a question does not.
    let read = element.dataset.readFirst !== '1';
    const body = element.querySelector<HTMLElement>('.chat-card-body');
    const hint = element.querySelector<HTMLElement>('.chat-card-hint');
    const paint = () => {
      const noAllow = element.dataset.noAllow === '1';
      buttons().forEach((b) => { b.disabled = !answerOn(b.dataset.answer, armed, read, noAllow); });
      if (hint) hint.hidden = read || noAllow;
    };
    const checkRead = () => {
      if (read || !body || element.dataset.cut === '1' || !reachedEnd(body.scrollTop, body.clientHeight, body.scrollHeight)) return;
      read = true;
      api.mod.send('mod:chat:seen', this.id, card);
      paint();
    };
    body?.addEventListener('scroll', checkRead, { passive: true });
    paint();
    new IntersectionObserver((entries) => {
      const seen = entries.some((e) => e.isIntersecting);
      clearTimeout(timer);
      armed = false;
      if (!seen) return paint();
      api.mod.send('mod:chat:shown', this.id, card);
      // Only once it is on screen: a hidden box has no size, and would count as read.
      checkRead();
      paint();
      timer = setTimeout(() => { armed = true; paint(); }, ARM_SHOWN_MS);
    }).observe(element);
  }

  private cardButton(label: string, card: string, choice: string, className: string, help?: string): HTMLButtonElement {
    const b = el('button', `side-button ${className}`, label);
    b.type = 'button';
    b.dataset.answer = choice;
    if (help) b.title = help;
    b.addEventListener('click', (e) => void this.answer(card, choice, e.detail > 0 ? 'mouse' : 'button-key'));
    return b;
  }

  private async answer(card: string, choice: string, via: string, extra?: unknown): Promise<void> {
    const problem = this.cards.get(card)?.el.querySelector<HTMLElement>('.chat-card-problem');
    if (problem) problem.textContent = '';
    try {
      await api.mod.invoke('mod:chat:answer', this.id, card, choice, via, extra);
      this.input.focus();
    } catch (error) {
      if (problem) problem.textContent = plain(error);
    }
  }

  private cardOf(p: Card): HTMLElement {
    const card = el('div', 'chat-card');
    card.dataset.card = p.card;
    card.setAttribute('role', 'group');
    if (p.name === 'AskUserQuestion') this.questionCard(card, p);
    else if (p.name === 'ExitPlanMode') this.planCard(card, p);
    else this.approvalCard(card, p);
    const problem = el('p', 'chat-card-problem');
    problem.setAttribute('role', 'alert');
    card.append(problem);
    return card;
  }

  private approvalCard(card: HTMLElement, p: Card): void {
    card.setAttribute('aria-label', `Claude wants to ${verbFor(p.name)}`);
    card.append(el('p', 'chat-card-head', `Claude wants to ${verbFor(p.name)}`));
    // All of it, in a scroller: what is approved must be readable before the click.
    const body = el('div', 'chat-card-body');
    this.fillApproval(body, p);
    card.dataset.readFirst = '1';
    if (p.cut) card.dataset.cut = '1';
    if (p.noAllow) card.dataset.noAllow = '1';
    const buttons = el('div', 'chat-row');
    buttons.append(this.cardButton('Allow', p.card, 'allow', 'primary chat-allow', `${CTRL()}+Return`));
    if (p.canAlways) buttons.append(this.cardButton('Always Allow', p.card, 'always', 'chat-always', p.alwaysHelp));
    buttons.append(this.cardButton("Don't Allow", p.card, 'deny', 'chat-deny'));
    card.append(body);
    if (p.noAllow) card.append(el('p', 'chat-card-warning', p.noAllow));
    if (p.note) card.append(el('p', 'chat-card-warning', p.note));
    const hint = el('p', 'chat-card-hint', p.cut ? 'Only the start of this shows. Click Show All, and read to the end. Then Allow turns on.' : 'Scroll this box and read to the end. Then Allow turns on.');
    hint.hidden = true;
    card.append(hint);
    if (p.cut && !p.noAllow) {
      const all = el('button', 'side-button chat-show-all', 'Show All');
      all.type = 'button';
      all.addEventListener('click', () => {
        all.disabled = true;
        void api.mod.invoke('mod:chat:card-whole', this.id, p.card).then((whole: Pick<Card, 'input' | 'rows'>) => {
          this.fillApproval(body, { ...p, ...whole });
          delete card.dataset.cut;
          hint.textContent = 'Scroll this box and read to the end. Then Allow turns on.';
          all.remove();
          body.scrollTop = 0;
          // A text that fits now counts as read, as any other.
          body.dispatchEvent(new Event('scroll'));
        }, (error: unknown) => {
          all.disabled = false;
          const problem = card.querySelector<HTMLElement>('.chat-card-problem');
          if (problem) problem.textContent = plain(error);
        });
      });
      card.append(all);
    }
    card.append(buttons);
  }

  private fillApproval(body: HTMLElement, p: Card): void {
    const folder = this.state?.folder ?? '';
    const file = p.input.file_path;
    const rel = file && (file.startsWith(`${folder}/`) || file.startsWith(`${folder}\\`)) ? file.slice(folder.length + 1) : file;
    body.replaceChildren(el('pre', 'chat-mono strong', p.input.command ?? rel ?? toolSummary(p, false).title));
    if (p.input.old_string !== undefined && p.input.new_string !== undefined) {
      body.append(el('pre', 'chat-mono minus', `- ${p.input.old_string}`), el('pre', 'chat-mono plus', `+ ${p.input.new_string}`));
    }
    for (const row of p.rows) {
      const box = el('div', 'chat-card-row');
      box.append(el('span', 'chat-card-key', row.key), el('pre', 'chat-mono', row.value));
      body.append(box);
    }
  }

  private planCard(card: HTMLElement, p: Card): void {
    card.setAttribute('aria-label', "Claude's plan");
    card.append(el('p', 'chat-card-head', "Claude's plan"));
    const body = el('div', 'chat-card-body');
    if (p.input.plan?.trim()) body.append(markdown(p.input.plan));
    else {
      body.append(el('p', 'chat-card-text', 'Claude finished planning and sent no plan text. Ask it to show the plan, or read what it gives below.'));
      for (const row of p.rows) {
        const box = el('div', 'chat-card-row');
        box.append(el('span', 'chat-card-key', row.key), el('pre', 'chat-mono', row.value));
        body.append(box);
      }
    }
    const buttons = el('div', 'chat-row');
    buttons.append(
      this.cardButton('Start Building', p.card, 'build', 'primary chat-build', 'Edits go ahead; commands still ask'),
      this.cardButton('Build on Auto', p.card, 'build-auto', 'chat-build-auto', 'Claude works on its own and stops only for risky actions'),
      this.cardButton('Keep Planning', p.card, 'keep-planning', 'chat-keep-planning'),
    );
    card.append(body, buttons);
  }

  private questionCard(card: HTMLElement, p: Card): void {
    card.setAttribute('aria-label', 'Claude asks');
    let questions: { question: string; multiSelect?: boolean; options: { label: string; description?: string }[] }[] = [];
    try {
      const parsed = JSON.parse(p.input.questions ?? '[]');
      if (Array.isArray(parsed)) questions = parsed.filter((q) => typeof q?.question === 'string' && Array.isArray(q.options));
    } catch { /* nothing to pick; Skip still answers */ }
    const several = questions.some((q) => q.multiSelect === true);
    // The same words can be asked twice; the answers are named by the words, so they count once.
    const needed = new Set(questions.map((q) => q.question)).size;
    const chosen = new Map<string, Set<string>>();
    const answers = () => Object.fromEntries([...chosen].filter(([, picks]) => picks.size).map(([q, picks]) => [q, [...picks].join(', ')]));
    const body = el('div', 'chat-card-body');
    questions.forEach((q, qi) => {
      const box = el('div', 'chat-question');
      box.append(el('p', 'chat-question-text', q.question));
      q.options.filter((o) => typeof o?.label === 'string').forEach((option, oi) => {
        const b = el('button', 'chat-opt');
        b.type = 'button';
        b.dataset.answer = 'answer';
        b.dataset.opt = `${qi}-${oi}`;
        b.append(el('span', 'chat-opt-label', option.label));
        if (typeof option.description === 'string') b.append(el('span', 'chat-opt-detail', option.description));
        b.addEventListener('click', (e) => {
          const picks = chosen.get(q.question) ?? new Set<string>();
          chosen.set(q.question, picks);
          if (q.multiSelect === true) {
            if (picks.has(option.label)) picks.delete(option.label);
            else picks.add(option.label);
            b.classList.toggle('picked', picks.has(option.label));
          } else {
            picks.clear();
            picks.add(option.label);
            box.querySelectorAll('.chat-opt').forEach((other) => other.classList.toggle('picked', other === b));
          }
          if (!several && Object.keys(answers()).length === needed) void this.answer(p.card, 'answer', e.detail > 0 ? 'mouse' : 'button-key', { option: b.dataset.opt, answers: answers() });
        });
        box.append(b);
      });
      body.append(box);
    });
    const row = el('div', 'chat-row');
    if (several) {
      const done = el('button', 'side-button primary chat-opt-done', 'Done');
      done.type = 'button';
      done.dataset.answer = 'answer';
      done.addEventListener('click', (e) => {
        if (Object.keys(answers()).length < needed) {
          const problem = this.cards.get(p.card)?.el.querySelector<HTMLElement>('.chat-card-problem');
          if (problem) problem.textContent = 'Answer each question first.';
          return;
        }
        void this.answer(p.card, 'answer', e.detail > 0 ? 'mouse' : 'button-key', { option: 'done', answers: answers() });
      });
      row.append(done);
    }
    row.append(this.cardButton('Skip', p.card, 'deny', 'chat-deny'));
    card.append(body, row);
  }

  // ---------- the rest of the transcript

  private paintWorking(state: State): void {
    const on = state.busy && !state.permissions.length;
    this.working.hidden = !on;
    clearInterval(this.clock);
    if (!on) return;
    const file = state.pendingTool?.input.file_path;
    this.workingText.textContent = state.status === 'compacting' ? 'Compacting the conversation…' : state.status ? state.status : file ? `Writing ${shortName(file)}…` : 'Claude is working…';
    const tick = () => {
      const seconds = state.turnStarted ? Math.max(0, Math.floor((Date.now() - state.turnStarted) / 1000)) : 0;
      this.workingTime.textContent = seconds >= 3 ? duration(seconds) : '';
    };
    tick();
    this.clock = setInterval(tick, 1000);
  }

  private afterPaint(): void {
    const state = this.state;
    const isEmpty = !this.items.length && !state?.loadingHistory && !state?.permissions.length && !state?.busy;
    this.empty.hidden = !isEmpty;
    this.scroll.hidden = isEmpty;
    if (!isEmpty && this.following) this.toEnd();
    this.lastHeight = this.scroll.scrollHeight;
  }

  private toEnd(): void {
    this.scroll.scrollTop = this.scroll.scrollHeight;
    this.lastTop = this.scroll.scrollTop;
  }

  /// It follows the newest content until the person scrolls up to read; then it stays put and offers a way back down.
  private scrolled(): void {
    const { scrollTop, scrollHeight, clientHeight } = this.scroll;
    if (scrollHeight - clientHeight - scrollTop < 40) this.following = true;
    else if (scrollTop < this.lastTop && scrollHeight === this.lastHeight) this.following = false;
    this.lastTop = scrollTop;
    this.follow.hidden = this.following;
    this.follow.replaceChildren(icon('arrowDown'), document.createTextNode(this.state?.busy ? 'Follow Along' : 'Latest'));
  }

  // ---------- composer

  private paintComposer(): void {
    const state = this.state;
    this.input.placeholder = this.agentMode ? 'Describe the task. It gets its own branch and its own tab.' : 'Ask Claude to build, fix or explain…  / for commands, @ for files';
    const mode = modeOf(state?.mode ?? 'default');
    this.modeButton.replaceChildren(icon(mode.icon), el('span', 'chat-control-text', mode.title));
    this.modeButton.dataset.mode = mode.value;
    this.modeButton.title = `${mode.summary}. Shift+Tab changes the mode.`;
    this.modelButton.replaceChildren(icon('cpu'), el('span', 'chat-control-text', state?.modelTitle ?? 'Default model'));
    // The default mode needs no word. Another mode stays in sight, so a person always sees that Claude acts differently.
    this.moreButton.replaceChildren(icon('dots'), ...(mode.value === 'default' ? [] : [el('span', 'chat-control-text', mode.title)]));
    this.moreButton.dataset.mode = mode.value;
    this.moreButton.setAttribute('aria-label', mode.value === 'default' ? 'Mode and model' : `Mode and model, mode ${mode.title}`);
    this.moreButton.title = `Mode: ${mode.title}. Model: ${state?.modelTitle ?? 'Default model'}. Shift+Tab changes the mode.`;
    const percent = state?.contextPercent ?? 0;
    this.context.hidden = percent < 50;
    this.context.textContent = `${percent}% full`;
    this.context.classList.toggle('high', percent >= 80);
    this.context.disabled = !!state?.busy;
    this.context.title = `The conversation is ${percent}% of what Claude can hold. Click to compact it.`;
    this.agentToggle.hidden = !this.agentsReady;
    this.agentToggle.classList.toggle('on', this.agentMode);
    this.stop.hidden = !state?.busy && !state?.uploading;
    this.stop.title = state?.uploading ? 'Stop the upload (Esc)' : 'Stop (Esc)';
    const canSend = !!this.input.value.trim() || !!state?.attachments.length;
    this.send.disabled = !canSend || !!state?.uploading;
    this.send.classList.toggle('agent', this.agentMode);
    if (this.agentMode) this.send.textContent = 'Start Agent';
    else if (!this.send.querySelector('svg')) this.send.replaceChildren(icon('arrowUp'));
    this.send.title = this.agentMode ? 'Start this as a new agent (Return)' : `Send (Return). Shift+Return adds a line. ${CTRL()}+Return starts it as a new agent.`;
    this.paintChips();
    this.paintRecents();
    this.grow();
  }

  private paintChips(): void {
    const list = this.state?.attachments ?? [];
    this.chips.hidden = !list.length;
    this.chips.replaceChildren(...list.map((a) => {
      const chip = el('div', 'chat-chip');
      const face = a.preview ? image(a.preview, 'chat-chip-image') : this.fileChip(a.name ?? 'File');
      const remove = el('button', 'chat-chip-remove');
      remove.type = 'button';
      remove.title = 'Remove';
      remove.setAttribute('aria-label', `Remove ${a.name ?? 'image'}`);
      remove.append(icon('close'));
      remove.addEventListener('click', () => void api.mod.invoke('mod:chat:detach', this.id, a.id));
      // A server chat's file: progress while it goes, then a plain error or "On the server". The remove button stays on the
      // file's own corner, also when a long error makes the chip wide.
      const line = uploadLine(a.upload);
      if (!line) {
        chip.append(face, remove);
        return chip;
      }
      chip.classList.add('chat-chip-upload', `chat-chip-${line.tone}`);
      const head = el('div', 'chat-chip-head');
      head.append(face, remove);
      const status = el('span', 'chat-chip-status', line.text);
      status.setAttribute('role', line.tone === 'error' ? 'alert' : 'status');
      chip.append(head, status);
      if (line.bar !== null) {
        const bar = el('span', 'chat-chip-bar');
        const fill = el('span', 'chat-chip-fill');
        fill.style.width = `${line.bar}%`;
        bar.append(fill);
        chip.append(bar);
      }
      return chip;
    }));
  }

  private paintRecents(): void {
    const shown = this.sessions.slice(0, 3);
    const key = shown.map((s) => s.id).join();
    if (key === this.recentsShown) return;
    this.recentsShown = key;
    this.recents.hidden = !shown.length;
    this.recents.replaceChildren(el('p', 'chat-recents-title', 'PICK UP WHERE YOU LEFT OFF'), ...shown.map((s) => {
      const row = button('', () => void api.mod.invoke('mod:chat:resume', this.id, s.id).catch((e: unknown) => toast('That conversation did not open', plain(e))), 'chat-starter chat-recent');
      row.append(icon('clock'), el('span', 'chat-starter-text', s.title));
      return row;
    }));
  }

  private async loadSessions(): Promise<void> {
    this.sessions = await api.mod.invoke('mod:chat:sessions', this.id).catch(() => []);
    this.paintRecents();
    this.refreshMenu();
  }

  private async loadFiles(): Promise<void> {
    this.files = [];
    this.files = await api.mod.invoke('mod:chat:files', this.id).catch(() => []);
    this.refreshMenu();
  }

  private async loadAgents(): Promise<void> {
    if (!this.state) return;
    const list: { state: string; agents: { name: string; path: string; waiting?: string; changes: number; ahead: number }[] } | null = await api.mod.invoke('mod:agents:list', this.state.project).catch(() => null);
    this.agentsReady = list?.state === 'ready';
    this.agentToggle.hidden = !this.agentsReady;
    const agents = list?.agents ?? [];
    this.agents.hidden = !agents.length;
    this.agents.replaceChildren(...agents.map((agent) => {
      const pill = el('button', `chat-pill${agent.waiting ? ' waiting' : ''}`);
      pill.type = 'button';
      pill.title = agent.waiting ? `${agent.name}: ${agent.waiting}` : `${agent.name}: ${count(agent.changes, 'change', 'changes')}, ${count(agent.ahead, 'commit', 'commits')} ahead`;
      pill.append(icon('branch'), el('span', 'chat-pill-name', agent.name));
      pill.addEventListener('click', () => host?.frame().activity('agents'));
      return pill;
    }));
  }

  private grow(): void {
    this.input.style.height = 'auto';
    // Up to about ten lines, and less in a small window.
    this.input.style.height = `${Math.min(this.input.scrollHeight, 208)}px`;
  }

  private typed(): void {
    this.highlighted = 0;
    this.menuDismissed = false;
    const prompts = this.prompts();
    if (this.historyIndex !== null && !prompts.includes(this.input.value)) this.historyIndex = null;
    const text = this.input.value;
    if (text.startsWith('/resume ')) void this.loadSessions();
    if (this.files === null && /(^|\s)@\S*$/.test(text)) void this.loadFiles();
    this.refreshMenu();
    this.paintComposer();
  }

  private refreshMenu(): void {
    const text = this.input.value;
    const state = this.state;
    this.menu = this.menuDismissed || !text || !state ? [] : suggestions(text, { commands: state.commands, models: state.models, sessions: this.sessions, files: this.files ?? [] });
    this.highlighted = Math.min(this.highlighted, Math.max(0, this.menu.length - 1));
    this.suggest.hidden = !this.menu.length;
    this.suggest.replaceChildren(...this.menu.map((row, i) => {
      const item = el('button', 'chat-suggest-row');
      item.type = 'button';
      item.setAttribute('aria-selected', String(i === this.highlighted));
      item.append(el('span', `chat-suggest-title${row.isCode ? ' code' : ''}`, row.title), el('span', 'chat-suggest-detail', row.detail));
      item.addEventListener('mousemove', () => {
        if (this.highlighted === i) return;
        this.highlighted = i;
        this.markMenu();
      });
      // The textarea keeps the keyboard.
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => this.choose(row));
      return item;
    }));
  }

  private markMenu(): void {
    this.suggest.querySelectorAll('.chat-suggest-row').forEach((row, i) => {
      row.setAttribute('aria-selected', String(i === this.highlighted));
      if (i === this.highlighted) row.scrollIntoView({ block: 'nearest' });
    });
  }

  private choose(row: Suggestion): void {
    if ('insert' in row.action) {
      this.input.value = row.action.insert;
      this.typed();
    } else {
      const command = row.action.run;
      this.input.value = '';
      this.typed();
      void api.mod.invoke('mod:chat:send', this.id, command);
    }
    this.input.focus();
  }

  private prompts(): string[] {
    return this.items.flatMap((i) => (i.kind === 'user' ? [i.text] : []));
  }

  /// Up and Down walk through what was sent, as in a shell, but only when they would not move the cursor.
  private stepHistory(step: number, e: KeyboardEvent): void {
    const prompts = this.prompts();
    if (!prompts.length || !(this.input.value === '' || this.historyIndex !== null)) return;
    e.preventDefault();
    const next = (this.historyIndex ?? -1) + step;
    if (next < 0) {
      this.historyIndex = null;
      this.input.value = '';
    } else if (next < prompts.length) {
      this.historyIndex = next;
      this.input.value = prompts[prompts.length - 1 - next];
    }
    this.highlighted = 0;
    this.menuDismissed = true;
    this.refreshMenu();
    this.paintComposer();
  }

  private key(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      void api.mod.invoke('mod:chat:mode', this.id, nextMode(this.state?.mode ?? 'default')).catch((error: unknown) => toast('The mode did not change', plain(error)));
      return;
    }
    const rows = this.menu;
    const shortcut = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        if (e.shiftKey || e.altKey) {
          const { selectionStart: at, selectionEnd: end, value } = this.input;
          this.input.value = `${value.slice(0, at)}\n${value.slice(end)}`;
          this.input.selectionStart = this.input.selectionEnd = at + 1;
          this.typed();
        } else if (shortcut) {
          if (!e.isTrusted) return;
          // The first card takes it, as the shortcut of its main button; else it starts an agent.
          const first = this.state?.permissions[0];
          if (first && this.input.value.trim()) {
            // Words in the box were meant for something else: the shortcut allows only from an empty box.
            const problem = this.cards.get(first.card)?.el.querySelector<HTMLElement>('.chat-card-problem');
            if (problem) problem.textContent = `Empty the box to answer with ${CTRL()}+Return, or click a button.`;
          } else if (first && first.name !== 'AskUserQuestion') void this.answer(first.card, first.name === 'ExitPlanMode' ? 'build' : 'allow', 'shortcut');
          else if (!first) void this.startAgent();
        } else if (rows.length) {
          this.choose(rows[this.highlighted]);
        } else {
          void this.submit(this.input.value);
        }
        return;
      case 'Tab':
        if (!rows.length) return;
        e.preventDefault();
        this.input.value = rows[this.highlighted].completion;
        this.typed();
        return;
      case 'ArrowUp':
        if (rows.length) {
          e.preventDefault();
          this.highlighted = (this.highlighted + rows.length - 1) % rows.length;
          this.markMenu();
        } else this.stepHistory(1, e);
        return;
      case 'ArrowDown':
        if (rows.length) {
          e.preventDefault();
          this.highlighted = (this.highlighted + 1) % rows.length;
          this.markMenu();
        } else this.stepHistory(-1, e);
        return;
      case 'Escape':
        if (rows.length) {
          this.menuDismissed = true;
          this.refreshMenu();
        } else if (this.agentMode) {
          this.agentMode = false;
          this.paintComposer();
        } else if (this.state?.busy || this.state?.uploading) {
          void api.mod.invoke('mod:chat:stop', this.id);
        }
        return;
      default:
    }
  }

  private async submit(raw: string): Promise<void> {
    if (!raw.trim() && !this.state?.attachments.length) return;
    if (this.agentMode) return this.startAgent();
    if (this.state?.uploading || this.input.readOnly) return;
    // A server chat with files: they go to the server first, so the words stay in the box until the message has gone.
    if (this.state?.attachments.some((a) => a.upload)) {
      this.input.readOnly = true;
      const sent = await api.mod.invoke('mod:chat:send', this.id, raw).catch((e: unknown) => {
        toast('The message did not go', plain(e));
        return false;
      });
      this.input.readOnly = false;
      if (sent !== false && this.input.value === raw) {
        this.input.value = '';
        this.historyIndex = null;
        this.typed();
      }
      return;
    }
    this.input.value = '';
    this.historyIndex = null;
    this.typed();
    const sent = await api.mod.invoke('mod:chat:send', this.id, raw).catch((e: unknown) => {
      toast('The message did not go', plain(e));
      return false;
    });
    // The words stay when they could not go, unless the person has begun new ones.
    if (sent === false && !this.input.value) {
      this.input.value = raw;
      this.typed();
    }
  }

  private async startAgent(): Promise<void> {
    const task = this.input.value.trim();
    if (!task || !this.state || !this.agentsReady) return;
    this.agentMode = false;
    this.input.value = '';
    this.typed();
    const done: { ok: boolean; message: string } = await api.mod.invoke('mod:agents:create', this.state.project, '', task).catch((e: unknown) => ({ ok: false, message: plain(e) }));
    if (done && done.ok === false) toast('The agent did not start', done.message);
    void this.loadAgents();
  }

  private takeFiles(files: File[]): void {
    const paths: string[] = [];
    for (const file of files) {
      let where = '';
      try {
        where = api.filePath(file) ?? '';
      } catch { /* a file from the page itself has no path */ }
      if (where) paths.push(where);
      else if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = String(reader.result).split(',')[1] ?? '';
          void api.mod.invoke('mod:chat:attach-image', this.id, base64).catch((e: unknown) => toast('Nothing was attached', plain(e)));
        };
        reader.readAsDataURL(file);
      }
    }
    if (paths.length) void api.mod.invoke('mod:chat:attach-paths', this.id, paths).catch((e: unknown) => toast('Nothing was attached', plain(e)));
  }

  private openTerminal(): void {
    void api.mod.invoke('mod:chat:terminal', this.id).catch((e: unknown) => toast('The terminal did not open', plain(e)));
  }

  // ---------- menus

  private closePopup(): void {
    this.popup?.remove();
    this.popup = null;
  }

  private openPopup(anchor: HTMLElement, fill: (add: (title: string, detail: string, on: boolean, run: () => void) => void, group: (title: string) => void) => void): void {
    const wasOpen = this.popup?.dataset.for === anchor.className;
    this.closePopup();
    if (wasOpen) return;
    const popup = el('div', 'chat-popup');
    popup.dataset.for = anchor.className;
    popup.setAttribute('role', 'menu');
    fill((title, detail, on, run) => {
      const row = el('button', 'chat-popup-row');
      row.type = 'button';
      row.setAttribute('role', 'menuitem');
      row.append(on ? icon('check', 'chat-popup-check') : el('span', 'chat-popup-check'));
      const text = el('span', 'chat-popup-text');
      text.append(el('span', 'chat-popup-title', title));
      if (detail) text.append(el('span', 'chat-popup-detail', detail));
      row.append(text);
      row.addEventListener('click', () => {
        this.closePopup();
        run();
        this.input.focus();
      });
      popup.append(row);
    }, (title) => popup.append(el('p', 'chat-popup-group', title)));
    this.root.append(popup);
    const box = this.root.getBoundingClientRect();
    const at = anchor.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(at.left - box.left, box.width - popup.offsetWidth - 8))}px`;
    popup.style.bottom = `${box.bottom - at.top + 6}px`;
    popup.style.maxHeight = `${Math.max(120, at.top - box.top - 16)}px`;
    const away = (e: MouseEvent) => {
      if (popup.contains(e.target as Node)) return;
      document.removeEventListener('mousedown', away, true);
      if (this.popup === popup) this.closePopup();
    };
    document.addEventListener('mousedown', away, true);
    popup.addEventListener('keydown', (e) => { if (e.key === 'Escape') { this.closePopup(); this.input.focus(); } });
    this.popup = popup;
  }

  private openModeMenu(): void {
    this.openPopup(this.modeButton, (add) => this.modeItems(add));
  }

  private openModelMenu(): void {
    if (!this.state) return;
    this.openPopup(this.modelButton, (add, group) => this.modelItems(add, group));
  }

  /// One menu for the mode and the model: the chat-first edition's only control beside Attach.
  private openMoreMenu(): void {
    this.openPopup(this.moreButton, (add, group) => {
      group('Mode');
      this.modeItems(add);
      if (this.state) {
        group('Model');
        this.modelItems(add, group);
      }
    });
  }

  private modeItems(add: (title: string, detail: string, on: boolean, run: () => void) => void): void {
    for (const mode of MODES) add(mode.title, mode.summary, mode.value === (this.state?.mode ?? 'default'), () => void api.mod.invoke('mod:chat:mode', this.id, mode.value).catch((error: unknown) => toast('The mode did not change', plain(error))));
  }

  private modelItems(add: (title: string, detail: string, on: boolean, run: () => void) => void, group: (title: string) => void): void {
    const state = this.state;
    if (!state) return;
    const current = state.model || 'default';
    const pick = (value: string) => () => void api.mod.invoke('mod:chat:model', this.id, value).catch((e: unknown) => toast('The model did not change', plain(e)));
    const older = state.models.filter((m) => m.value.startsWith('claude-'));
    const efforts = state.models.find((m) => m.value === current)?.effortLevels ?? [];
    if (!state.models.length) group('Loading models…');
    for (const m of state.models.filter((x) => !x.value.startsWith('claude-'))) add(m.title, m.summary, m.value === current, pick(m.value));
    if (older.length) {
      group('Older Versions');
      for (const m of older) add(m.title, m.summary, m.value === current, pick(m.value));
    }
    if (efforts.length) {
      group('Effort');
      for (const level of efforts) add(level[0].toUpperCase() + level.slice(1), '', false, () => void api.mod.invoke('mod:chat:send', this.id, `/effort ${level}`));
    }
  }
}

/// The tab's surface in the column: a chat where a terminal would be. renderer.ts treats it as its other tabs.
export function mountChat(id: number, surface: HTMLElement): { term: any; fit: any } {
  const view = new ChatView(id, surface);
  views.set(id, view);
  const noop = () => undefined;
  return {
    term: {
      focus: () => view.input.focus(),
      dispose: () => { view.dispose(); views.delete(id); },
      write: noop,
      onData: () => ({ dispose: noop }),
      cols: 0,
      rows: 0,
    },
    fit: { fit: noop },
  };
}

api.mod.on('mod:chat:item', (id: number, item: Item) => views.get(id)?.setItem(item));
api.mod.on('mod:chat:items', (id: number, items: Item[]) => views.get(id)?.setItems(items));
api.mod.on('mod:chat:state', (id: number, state: State) => views.get(id)?.setState(state));
api.mod.on('mod:chat:opened', (id: number) => host?.opened(id));
api.mod.on('mod:chat:activity', (name: string) => host?.frame().activity(name));
api.mod.on('mod:chat:start-agent', (project: string, task: string) => {
  void api.mod.invoke('mod:agents:create', project, '', task).then((done: { ok: boolean; message: string }) => {
    if (done && done.ok === false) toast('The agent did not start', done.message);
  }).catch((e: unknown) => toast('The agent did not start', plain(e)));
});

/// The Inbox's Show: the chat that waits comes on screen.
window.addEventListener('vibex:show-waiting', (e) => {
  const project = (e as CustomEvent<string>).detail;
  for (const view of views.values()) {
    if (view.waitsIn(project)) {
      host?.select(view.id);
      return;
    }
  }
});

