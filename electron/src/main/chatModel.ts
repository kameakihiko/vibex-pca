import { randomBytes } from 'node:crypto';
import { allowLine, answerLine, controlLine, declineLine, denyLine, parseChatLine as parseLine, refuseLine, userLine, type ChatCommand, type ChatEvent, type ChatImage, type ChatModelOption, type ChatRequest, type ChatTool, type ChatToolResult } from './chatEvents';
import { loadTranscript, startClaude, type ChatProcess } from './chatProcess';
import { alwaysAllowHelp, onlyRules, permissionRows, shownAbove } from './chatTrust';
import { filePathInPartial, MODES, modeOf, terminalOnlyCommand, type ChatMode } from '../renderer/chatText';

// One Claude Code session without a terminal: runs `claude` in stream-json mode and turns what it says into items for the
// window. It is the real Claude Code, so CLAUDE.md, skills, hooks and MCP servers (Vibex's own too) all apply, and a session
// can be continued with `claude --resume`. Ported from Vibex/Claude/ClaudeChatModel.swift. No Electron here.

export type ChatItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'attachments'; images: ChatImage[]; files: string[] }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'tool'; tool: ChatTool; result: ChatToolResult | null }
  | { id: string; kind: 'notice'; message: string; isError: boolean; action?: 'signin' | 'setup' }
  /// A command only Claude Code's terminal interface has.
  | { id: string; kind: 'needsTerminal'; command: string }
  | { id: string; kind: 'done'; seconds: number };

export type ChatAttachment =
  | { id: string; kind: 'image'; name: string | null; mediaType: string; data: string }
  | { id: string; kind: 'file'; name: string; path: string };

export interface ChatPermission extends ChatRequest {
  /// The name of this card in the page: main's own word, never Claude's.
  card: string;
  rows: { key: string; value: string }[];
  alwaysHelp: string;
}

export interface ChatActions {
  newChat?: () => void;
  resume?: (session: string) => void;
  showSkills?: () => void;
  showMcp?: () => void;
  startAgent?: (task: string) => void;
}

export interface ChatOptions {
  folder: string;
  configDir: string;
  /// Read at each start, so a tab sees what changed while the app runs.
  environment: Record<string, string> | (() => Record<string, string>);
  binary: () => string | null;
  /// Arguments before Claude Code's own: a test's script, when the program is an interpreter.
  leadArgs?: string[];
  /// Starts Claude somewhere else (a project on a server: serverChat.ts) with Claude Code's own arguments. Unset: this computer.
  starter?: (args: string[], on: { line: (line: string) => void; ended: (stderr: string, spawnError: string | null) => void }) => ChatProcess;
  /// Reads a conversation's transcript where Claude keeps it. Unset: under `configDir` on this computer.
  history?: (session: string) => Promise<ChatEvent[]>;
  /// The server's name when Claude runs there, for the words that say where.
  server?: string | null;
  /// The trust answer is being asked for now (a server folder): nothing starts on an old answer.
  trustPending?: () => boolean;
  /// `claude -p` skips the trust dialog, so nothing starts here before it: a cloned repo's settings and hooks would run.
  isTrusted: () => boolean;
  resuming?: string | null;
  name?: string | null;
  /// Keeps what a tab had when it closes.
  mode?: ChatMode;
  model?: string;
  actions?: ChatActions;
  models?: () => ChatModelOption[];
  /// Throws when no person is there. Auto takes the cards away, so each way to it asks this.
  confirmAuto?: () => void;
  /// How long a Stop waits for Claude Code before the app ends it.
  stopGraceMs?: number;
  commandsChanged?: (commands: ChatCommand[]) => void;
  /// Something on screen changed. `item` when only that one row did.
  changed?: (item?: ChatItem) => void;
  /// A card came or went, or the session changed.
  waiting?: () => void;
}

/// What `--model` takes: a word of its own, never another switch.
export const safeModel = (model: string) => /^[A-Za-z0-9][\w.:[\]-]*$/.test(model);
/// A session id goes to `--resume` and into a file name.
export const safeSession = (session: string) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(session);

