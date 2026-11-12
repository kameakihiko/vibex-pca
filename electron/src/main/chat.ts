import { BrowserWindow, dialog, nativeImage } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, promises as fs, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaude } from './claude';
import { approvalRefusal } from './chatGate';
import type { ChatCommand, ChatModelOption } from './chatEvents';
import { ChatModel, claudeArgs, safeSession, type ChatAttachment, type ChatItem, type ChatPermission } from './chatModel';
import { askCapabilities, recentSessions, type ChatCapabilities, type ChatSessionSummary } from './chatProcess';
import { loadServerTranscript, plainLoginFailure, probeServerFolder, startRemoteClaude, type ServerChatHost } from './serverChat';
import { limitError, MIB, sendFiles, sizeOf, type UploadLogin, type UploadRun, type UploadState } from './chatUpload';
import { allowRefusal, clipped, type CardView, cardView, imageTypeOf, isTrustedIn, onlyRules } from './chatTrust';
import { runGit } from './git';
import type { InboxService } from './inbox';
import type { ModuleHost, VibexModule } from './modules';
import { findProgram, runnable } from './programs';
import type { ProjectInfo } from './projects';
import { agentLaunch, inProject, loginPathNow, type Launch } from './terminals';
import { testEnv } from './testSwitches';
import { refreshWindowsPath } from './windowsPath';
import { pointerOf, type WindowPointer } from './windowPointer';

// The native Claude chat tab (macOS Vibex: Vibex/Claude/). A chat is a tab of the Terminals class with no terminal in it: it
// has the same strip, close question, Reopen Closed Tab, quit question and project. Its process lives in ChatModel.
// In a local project a chat runs Claude on this computer, as in macOS Vibex. In a project on a server it runs Claude there,
// through the same ssh login, askpass ticket, token and tunnel as the server's Claude tab (serverChat.ts); the trust answer
// and the past conversations then come from the server too. The Claude tab stays in the menu as the fallback.
// Each person uses their own Claude Code login. The app has no sign-in and stores no key.

interface Chat {
  tab: number;
  project: ProjectInfo;
  model: ChatModel;
  /// False until the folder passed Claude Code's trust dialog; read again at each send and at Check Again.
  trusted: boolean;
  sentItems: number;
  waitingSession: string | null;
  /// A chat of a project on a server: what the server last said about the folder.
  server: { checking: boolean; checkedAt: number; sessions: ChatSessionSummary[]; pending: Promise<void> | null } | null;
  /// Server projects: each file's upload, by attachment id (chatUpload.ts). Images need none.
  uploads: Map<string, UploadState>;
  runs: Map<string, UploadRun>;
  uploading: boolean;
}

/// How long the server's list of conversations is good for before the empty screen asks again.
const SERVER_LIST_MS = 60_000;

/// What Claude Code offers depends on the folder, and a folder on a server is not the folder of that name here.
const catalogKey = (project: ProjectInfo) => (project.server ? `${project.server}\0${project.path}` : project.path);

/// False until a person has run the chat with a real claude.exe on Windows. What flips it to true: the steps of "The Claude chat"
/// in WINDOWS-FIRST-RUN.md all answered yes on one PC. Then a new Claude tab is a chat, and the menu offers the terminal instead.
export const NATIVE_CHAT_IS_DEFAULT = false;

export const nativeChatIsDefault = () => testEnv('VIBEX_CHAT_DEFAULT') === '1' || NATIVE_CHAT_IS_DEFAULT;