export function claudeArgs({ resume, mode, model }: { resume: string | null; mode: string; model: string }): string[] {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', mode];
  if (resume) args.push('--resume', resume);
  if (model) args.push('--model', model);
  return args;
}

const STOP_GRACE_MS = 8000;
const newId = () => randomBytes(6).toString('hex');
/// What Claude Code says with no account: the app has no login, so the chat gives the next step.
const NOT_SIGNED_IN = /(not logged in|please run \/login|invalid api key|oauth token (has )?expired|authentication_failed)/i;
const SIGN_IN = 'Claude is not signed in on this computer. Open a Claude terminal tab, type /login and follow the page with your own account. Then send your message again here.';
const NOT_INSTALLED = 'Claude Code is not installed on this computer. Open Setup and click Install Claude Code. On Windows an npm install does not work here; use the installer in Setup.';
const signInOn = (server: string) => `Claude is not signed in on ${server}. Open the Claude terminal tab of this project (it runs on the server), type /login and follow the page. Then send your message again here.`;

export class ChatModel {
  items: ChatItem[] = [];
  busy = false;
  permissions: ChatPermission[] = [];
  session: string | null;
  activeModel: string | null = null;
  contextPercent: number | null = null;
  status: string | null = null;
  pendingTool: ChatTool | null = null;
  turnStarted: number | null = null;
  title: string;
  loadingHistory = false;
  attachments: ChatAttachment[] = [];
  mode: ChatMode;
  model: string;

  private process: ChatProcess | null = null;
  private pendingInput = '';
  /// The text item still receiving deltas.
  private streaming: string | null = null;
  private toolItems = new Map<string, string>();
  private terminalCommands = new Set(['color', 'focus', 'reload-plugins']);
  private ended = false;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private stopFailed = false;
  private foreignMode: string | null = null;
  /// The mode line Claude Code has not answered yet, to go back when it refuses.
  private modeAsked: { id: string; before: ChatMode } | null = null;

  constructor(private readonly o: ChatOptions) {
    this.session = o.resuming ?? null;
    this.title = o.name ?? 'Claude';
    this.mode = o.mode ?? 'default';
    this.model = o.model ?? '';
    if (this.session) this.loadHistory(this.session);
  }

  get needsAttention(): boolean { return this.permissions.length > 0; }
  get pid(): number { return this.process?.pid ?? 0; }

  private add<T extends Omit<ChatItem, 'id'>>(item: T): ChatItem {
    const full = { id: newId(), ...item } as unknown as ChatItem;
    this.items.push(full);
    this.o.changed?.(full);
    return full;
  }

  private notice(message: string, isError = false, action?: 'signin' | 'setup'): void {
    this.add({ kind: 'notice', message, isError, ...(action ? { action } : {}) });
  }

  // ---------- talking to Claude

  /// False when nothing went, so the window can keep the words.
  send(raw: string): boolean {
    const text = raw.trim();
    const attached = this.attachments;
    if (!text && !attached.length) return true;
    if (!attached.length && this.runLocally(text)) return true;
    if (this.o.trustPending?.()) {
      this.notice(`Not sent yet: the app is checking this folder on ${this.o.server ?? 'the server'}. Send again in a moment.`);
      return false;
    }
    if (!this.o.isTrusted()) {
      this.notice(this.o.server ? `Not sent: Claude Code has not been trusted in this folder on ${this.o.server} yet. Trust it there first, then send again.` : 'Not sent: Claude Code has not been trusted in this folder yet. Trust it first, then send again.', true);
      return false;
    }
    if (!this.process && !this.o.binary()) {
      this.notice(NOT_INSTALLED, true, 'setup');
      return false;
    }
    this.attachments = [];
    if (this.title === 'Claude') this.noteTitle(text || 'Attachment');
    const images = attached.flatMap((a) => (a.kind === 'image' ? [{ mediaType: a.mediaType, data: a.data }] : []));
    const files = attached.flatMap((a) => (a.kind === 'file' ? [a] : []));
    if (attached.length) this.add({ kind: 'attachments', images, files: files.map((f) => f.name) });
    if (text) this.add({ kind: 'user', text });
    this.streaming = null;
    if (!this.process) this.start();
    if (!this.process) return false;
    this.busy = true;
    this.turnStarted = Date.now();
    this.write(userLine(ChatModel.withFiles(text, files.map((f) => f.path)), images));
    this.o.changed?.();
    return true;
  }

  /// Files reach Claude as paths, which it reads with its own tools.
  static withFiles(text: string, files: string[]): string {
    if (!files.length) return text;
    return `${text ? `${text}\n\n` : ''}Attached files:\n${files.map((f) => `- ${f}`).join('\n')}`;
  }

  /// Commands the app answers itself: the ones about its own controls, and the ones that need a terminal Claude Code does
  /// not have here. False for everything Claude Code handles.
  private runLocally(text: string): boolean {
    if (!text.startsWith('/')) return false;
    const [name, ...rest] = text.slice(1).split(' ');
    const argument = rest.join(' ').trim();
    const switchMode = (mode: ChatMode) => {
      this.setMode(mode);
      if (argument) this.send(argument);
      else this.notice(`${modeOf(mode).title} mode. ${modeOf(mode).summary}.`);
    };
    switch (name) {
      case 'plan': switchMode('plan'); break;
      case 'auto': switchMode('auto'); break;
      case 'ask': switchMode('default'); break;
      case 'accept-edits': switchMode('acceptEdits'); break;
      case 'new': this.o.actions?.newChat?.(); break;
      case 'agent':
        if (argument) this.o.actions?.startAgent?.(argument);
        else this.notice('Type /agent and a task to start it on its own branch, or press Ctrl+Return to send any message that way.');
        break;
      case 'skills': this.o.actions?.showSkills?.(); break;
      case 'mcp': this.o.actions?.showMcp?.(); break;
      case 'help':
        this.notice('Type / for every command and skill, with what each one does. @ adds a file. Shift+Tab changes the mode.');
        break;
      case 'resume':
        if (!argument) this.notice('Type /resume and a space to pick a conversation.');
        else if (safeSession(argument)) this.o.actions?.resume?.(argument);
        else this.notice('That is not the name of a conversation. Type /resume and a space to pick one.', true);
        break;
      case 'model':
        if (!argument) {
          this.notice(`Using ${this.modelTitle()}. Type /model and a space to pick another.`);
        } else {
          const option = (this.o.models?.() ?? []).find((m) => m.value === argument || m.title.toLowerCase() === argument.toLowerCase());
          const value = option ? option.value : argument;
          if (!safeModel(value)) {
            this.notice('That is not the name of a model. Type /model and a space to pick one.', true);
          } else {
            this.setModel(value === 'default' ? '' : value);
            this.notice(`Using ${this.modelTitle()}.`);
          }
        }
        break;
      default:
        if (!this.terminalCommands.has(name)) return false;
        this.add({ kind: 'needsTerminal', command: name });
    }
    return true;
  }

  /// "Opus 5.5", or the default model by the name Claude Code gives it now.
  modelTitle(): string {
    const models = this.o.models?.() ?? [];
    if (!this.model) {
      const option = models.find((m) => m.value === 'default');
      if (!option) return 'Default model';
      return option.summary.split('·')[0].trim() || option.title;
    }
    return models.find((m) => m.value === this.model)?.title ?? this.model;
  }

  /// `proven`: the caller has its own proof of a person, as a card's button has. Every other road to Auto meets the check here.
  setMode(mode: string, proven = false): void {
    if (!MODES.some((m) => m.value === mode) || mode === this.mode) return;
    if (mode === 'auto' && !proven) this.o.confirmAuto?.();
    const line = controlLine('set_permission_mode', { mode });
    if (this.process) this.modeAsked = { id: JSON.parse(line).request_id, before: this.mode };
    this.mode = mode as ChatMode;
    this.write(line);
    this.o.changed?.();
  }