/// What a person's Claude Code keeps under: its transcripts, and the file with the trust answers.
const configRoot = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const trustFile = () => (process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json'));

function folderIsTrusted(folder: string): boolean {
  let text: string | null = null;
  try {
    text = readFileSync(trustFile(), 'utf8');
  } catch { /* no file means not trusted */ }
  const lookup = { paths: path as typeof path.posix, exists: existsSync };
  if (isTrustedIn(folder, text, lookup)) return true;
  // Claude Code writes the real path, which a link does not show.
  try {
    return isTrustedIn(realpathSync.native(folder), text, lookup);
  } catch {
    return false;
  }
}

/// The system program by its full path. A login shell's PATH (nvm) counts too, as a terminal tab has it.
function claudeProgram(): string | null {
  if (testEnv('VIBEX_CLAUDE_MISSING') === '1') return null;
  // A test on Windows: a made-up claude cannot be a claude.exe, so it runs as a script of this program.
  const test = testEnv('VIBEX_CHAT_BIN');
  if (test) return test;
  refreshWindowsPath();
  const direct = findClaude();
  if (direct) return direct;
  const login = loginPathNow();
  return login ? findProgram('claude', { platform: process.platform, pathValue: login, isFile: runnable }) : null;
}

const leadArgs = (): string[] => {
  const script = testEnv('VIBEX_CHAT_SCRIPT');
  return script ? [script] : [];
};

function environmentOf(project: ProjectInfo): Record<string, string> {
  const login = loginPathNow();
  return {
    ...(process.env as Record<string, string>),
    ...(login ? { PATH: login } : {}),
    TERM_PROGRAM: 'VibexPCA',
    // As a terminal tab: Claude sends VIBEX_WINDOW back as the X-Vibex-Window header on each tool call.
    VIBEX_PROJECT: project.path,
    VIBEX_WINDOW: project.id,
  };
}

// ------------------------------------------------------------------ attachments

/// What Claude's API takes: PNG, JPEG, GIF or WebP, up to about 5 MB and best under 2000 points.
const ACCEPTED: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_BYTES = 3_500_000;
const MAX_SIDE = 2000;
const MAX_IMAGE_INPUT = 40_000_000;
const PREVIEW_SIDE = 88;

/// Passes a small image in an accepted format through; converts or shrinks anything else to JPEG. Null when it is no image.
function preparedImage(data: Buffer, name: string | null): (ChatAttachment & { preview?: string }) | null {
  const image = nativeImage.createFromBuffer(data);
  if (image.isEmpty()) return null;
  const type = imageTypeOf(data);
  const { width, height } = image.getSize();
  const preview = image.resize(width >= height ? { width: Math.min(width, PREVIEW_SIDE) } : { height: Math.min(height, PREVIEW_SIDE) }).toDataURL();
  const base = { id: randomBytes(4).toString('hex'), kind: 'image' as const, name, preview };
  if (type && data.length <= MAX_BYTES && Math.max(width, height) <= MAX_SIDE) return { ...base, mediaType: type, data: data.toString('base64') };
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const jpeg = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale) }).toJPEG(85);
  return { ...base, mediaType: 'image/jpeg', data: jpeg.toString('base64') };
}

/// Images go in as images, anything else by path, so Claude can read it with its own tools.
function attachmentOf(file: string): ChatAttachment & { preview?: string } {
  const name = path.basename(file);
  const type = ACCEPTED[path.extname(file).toLowerCase()];
  if (type) {
    try {
      if (statSync(file).size <= MAX_IMAGE_INPUT) {
        const image = preparedImage(readFileSync(file), name);
        if (image) return image;
      }
    } catch { /* it goes by its path, and Claude says what it found */ }
  }
  return { id: randomBytes(4).toString('hex'), kind: 'file', name, path: file };
}

// ------------------------------------------------------------------ project files, for @

const WALK_SKIP = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '__pycache__', '.venv']);
const MAX_FILES = 5000;

async function projectFiles(root: string): Promise<string[]> {
  try {
    const listed = await runGit(root, ['ls-files', '-co', '--exclude-standard', '-z'], { plain: true });
    if (listed.code === 0) return listed.out.split('\0').filter(Boolean).slice(0, MAX_FILES);
  } catch { /* no git: the walk below */ }
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    if (out.length >= MAX_FILES) return;
    const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= MAX_FILES || WALK_SKIP.has(entry.name)) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  await walk('');
  return out;
}

// ------------------------------------------------------------------ the service

/// Each answer names its button; main reads that button's place itself, so a page script cannot say where it is.
const BUTTONS: Record<string, string> = {
  allow: '.chat-allow',
  always: '.chat-always',
  deny: '.chat-deny',
  build: '.chat-build',
  'build-auto': '.chat-build-auto',
  'keep-planning': '.chat-keep-planning',
};

/// A card's words are worked out once for each form: the scan reads each character of what may be a large file.
const views = new WeakMap<ChatPermission, { part?: CardView; whole?: CardView }>();
function viewOf(p: ChatPermission, whole: boolean): CardView {
  const known = views.get(p) ?? {};
  views.set(p, known);
  const key = whole ? 'whole' : 'part';
  return (known[key] ??= cardView(p.tool, p.rawInput, whole));
}

const FLUSH_MS = 33;
const PERSON_MS = 2000;