  setModel(model: string): void {
    if (model !== '' && !safeModel(model)) throw new Error('That is not the name of a model.');
    if (model === this.model) return;
    this.model = model;
    this.write(controlLine('set_model', { model: model || 'default' }));
    this.o.changed?.();
  }

  private noteTitle(text: string): void {
    this.title = text.length > 28 ? `${text.slice(0, 27)}…` : text;
  }

  stopTurn(): void {
    this.write(controlLine('interrupt'));
    if (!this.busy || this.stopTimer) return;
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      if (!this.busy) return;
      // It did not answer: only the end of the program stops it now.
      this.stopFailed = true;
      this.process?.end();
    }, this.o.stopGraceMs ?? STOP_GRACE_MS);
    this.stopTimer.unref?.();
  }

  private clearStop(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
  }

  /// Work after a turn ended is the next turn: a second message sent during the first has one of its own.
  private working(): void {
    if (this.loadingHistory) return;
    let changed = false;
    if (!this.busy && this.process) {
      this.busy = true;
      this.turnStarted = Date.now();
      changed = true;
    }
    if (this.status && this.status !== 'compacting') {
      this.status = null;
      changed = true;
    }
    if (changed) this.o.changed?.();
  }

  private request(id: string): ChatPermission {
    const found = this.permissions.find((p) => p.id === id);
    if (!found) throw new Error('This request no longer waits.');
    return found;
  }

  private answered(request: ChatPermission, line: string): void {
    this.permissions = this.permissions.filter((p) => p.id !== request.id);
    this.write(line);
    this.o.waiting?.();
    this.o.changed?.();
  }

  /// The input goes back as Claude Code sent it. The window names a card and nothing else.
  allow(id: string, always = false): void {
    const request = this.request(id);
    this.answered(request, allowLine(id, request.rawInput, always ? onlyRules(request.suggestions) : null));
  }

  deny(id: string): void {
    this.answered(this.request(id), denyLine(id, "The user said no. Ask what they'd like instead."));
  }

  answer(id: string, answers: Record<string, string>): void {
    const request = this.request(id);
    const questions: { question?: unknown; multiSelect?: unknown; options?: { label?: unknown }[] }[] = Array.isArray((request.rawInput as any)?.questions) ? (request.rawInput as any).questions : [];
    for (const [question, label] of Object.entries(answers)) {
      // The same words can be asked twice, and a question of several choices takes them joined by a comma.
      const asked = questions.filter((q) => q.question === question);
      const known = (word: string) => asked.some((q) => Array.isArray(q.options) && q.options.some((o) => o.label === word));
      const several = asked.some((q) => q.multiSelect === true) && label.split(', ').every(known);
      if (!known(label) && !several) throw new Error(`"${label}" is not an option of that question.`);
    }
    this.add({ kind: 'user', text: Object.values(answers).sort().join(', ') });
    this.answered(request, answerLine(id, request.rawInput, answers));
  }

  /// A line from the app itself, such as a failed check of the server folder.
  say(message: string, isError = false): void {
    this.notice(message, isError);
    this.o.changed?.();
  }

  terminate(): void {
    this.ended = true;
    this.clearStop();
    this.process?.end();
    this.process = null;
    this.busy = false;
    this.permissions = [];
  }

  // ---------- applying events

  apply(event: ChatEvent): void {
    if (this.ended) return;
    switch (event.type) {
      case 'started':
        this.session = event.session;
        this.activeModel = event.model;
        this.o.waiting?.();
        break;
      case 'conversationReset':
        this.session = event.session;
        this.items = [];
        this.toolItems.clear();
        this.streaming = null;
        this.contextPercent = null;
        if (!this.o.name) this.title = 'Claude';
        break;
      case 'status':
        this.status = event.status;
        break;
      case 'permissionMode':
        // What Claude Code is really in shows here, whatever the app last asked. Nothing goes back.
        // Auto needs an account and a model that allow it; say so rather than seem to be on it.
        if (this.mode === 'auto' && event.mode !== 'auto') this.notice("Auto mode isn't available here, so Claude will ask before acting.");
        if (MODES.some((m) => m.value === event.mode)) {
          this.mode = event.mode as ChatMode;
          this.modeAsked = null;
        } else if (event.mode !== this.foreignMode) {
          this.foreignMode = event.mode;
          this.notice(`Claude Code runs in its own mode "${event.mode}" here, from its settings. The button above does not show that one.`);
        }
        break;
      case 'toolStarting':
        this.working();
        this.pendingTool = { id: '', name: event.name, input: {} };
        this.pendingInput = '';
        break;
      case 'toolInputDelta': {
        if (!this.pendingTool || this.pendingTool.input.file_path !== undefined || this.pendingInput.length >= 4000) return;
        this.pendingInput += event.text;
        const file = filePathInPartial(this.pendingInput);
        if (file) this.pendingTool.input.file_path = file;
        break;
      }
      case 'compacted':
        this.notice('Compacted the conversation.');
        break;
      case 'commandsChanged':
        this.o.commandsChanged?.(event.commands);
        break;
      case 'contextUsage':
        this.contextPercent = event.percent;
        break;
      case 'controlFailed':
        if (event.requestId && event.requestId === this.modeAsked?.id) {
          this.mode = this.modeAsked.before;
          this.modeAsked = null;
        }
        this.notice(event.message, true);
        break;
      case 'textDelta': {
        this.working();
        if (this.pendingTool) {
          this.pendingTool = null;
          this.o.changed?.();
        }
        const item = this.streaming ? this.items.find((i) => i.id === this.streaming) : null;
        if (item?.kind === 'text') {
          item.text += event.text;
          this.o.changed?.(item);
        } else {
          this.streaming = this.add({ kind: 'text', text: event.text }).id;
        }
        return;
      }
      case 'text': {
        this.working();
        const command = terminalOnlyCommand(event.text);
        if (command) {
          // A line for this once. Claude's words do not take a command away for later.
          this.add({ kind: 'needsTerminal', command });
          return;
        }
        // The notice at the end of the turn says this, with the next step.
        if (NOT_SIGNED_IN.test(event.text) && event.text.length < 200) return;
        const item = this.streaming ? this.items.find((i) => i.id === this.streaming) : null;
        if (item?.kind === 'text') {
          item.text = event.text;
          this.o.changed?.(item);
        } else {
          const last = this.items.at(-1);
          if (!(last?.kind === 'text' && last.text === event.text)) this.add({ kind: 'text', text: event.text });
        }
        this.streaming = null;
        return;
      }
      case 'toolUse': {
        this.working();
        this.streaming = null;
        if (this.pendingTool) {
          this.pendingTool = null;
          this.o.changed?.();
        }
        // These are the person's turn, not work: the question card or plan card stands in for them.
        if (event.tool.name === 'AskUserQuestion' || event.tool.name === 'ExitPlanMode') return;
        const known = this.toolItems.get(event.tool.id);
        const item = known ? this.items.find((i) => i.id === known) : null;
        if (item?.kind === 'tool') {
          item.tool = event.tool;
          item.result = null;
          this.o.changed?.(item);
        } else {
          this.toolItems.set(event.tool.id, this.add({ kind: 'tool', tool: event.tool, result: null }).id);
        }
        return;
      }
      case 'toolResult': {
        const known = this.toolItems.get(event.result.toolUseId);
        const item = known ? this.items.find((i) => i.id === known) : null;
        if (item?.kind !== 'tool') return;
        item.result = event.result;
        this.o.changed?.(item);
        return;
      }
      case 'userText': {
        const last = this.items.at(-1);
        if (!(last?.kind === 'user' && last.text === event.text)) this.add({ kind: 'user', text: event.text });
        if (this.title === 'Claude') this.noteTitle(event.text);
        return;
      }
      case 'userImages':
        this.add({ kind: 'attachments', images: event.images, files: [] });
        return;
      case 'unanswerable':
        this.write(event.subtype === 'elicitation' ? declineLine(event.id) : refuseLine(event.id, 'This chat cannot show that.'));
        this.notice('Claude asked for something that only its terminal view can show, so the chat said no. Open a terminal Claude tab if this work needs it.');
        break;
      case 'permission': {
        this.working();
        const { request } = event;
        this.permissions.push({
          ...request,
          card: `c${newId()}`,
          rows: permissionRows(request.rawInput, shownAbove(request.tool.input)),
          alwaysHelp: alwaysAllowHelp(onlyRules(request.suggestions)),
        });
        this.o.waiting?.();
        break;
      }
      case 'permissionCancelled':
        this.permissions = this.permissions.filter((p) => p.id !== event.id);
        this.o.waiting?.();
        break;
      case 'turnEnded':
        this.clearStop();
        this.streaming = null;
        this.busy = false;
        this.permissions = [];
        this.status = null;
        this.turnStarted = null;
        this.pendingTool = null;
        if (event.isError && event.message) {
          if (NOT_SIGNED_IN.test(event.message)) this.notice(this.o.server ? signInOn(this.o.server) : SIGN_IN, true, 'signin');
          else this.notice(event.message, true);
        }
        // Commands answer at once; only real work is worth a line about how long it took.
        if (event.seconds >= 1 && this.items.length) this.add({ kind: 'done', seconds: event.seconds });
        this.o.waiting?.();
        this.write(controlLine('get_context_usage'));
        break;
    }
    this.o.changed?.();
  }

  // ---------- the process

  private environment(): Record<string, string> {
    return typeof this.o.environment === 'function' ? this.o.environment() : this.o.environment;
  }

  private start(): void {
    const binary = this.o.binary();
    if (!binary) {
      this.notice(NOT_INSTALLED, true, 'setup');
      return;
    }
    const own = claudeArgs({ resume: this.session, mode: this.mode, model: this.model });
    const args = [...(this.o.leadArgs ?? []), ...own];
    let proc: ChatProcess | null = null;
    const parse = (line: string) => {
      // A line of an earlier process, after a restart, says nothing about this one.
      if (this.process === proc) for (const event of parseLine(line)) this.apply(event);
    };
    const finished = (stderr: string, spawnError: string | null) => {
      if (this.process !== proc) return;
      this.exited(stderr, spawnError);
    };
    try {
      proc = this.o.starter ? this.o.starter(own, { line: parse, ended: finished }) : startClaude(binary, args, this.o.folder, this.environment(), { line: parse, ended: finished });
      this.process = proc;
    } catch (error) {
      this.notice(`Could not start Claude Code: ${String(error).replace(/^Error: /, '')}`, true);
    }
  }

  private exited(stderr: string, spawnError: string | null): void {
    this.process = null;
    this.permissions = [];
    this.clearStop();
    this.o.waiting?.();
    if (this.stopFailed) {
      this.stopFailed = false;
      this.busy = false;
      this.turnStarted = null;
      this.pendingTool = null;
      this.notice('Claude Code did not stop, so the app ended it. The next message picks the conversation up.');
    } else if (this.busy) {
      // Still in a turn: it stopped on us. The next message resumes the session.
      this.busy = false;
      this.turnStarted = null;
      this.pendingTool = null;
      const missing = /ENOENT|command not found|not recognized/i.test(`${spawnError ?? ''} ${stderr}`);
      this.notice(missing ? NOT_INSTALLED : spawnError ? `Could not start Claude Code: ${spawnError}` : stderr || 'Claude Code stopped unexpectedly.', true, missing ? 'setup' : undefined);
    }
    this.o.changed?.();
  }

  private write(line: string): void {
    this.process?.write(line);
  }

  private loadHistory(session: string): void {
    this.loadingHistory = true;
    void (this.o.history ? this.o.history(session) : loadTranscript(session, this.o.folder, this.o.configDir)).then((events) => {
      for (const event of events) {
        if (['turnEnded', 'permission', 'permissionCancelled', 'started', 'status', 'contextUsage', 'controlFailed', 'commandsChanged', 'permissionMode', 'unanswerable'].includes(event.type)) continue;
        this.apply(event);
      }
      this.streaming = null;
      this.loadingHistory = false;
      this.o.waiting?.();
      this.o.changed?.();
    });
  }
}