export class ChatService {
  private host!: ModuleHost;
  private inbox: InboxService | null = null;
  private pointer: WindowPointer | null = null;
  private win: BrowserWindow | null = null;
  private chats = new Map<number, Chat>();
  /// When each card came on screen, by main's clock.
  private shown = new Map<string, number>();
  /// Cards whose whole text the person asked for, and cards read to the end.
  private wholeAsked = new Set<string>();
  private seenCards = new Set<string>();
  private catalogs = new Map<string, ChatCapabilities>();
  private catalogAsked = new Set<string>();
  private servers: ServerChatHost | null = null;
  /// The server's last trust answer for each project on a server, so a new chat there does not show the card first.
  private serverTrust = new Map<string, boolean>();
  private dirty = new Map<number, { state: boolean; items: Set<ChatItem> }>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /// When main last saw a real key: Ctrl or Cmd with Enter (the shortcut), and Enter or Space (a focused button).
  private shortcutAt = 0;
  private buttonKeyAt = 0;
  private anyKeyAt = 0;

  start(host: ModuleHost, inbox: InboxService): void {
    this.host = host;
    this.inbox = inbox;
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
    this.win = win;
    if (win) {
      this.pointer = pointerOf(win);
      win.webContents.on('before-input-event', (_event, input) => {
        if (input.type !== 'keyDown' || input.isAutoRepeat) return;
        this.anyKeyAt = Date.now();
        if (input.key === 'Enter' && (input.control || input.meta)) this.shortcutAt = Date.now();
        else if (input.key === 'Enter' || input.key === ' ') this.buttonKeyAt = Date.now();
      });
    }
    const chatOf = (tab: unknown): Chat => {
      const chat = this.chats.get(Number(tab));
      if (!chat) throw new Error('This chat has closed.');
      return chat;
    };
    host.handle('mod:chat:open', (tab: number) => {
      const chat = chatOf(tab);
      this.loadCatalog(chat);
      return { items: chat.model.items, state: this.stateOf(chat) };
    });
    host.handle('mod:chat:send', async (tab: number, text: unknown) => {
      if (typeof text !== 'string') throw new Error('bad message');
      const chat = chatOf(tab);
      this.refreshTrust(chat);
      // Files of a server chat go to the server first; the words wait in the box until they are there.
      if (!(await this.uploadBeforeSend(chat))) return false;
      const sent = chat.model.send(text);
      if (sent) this.forgetUploads(chat);
      this.mark(chat);
      return sent;
    });
    host.handle('mod:chat:stop', (tab: number) => {
      const chat = chatOf(tab);
      if (chat.uploading) for (const run of chat.runs.values()) run.stop();
      else chat.model.stopTurn();
    });
    host.handle('mod:chat:mode', (tab: number, mode: unknown) => {
      chatOf(tab).model.setMode(String(mode));
    });
    host.handle('mod:chat:model', (tab: number, model: unknown) => chatOf(tab).model.setModel(model === 'default' ? '' : String(model)));
    host.handle('mod:chat:check-trust', (tab: number) => {
      const chat = chatOf(tab);
      if (chat.server) return void this.probe(chat);
      chat.trusted = folderIsTrusted(chat.project.path);
      if (chat.trusted) this.loadCatalog(chat);
      this.mark(chat);
    });
    // The person reached the end of the card's box. Only a whole text counts: see the check in answer().
    host.on('mod:chat:seen', (tab: number, card: unknown) => {
      const p = this.chats.get(Number(tab))?.model.permissions.find((q) => q.card === card);
      if (p && !viewOf(p, this.wholeAsked.has(p.card)).cut) this.seenCards.add(p.card);
    });
    // All of a text the card holds only the start of. It stays in main until the person asks.
    host.handle('mod:chat:card-whole', (tab: number, card: unknown) => {
      const p = chatOf(tab).model.permissions.find((q) => q.card === card);
      if (!p) throw new Error('This request no longer waits.');
      const whole = viewOf(p, true);
      if (whole.tooLong) throw new Error('This is too long to show. Click "Don\'t Allow".');
      this.wholeAsked.add(p.card);
      return { input: whole.input, rows: whole.rows };
    });
    // A card came on screen: its arm time starts now, by this clock.
    host.on('mod:chat:shown', (tab: number, card: unknown) => {
      if (this.chats.get(Number(tab))?.model.permissions.some((p) => p.card === card)) this.shown.set(String(card), Date.now());
    });
    host.handle('mod:chat:answer', (tab: number, card: unknown, choice: unknown, via: unknown, extra?: unknown) => this.answer(chatOf(tab), card, choice, via, extra));
    host.handle('mod:chat:attach', async (tab: number) => {
      const chat = chatOf(tab);
      const picked = await this.pick(chat);
      this.attach(chat, picked.map(attachmentOf));
    });
    host.handle('mod:chat:attach-paths', (tab: number, paths: unknown) => {
      if (!Array.isArray(paths)) throw new Error('bad list');
      const files = paths.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p) && existsSync(p)).slice(0, 50);
      this.attach(chatOf(tab), files.map(attachmentOf));
    });
    host.handle('mod:chat:attach-image', (tab: number, base64: unknown) => {
      if (typeof base64 !== 'string' || base64.length > MAX_IMAGE_INPUT) throw new Error('This image is too large.');
      const image = preparedImage(Buffer.from(base64, 'base64'), null);
      if (!image) throw new Error('This is not an image the app can read.');
      this.attach(chatOf(tab), [image]);
    });
    host.handle('mod:chat:detach', (tab: number, id: unknown) => {
      const chat = chatOf(tab);
      chat.model.attachments = chat.model.attachments.filter((a) => a.id !== id);
      chat.runs.get(String(id))?.stop();
      chat.uploads.delete(String(id));
      this.mark(chat);
    });
    // The files of a server folder are not on this computer; a local folder of the same name must not show instead.
    host.handle('mod:chat:files', (tab: number) => (chatOf(tab).server ? [] : projectFiles(chatOf(tab).project.path)));
    host.handle('mod:chat:sessions', async (tab: number) => {
      const chat = chatOf(tab);
      if (chat.server?.pending) await chat.server.pending;
      else if (chat.server && Date.now() - chat.server.checkedAt > SERVER_LIST_MS) await this.probe(chat);
      const sessions = chat.server ? chat.server.sessions : await recentSessions(chat.project.path, configRoot());
      return sessions.filter((s) => s.id !== chat.model.session);
    });
    host.handle('mod:chat:resume', (tab: number, session: unknown) => {
      if (typeof session !== 'string' || !safeSession(session)) throw new Error('That is not the name of a conversation.');
      this.resume(chatOf(tab), session);
    });
    host.handle('mod:chat:terminal', (tab: number) => {
      const chat = chatOf(tab);
      this.openTab(chat.server ? this.serverHost().terminal(chat.project) : this.terminalClaude(chat.project));
    });
  }

  /// The server hub, which main.ts gives once it runs.
  useServers(servers: ServerChatHost): void {
    this.servers = servers;
  }

  private serverHost(): ServerChatHost {
    if (!this.servers) throw new Error('The app cannot reach servers yet. Try again in a moment.');
    return this.servers;
  }

  /// Before a send: a local folder is read again now. A server folder keeps its answer, and an untrusted one asks the server
  /// again for the next send: a login per message would be a password or Hello prompt per message.
  private refreshTrust(chat: Chat): void {
    if (!chat.server) chat.trusted = folderIsTrusted(chat.project.path);
    else if (!chat.trusted) void this.probe(chat);
  }

  /// One short login: the trust answer and the past conversations of the folder on the server. A second ask while one runs
  /// waits for that one.
  private probe(chat: Chat): Promise<void> {
    const server = chat.server;
    if (!server) return Promise.resolve();
    server.pending ??= this.probeNow(chat).finally(() => { server.pending = null; });
    return server.pending;
  }

  private async probeNow(chat: Chat): Promise<void> {
    const server = chat.server!;
    server.checking = true;
    this.mark(chat);
    try {
      const info = await probeServerFolder(this.serverHost().login(chat.project));
      server.sessions = info.sessions;
      server.checkedAt = Date.now();
      chat.trusted = info.trusted;
      this.serverTrust.set(chat.project.id, info.trusted);
      if (info.trusted) this.loadCatalog(chat);
    } catch (error) {
      // No answer is no trust: nothing starts on an older answer (second security review).
      chat.trusted = false;
      chat.model.say(`Could not check this folder on ${chat.project.server}: ${String(error).replace(/^Error: /, '')} Check Again tries once more.`, true);
    } finally {
      server.checking = false;
      this.mark(chat);
    }
  }

  /// Auto takes the cards away, so going there needs what a card needs: the window's own input, a moment ago.
  private needPerson(): void {
    const now = Date.now();
    const up = this.pointer?.tracker.press()?.up?.at ?? 0;
    if (now - up > PERSON_MS && now - this.anyKeyAt > PERSON_MS) throw new Error('Auto mode needs a click or a key in this window.');
  }

  private openTab(launch: Launch): void {
    const info = this.host.terminals.create(launch);
    this.host.send('mod:chat:opened', info.id);
  }

  /// A terminal Claude tab of this project, where /login and the trust question work.
  terminalClaude(project: ProjectInfo): Launch {
    return { ...inProject(agentLaunch(), project), title: `${project.name} - Claude Terminal` };
  }

  private async pick(chat: Chat): Promise<string[]> {
    const test = (globalThis as any).__vibexTest?.chatPick as string[] | undefined;
    if (test) return test;
    const options: Electron.OpenDialogOptions = { title: 'Attach', buttonLabel: 'Attach', defaultPath: chat.project.path, properties: ['openFile', 'multiSelections'] };
    const picked = await (this.win ? dialog.showOpenDialog(this.win, options) : dialog.showOpenDialog(options));
    return picked.canceled ? [] : picked.filePaths;
  }

  private attach(chat: Chat, list: ChatAttachment[]): void {
    chat.model.attachments = [...chat.model.attachments, ...list];
    // A server chat checks the limits now, so a red chip shows before Send: 100 MiB per file, 10 files per message.
    if (chat.server) {
      for (const a of list) {
        if (a.kind !== 'file') continue;
        const earlier = chat.model.attachments.slice(0, chat.model.attachments.indexOf(a));
        const counted = earlier.filter((x) => x.kind === 'file' && chat.uploads.get(x.id)?.phase !== 'refused').length;
        const size = sizeOf(a.path);
        const error = limitError(size, counted);
        chat.uploads.set(a.id, { phase: error ? 'refused' : 'waiting', sent: 0, total: size?.bytes ?? 0, error, serverPath: null });
      }
    }
    this.mark(chat);
  }

  /// A login of the server chat for one upload: the file goes on its standard input, so ssh must read it.
  private uploadLogin(project: ProjectInfo): UploadLogin | null {
    try {
      const login = this.serverHost().login(project);
      return {
        file: login.file, args: (script) => login.args(script, { input: true }), env: login.env, dispose: login.dispose,
        failure: (stderr) => plainLoginFailure(stderr, project.server ?? 'The server'),
      };
    } catch {
      return null;
    }
  }

  /// True when the message may go: every file of a server chat is on the server, and its path is what Claude gets.
  private async uploadBeforeSend(chat: Chat): Promise<boolean> {
    if (!chat.server || !chat.trusted) return true;
    if (chat.uploading) throw new Error('The files are still going to the server.');
    chat.uploading = true;
    try {
      return await sendFiles({
        attachments: () => chat.model.attachments,
        setAttachments: (list) => { chat.model.attachments = list; },
        uploads: chat.uploads,
        runs: chat.runs,
        folder: chat.project.path,
        login: () => this.uploadLogin(chat.project),
        changed: () => this.mark(chat),
      });
    } finally {
      chat.uploading = false;
      this.mark(chat);
    }
  }

  private forgetUploads(chat: Chat): void {
    chat.uploads.clear();
    chat.runs.clear();
  }

  private resume(chat: Chat, session: string): void {
    // An untouched chat gives way to the conversation it is reopening.
    const replaced = chat.model.items.length === 0 && !chat.model.session ? chat.tab : null;
    this.openTab(this.launch(chat.project, { resume: session, mode: chat.model.mode, model: chat.model.model }));
    if (replaced !== null) this.host.terminals.close(replaced);
  }

  private async proofOf(chat: Chat, card: string, selector: string, via: unknown): Promise<string | null> {
    const shownAt = this.shown.get(card) ?? null;
    const now = Date.now();
    if (via === 'mouse') {
      if (!this.pointer) return 'The window is not there.';
      try {
        const click = await this.pointer.verify(selector, null);
        return approvalRefusal({ shownAt, now: Date.now(), click });
      } catch (error) {
        return String(error).replace(/^(Go)?Error: /, '');
      }
    }
    if (via !== 'shortcut' && via !== 'button-key') return 'An answer needs a click or a key in this window.';
    if (!this.pointer || !this.win) return 'The window is not there.';
    if (!(await this.pointer.buttonRect(selector))) return 'This card is not on screen.';
    if (via === 'button-key') {
      const focused = await this.win.webContents.executeJavaScriptInIsolatedWorld(1702, [{ code: `document.activeElement === document.querySelector(${JSON.stringify(selector)})` }]);
      if (focused !== true) return 'An answer needs a click or a key in this window.';
    }
    return approvalRefusal({ shownAt, now, keyAt: (via === 'shortcut' ? this.shortcutAt : this.buttonKeyAt) || undefined });
  }

  /// A person's answer, or nothing. No tool has a way here; a page in the side browser has no IPC at all; a script in this
  /// window makes no input event. See chatGate.ts.
  private async answer(chat: Chat, card: unknown, choice: unknown, via: unknown, extra: unknown): Promise<void> {
    const request: ChatPermission | undefined = chat.model.permissions.find((p) => p.card === card);
    if (!request) throw new Error('This request no longer waits.');
    const root = `.chat-surface[data-tab="${chat.tab}"] .chat-card[data-card="${request.card}"]`;
    let button: string;
    let answers: Record<string, string> | null = null;
    if (choice === 'answer') {
      const given = extra as { option?: unknown; answers?: unknown } | undefined;
      if (typeof given?.option !== 'string' || !/^(\d+-\d+|done)$/.test(given.option) || !given.answers || typeof given.answers !== 'object') throw new Error('bad answer');
      button = given.option === 'done' ? '.chat-opt-done' : `.chat-opt[data-opt="${given.option}"]`;
      answers = Object.fromEntries(Object.entries(given.answers).map(([k, v]) => [k, String(v)]));
    } else {
      if (!Object.hasOwn(BUTTONS, String(choice))) throw new Error('bad answer');
      button = BUTTONS[String(choice)];
    }
    if (choice === 'allow' || choice === 'always') {
      const why = allowRefusal(viewOf(request, this.wholeAsked.has(request.card)), this.seenCards.has(request.card));
      if (why) throw new Error(why);
    }
    const refused = await this.proofOf(chat, request.card, `${root} ${button}`, via);
    if (refused) throw new Error(refused);
    // The wait above: it may have been answered or cancelled meanwhile.
    if (!chat.model.permissions.includes(request)) throw new Error('This request no longer waits.');
    this.shown.delete(request.card);
    this.wholeAsked.delete(request.card);
    this.seenCards.delete(request.card);
    if (answers) chat.model.answer(request.id, answers);
    else if (choice === 'deny' || choice === 'keep-planning') chat.model.deny(request.id);
    else if (choice === 'always') chat.model.allow(request.id, true);
    else {
      if (choice === 'build') chat.model.setMode('acceptEdits');
      // The press on this button is the proof.
      if (choice === 'build-auto') chat.model.setMode('auto', true);
      chat.model.allow(request.id);
    }
    this.mark(chat);
  }

  private loadCatalog(chat: Chat): void {
    const folder = catalogKey(chat.project);
    if (!chat.trusted || this.catalogAsked.has(folder)) return;
    const args = claudeArgs({ resume: null, mode: 'default', model: '' });
    let asked: Promise<ChatCapabilities | null>;
    if (chat.server) {
      // The same quiet script as the chat, with no tunnel: one Claude start on the server, ended by its guard and a stop.
      const host = this.serverHost();
      const chatId = randomBytes(12).toString('hex');
      let spawned;
      try {
        spawned = host.spawn(chat.project, `catalog-${chat.tab}`, chatId, args, null);
      } catch {
        return;
      }
      const spec = spawned;
      asked = askCapabilities(spec.file, spec.args, os.homedir(), spec.env).finally(() => {
        spec.dispose();
        host.stop(chat.project, chatId);
      });
    } else {
      const binary = claudeProgram();
      if (!binary) return;
      asked = askCapabilities(binary, [...leadArgs(), ...args], chat.project.path, environmentOf(chat.project));
    }
    this.catalogAsked.add(folder);
    void asked.then((reply) => {
      if (!reply) {
        this.catalogAsked.delete(folder);
        return;
      }
      this.catalogs.set(folder, reply);
      for (const other of this.chats.values()) if (catalogKey(other.project) === folder) this.mark(other);
    });
  }

  /// The models do not depend on the folder, so any answer names them.
  private models(folder: string): ChatModelOption[] {
    const own = this.catalogs.get(folder)?.models ?? [];
    if (own.length) return own;
    for (const other of this.catalogs.values()) if (other.models.length) return other.models;
    return [];
  }

  private commands(folder: string): ChatCommand[] {
    return this.catalogs.get(folder)?.commands ?? [];
  }

  private stateOf(chat: Chat) {
    const { model, project } = chat;
    return {
      session: model.session,
      busy: model.busy,
      mode: model.mode,
      model: model.model,
      modelTitle: model.modelTitle(),
      contextPercent: model.contextPercent,
      status: model.status,
      pendingTool: model.pendingTool,
      turnStarted: model.turnStarted,
      title: this.tabTitle(chat),
      loadingHistory: model.loadingHistory,
      trusted: chat.trusted,
      /// The server asks about the folder now: the trust card waits for its answer.
      trustChecking: !!chat.server?.checking,
      server: project.server ?? null,
      project: project.id,
      folder: project.path,
      commands: this.commands(catalogKey(project)),
      models: this.models(catalogKey(project)),
      uploading: chat.uploading,
      attachments: model.attachments.map((a) => {
        const up = chat.uploads.get(a.id);
        return {
          id: a.id, kind: a.kind, name: a.name, preview: (a as { preview?: string }).preview,
          upload: up ? { phase: up.phase, percent: up.total ? Math.min(100, Math.floor((up.sent / up.total) * 100)) : 0, mib: Math.round((up.total / MIB) * 10) / 10, error: up.error } : null,
        };
      }),
      // A name of main's own, the words shown, and no way to change what goes back: the raw input stays here.
      permissions: model.permissions.map((p) => {
        // A plan and a question are prose for the person, and a press there runs nothing that they read. The marks are for what is allowed.
        const prose = p.tool.name === 'ExitPlanMode' || p.tool.name === 'AskUserQuestion';
        const view = prose ? { input: Object.fromEntries(Object.entries(p.tool.input).map(([k, v]) => [k, clipped(v)])), rows: p.rows, cut: false, tooLong: false, refuse: null, note: null } : viewOf(p, false);
        return {
          card: p.card,
          name: p.tool.name,
          toolId: p.tool.id,
          input: view.input,
          rows: view.rows,
          cut: view.cut,
          noAllow: view.tooLong ? allowRefusal(view, true) : view.refuse,
          note: view.note,
          canAlways: !!onlyRules(p.suggestions),
          alwaysHelp: p.alwaysHelp,
        };
      }),
    };
  }

  private tabTitle(chat: Chat): string {
    return `${chat.project.name} - ${chat.model.title}`;
  }

  private mark(chat: Chat, item?: ChatItem): void {
    let entry = this.dirty.get(chat.tab);
    if (!entry) this.dirty.set(chat.tab, (entry = { state: false, items: new Set() }));
    if (item) entry.items.add(item);
    else entry.state = true;
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    this.flushTimer = null;
    const work = [...this.dirty];
    this.dirty.clear();
    for (const [tab, entry] of work) {
      const chat = this.chats.get(tab);
      if (!chat) continue;
      // /clear gave a new conversation: the window starts over.
      if (chat.model.items.length < chat.sentItems) this.host.send('mod:chat:items', tab, chat.model.items);
      else for (const item of entry.items) this.host.send('mod:chat:item', tab, item);
      chat.sentItems = chat.model.items.length;
      if (!entry.state) continue;
      // The strip, terminal_tabs and the close question read this name.
      this.host.terminals.retitle(tab, this.tabTitle(chat));
      this.host.send('mod:chat:state', tab, this.stateOf(chat));
    }
  }

  /// Waiting goes through the same Inbox as Claude's hooks in a terminal: the tab, the rail's badge, the Inbox line, and a
  /// notification when the person is not looking. The hooks use the same session, so one wait shows once.
  private report(chat: Chat): void {
    const first = chat.model.permissions[0];
    const session = chat.model.session ?? `chat-${chat.tab}`;
    if (first) {
      const { name, input } = first.tool;
      const asks = name === 'AskUserQuestion' ? 'Claude asks a question' : name === 'ExitPlanMode' ? 'Claude has a plan for you to read' : null;
      this.inbox?.handle(chat.project.id, asks
        ? { name: 'Notification', message: asks, session, cwd: chat.project.path }
        : { name: 'PermissionRequest', tool: name, detail: input.command ?? input.file_path ?? input.url ?? input.pattern, session, cwd: chat.project.path });
      chat.waitingSession = session;
    } else if (chat.waitingSession) {
      this.inbox?.handle(chat.project.id, { name: 'Stop', session: chat.waitingSession, cwd: chat.project.path });
      chat.waitingSession = null;
    }
  }

  /// The launch of a chat tab: no terminal, and everything else a Claude tab has.
  launch(project: ProjectInfo, options: { resume?: string | null; mode?: ChatModel['mode']; model?: string } = {}): Launch {
    let chat: Chat | null = null;
    const launch: Launch = {
      file: '',
      args: [],
      kind: 'none',
      title: `${project.name} - Claude`,
      cwd: project.path,
      project: project.id,
      pane: 'agent',
      chat: {
        attach: (tab) => {
          const exits: ((e: { exitCode: number; signal?: number }) => void)[] = [];
          const onServer = !!project.server;
          const host = onServer ? this.serverHost() : null;
          const trusted = onServer ? this.serverTrust.get(project.id) ?? false : folderIsTrusted(project.path);
          const key = catalogKey(project);
          const remote = host
            ? {
              binary: () => 'ssh',
              // Each start is one Claude on the server with a chat id of its own, which its stop names.
              starter: (args: string[], on: { line: (line: string) => void; ended: (stderr: string, spawnError: string | null) => void }) => {
                const chatId = randomBytes(12).toString('hex');
                const chatKey = String(tab);
                return startRemoteClaude({
                  spawn: (attempt) => host.spawn(project, chatKey, chatId, args, attempt),
                  attempts: host.attempts(project, chatKey),
                  stopRemote: () => host.stop(project, chatId),
                  server: project.server!,
                  on: { ...on, notice: (text) => model.say(text) },
                });
              },
              history: (session: string) => loadServerTranscript(host.login(project), session),
              server: project.server!,
              // A new chat starts from the project's last answer, and asks again at once: that answer does not start Claude.
              trustPending: () => !!chat?.server?.checking,
            }
            : { binary: claudeProgram, leadArgs: leadArgs() };
          const model: ChatModel = new ChatModel({
            folder: project.path,
            configDir: configRoot(),
            environment: () => environmentOf(project),
            ...remote,
            isTrusted: () => {
              if (chat && !chat.server) chat.trusted = folderIsTrusted(project.path);
              return chat?.trusted ?? trusted;
            },
            resuming: options.resume ?? null,
            mode: options.mode,
            model: options.model,
            models: () => this.models(key),
            confirmAuto: () => this.needPerson(),
            commandsChanged: (commands) => {
              const known = this.catalogs.get(key) ?? { commands: [], models: [] };
              this.catalogs.set(key, { ...known, commands });
            },
            changed: (item) => { if (chat) this.mark(chat, item); },
            waiting: () => { if (chat) this.report(chat); },
            actions: {
              newChat: () => this.openTab(this.launch(project)),
              resume: (session) => { if (chat) this.resume(chat, session); },
              showSkills: () => this.host.send('mod:chat:activity', 'skills'),
              showMcp: () => this.host.send('mod:chat:activity', 'mcp'),
              startAgent: (task) => this.host.send('mod:chat:start-agent', project.id, task),
            },
          });
          chat = { tab, project, model, trusted, sentItems: 0, waitingSession: null, server: onServer ? { checking: false, checkedAt: 0, sessions: [], pending: null } : null, uploads: new Map(), runs: new Map(), uploading: false };
          this.chats.set(tab, chat);
          if (onServer) void this.probe(chat);
          const end = () => {
            if (!this.chats.has(tab)) return;
            const closing = chat!;
            for (const run of closing.runs.values()) run.stop();
            model.terminate();
            this.report(closing);
            this.chats.delete(tab);
            for (const fn of exits.splice(0)) fn({ exitCode: 0 });
          };
          return {
            get pid() { return model.pid; },
            process: 'claude',
            onData: () => ({ dispose: () => undefined }),
            onExit: (fn) => {
              exits.push(fn);
              return { dispose: () => { const at = exits.indexOf(fn); if (at >= 0) exits.splice(at, 1); } };
            },
            write: () => undefined,
            resize: () => undefined,
            kill: end,
          };
        },
        busy: () => !!chat && (chat.model.busy || chat.model.needsAttention || chat.uploading),
      },
      // Reopen Closed Tab: the same conversation from its transcript. Nothing starts and nothing goes out until the next message.
      rebuild: () => this.launch(project, { resume: chat?.model.session ?? options.resume ?? null, mode: chat?.model.mode, model: chat?.model.model }),
    };
    return launch;
  }
}

export const chatService = new ChatService();

export const chatModule: VibexModule = {
  name: 'chat',
  start: (host) => chatService.start(host, host.inbox()),
};
