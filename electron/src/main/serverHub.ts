import { BrowserWindow } from 'electron';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { AskpassService, expectedSecret, type Ticket } from './askpass';
import type { BrowserPane } from './browser';
import type { ModuleHost } from './modules';
import type { ProjectInfo, Projects } from './projects';
import { PortWatcher, ServerForwards, type Target } from './serverPorts';
import { liveToggleRefusal, lookUp, needsQuestion, Questions, size, unsafeCharacters, visible, type QuestionForm } from './serverQuestions';
import { SecretStore, type Crypt } from './serverSecrets';
import { quietLoginOptions, SavedSecretGate, type Authenticator } from './savedSecretGate';
import { projectOfToken, ServerTokens } from './serverTokens';
import { guardForServer, serverToolsModule, type ServerGuardDeps } from './serverTools';
import { hostKeyFailureText, isPinnedLaunch } from './pcaHostKey';
import { chatLoginArgs, chatPorts, chatScript, chatStopScript, checkProfile, findProfile, isValid, jumpProfile, listServerFolders, loadProfiles, profilesFile, readProfiles, runFolder, runLaunch, savedProfile, serverLaunch, serverPorts, shellPorts, sshLaunch, sshProgram, stripOutput, TOKEN_VARIABLE, tunnelLaunch, updateProfiles, type ServerProfile } from './servers';
import type { ChatLogin, ChatSpawn, ServerChatHost } from './serverChat';
import { endsWithApp } from './programs';
import { inProject, stripAnsi, type Launch, type RunState, type Terminals } from './terminals';
import { holdProofOf, pointerOf } from './windowPointer';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/// The app's own environment for an ssh, with no project token in it: only a chat with a tunnel sends one.
const withoutToken = (env: Record<string, string>): Record<string, string> => {
  const copy = { ...env };
  delete copy[TOKEN_VARIABLE];
  return copy;
};

export interface HubDeps {
  terminals: Terminals;
  projects: Projects;
  userData: string;
  crypt: Crypt;
  packaged: boolean;
  execPath: string;
  appPath: string;
  /// Confirms the person before a saved secret is read (main.ts builds it for this platform and build).
  presence: Authenticator;
  send: (channel: `mod:${string}`, ...args: unknown[]) => void;
  reveal: (project: ProjectInfo, pane: 'browser' | 'shell') => void;
  browserFor: (project: ProjectInfo) => BrowserPane;
  /// The native page lies over the window, so it hides while a sheet shows.
  coverBrowsers: (reason: 'question' | 'form', on: boolean) => void;
  /// The file changed: the menu and the window read it again.
  serversChanged: () => void;
  /// The app's own dialog before the form removes a server.
  confirmRemove: (name: string) => Promise<boolean>;
}

const sameLogin = (a: ServerProfile, b: ServerProfile) => a.host === b.host && (a.port ?? 22) === (b.port ?? 22) && a.user === b.user;
const plainError = (e: unknown) => String(e).replace(/^Error: /, '');

/// Everything a server project needs beyond a tab: its token, its tickets, its forwards and its questions. Main.ts asks
/// this class for a tab; it starts no ssh by itself until a person or a tool asks for one.
export class ServerHub {
  readonly secrets: SecretStore;
  readonly questions: Questions;
  readonly askpass: AskpassService;
  /// The presence gate of every saved secret this hub's ssh logins read.
  readonly gate: SavedSecretGate;
  mcpPort: number | null = null;
  private readonly tokens: ServerTokens;
  private loaded = new Map<string, ServerProfile>();
  private forwards = new Map<string, ServerForwards>();
  private watchers = new Map<string, PortWatcher>();
  private runTabs = new Map<string, number>();
  private agentPorts = new Map<string, number>();
  private readonly settingsFile: string;
  private settings: { autoForward?: Record<string, boolean> } = {};

  constructor(private readonly d: HubDeps) {
    this.secrets = new SecretStore(path.join(d.userData, 'server-secrets.json'), d.crypt);
    this.tokens = new ServerTokens(path.join(d.userData, 'server-tokens.json'), d.crypt);
    this.questions = new Questions((q) => {
      d.coverBrowsers('question', !!q);
      d.send('mod:servers:question', q);
    });
    this.gate = new SavedSecretGate(d.presence);
    this.askpass = new AskpassService({
      secrets: this.secrets,
      questions: this.questions,
      profiles: () => loadProfiles(),
      notify: (title, message) => d.send('mod:servers:toast', title, message),
      gate: this.gate,
    }, { packaged: d.packaged, execPath: d.execPath, appPath: d.appPath });
    this.settingsFile = path.join(d.userData, 'server-settings.json');
    try {
      if (existsSync(this.settingsFile)) this.settings = JSON.parse(readFileSync(this.settingsFile, 'utf8'));
    } catch {
      this.settings = {};
    }
    hub = this;
  }

  // ---------- tabs ----------

  private profileOf(project: ProjectInfo): ServerProfile {
    const profile = findProfile(project.server!, loadProfiles());
    if (!profile) throw new Error(`no server profile named ${project.server}`);
    return profile;
  }

  private withTicket(launch: Launch, ticket: Ticket): Launch {
    const onExit = launch.onExit;
    return {
      ...launch,
      env: { ...launch.env, ...ticket.env },
      onExit: (id, code, output) => {
        ticket.dispose();
        onExit?.(id, code, output);
        // The tab shows ssh's own alarm; the person also hears it in plain words.
        const changed = isPinnedLaunch(launch.args) && code === 255 ? hostKeyFailureText(launch.server ?? 'The server', output.slice(-4000)) : null;
        if (changed) this.d.send('mod:servers:toast', 'Host key refused', changed);
      },
    };
  }

  /// A tab of a project on a server. Its first show remembers the profile, for the hold's check of a later change.
  launch(project: ProjectInfo, pane: 'agent' | 'shell'): Launch {
    const profile = this.profileOf(project);
    if (!profile.allowClaude) throw new Error(`${profile.name} does not allow Claude. Turn on "Let Claude use this server" in its form, then open the project again.`);
    if (!this.loaded.has(project.id)) this.loaded.set(project.id, profile);
    this.ensurePorts(project, profile);
    return this.tunnelTab(project, pane, { attempt: 0, retry: false }, randomBytes(4).toString('hex'));
  }

  /// A busy tunnel port on the server ends ssh, and the next port is tried. A shell tab with no free port ends as a plain
  /// login, with no token. An entry that names another login now, or no longer allows Claude, also gets a plain tab.
  private tunnelTab(project: ProjectInfo, pane: 'agent' | 'shell', state: { attempt: number; retry: boolean }, tabKey: string): Launch {
    const profile = this.profileOf(project);
    const jump = jumpProfile(profile, loadProfiles());
    const loaded = this.loaded.get(project.id);
    const own = !!loaded && sameLogin(loaded, profile) && !!profile.allowClaude && loaded.jump === profile.jump;
    if (!state.retry) state.attempt = 0;
    state.retry = false;
    const firstAgent = pane === 'agent' && !this.d.terminals.list().some((t) => t.alive && t.project === project.id && t.pane === 'agent');
    const ports = firstAgent ? serverPorts(project.id) : shellPorts(project.id, tabKey);
    const rebuild = () => this.tunnelTab(project, pane, state, tabKey);
    if (!own || this.mcpPort === null || state.attempt >= ports.length) {
      const ticket = this.askpass.ticket(profile, jump);
      const plain = this.mcpPort === null && own ? serverLaunch(profile, project.path, pane) : { ...sshLaunch(profile, jump), pane, title: pane === 'agent' ? 'Claude' : profile.name };
      if (state.attempt >= ports.length) this.d.send('mod:servers:toast', `${profile.name}: no free tunnel port`, 'This tab has no Vibex tools.');
      return inProject({ ...this.withTicket(plain, ticket), rebuild }, project);
    }
    const remotePort = ports[state.attempt];
    if (firstAgent) this.agentPorts.set(project.id, remotePort);
    const ticket = this.askpass.ticket(profile, jump);
    const launch = tunnelLaunch(profile, jump, project.path, pane, { remotePort, localPort: this.mcpPort, windowId: project.id, token: this.tokenFor(project.id) });
    return inProject({
      ...this.withTicket({
        ...launch,
        onExit: (id, code, output) => {
          // ssh's own words on its stderr; text from the server can at most move the tunnel to another port.
          if (code !== 255 || !/remote port forwarding failed/i.test(output.slice(-2000))) return;
          if (pane === 'agent' && state.attempt >= ports.length - 1) return;
          state.attempt++;
          state.retry = true;
          setTimeout(() => {
            try {
              this.d.terminals.reopen(id);
            } catch {
              // The person closed the tab.
            }
          }, 50);
        },
      }, ticket),
      rebuild,
    }, project);
  }

  /// A plain ssh tab in the project on screen: the person's Connect, and server_connect.
  connectTab(profile: ServerProfile, project: ProjectInfo): Launch {
    const make = (): Launch => {
      const current = findProfile(profile.name, loadProfiles()) ?? profile;
      const jump = jumpProfile(current, loadProfiles());
      return inProject({ ...this.withTicket(sshLaunch(current, jump), this.askpass.ticket(current, jump)), rebuild: make }, project);
    };
    return make();
  }

  // ---------- the native chat (serverChat.ts) ----------

  /// The profile of a chat login, checked as a tab's is: Claude allowed, and the login the project opened with. The first
  /// chat of a project starts its forwards and port watch, as the first tab does.
  private chatProfile(project: { id: string; server?: string }): { profile: ServerProfile; jump: ServerProfile | undefined } {
    const profile = findProfile(project.server ?? '', loadProfiles());
    if (!profile) throw new Error(`no server profile named ${project.server}`);
    if (!profile.allowClaude) throw new Error(`${profile.name} does not allow Claude. Turn on "Let Claude use this server" in its form, then open the project again.`);
    const loaded = this.loaded.get(project.id);
    if (loaded && (!sameLogin(loaded, profile) || loaded.jump !== profile.jump)) throw new Error(`${profile.name} names another login now. Close this project and open it again.`);
    if (!loaded) this.loaded.set(project.id, profile);
    if (this.d.projects.get(project.id)) this.ensurePorts(this.d.projects.get(project.id)!, profile);
    return { profile, jump: jumpProfile(profile, loadProfiles()) };
  }

  /// A quiet login with the askpass ticket, and through it the presence gate: the folder probe, a transcript, and P2's upload.
  /// It tries as a background login does (quietOptions): one try only with a saved secret this PC can confirm, else
  /// BatchMode, so a refused prompt never sends an empty password to the shared login. A typed secret is for the Claude tab.
  chatLogin(project: { id: string; path: string; server?: string }): ChatLogin {
    const { profile, jump } = this.chatProfile(project);
    const ticket = this.askpass.ticket(profile, jump);
    const asks = Object.keys(ticket.env).length > 0;
    let disposed = false;
    return {
      file: sshProgram(),
      args: (script, o = {}) => [...(o.input ? [] : ['-n']), ...chatLoginArgs(profile, jump, script, { asks, quiet: this.quietOptions(profile) })],
      env: withoutToken({ ...(process.env as Record<string, string>), ...ticket.env }),
      folder: project.path,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        ticket.dispose();
      },
    };
  }

  /// The ssh of one chat start. Its own tunnel port for each attempt (chatPorts), and no tunnel past them or with no MCP server.
  chatSpawn(project: { id: string; path: string; server?: string }, chatKey: string, chatId: string, args: string[], attempt: number | null): ChatSpawn {
    const { profile, jump } = this.chatProfile(project);
    const ports = chatPorts(project.id, chatKey);
    const tunnel = this.mcpPort !== null && attempt !== null && attempt < ports.length ? { remotePort: ports[attempt], localPort: this.mcpPort } : undefined;
    const ticket = this.askpass.ticket(profile, jump);
    const asks = Object.keys(ticket.env).length > 0;
    const script = chatScript({ profile, folder: project.path, chatId, claudeArgs: args, remotePort: tunnel?.remotePort ?? null, windowId: project.id });
    const env = withoutToken({ ...(process.env as Record<string, string>), ...ticket.env });
    if (tunnel) env[TOKEN_VARIABLE] = this.tokenFor(project.id);
    let disposed = false;
    return {
      file: sshProgram(),
      args: chatLoginArgs(profile, jump, script, { asks, tunnel, quiet: this.quietOptions(profile) }),
      env,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        ticket.dispose();
      },
      tunnel: tunnel?.remotePort ?? null,
    };
  }

  chatAttempts(project: { id: string }, chatKey: string): number {
    return this.mcpPort === null ? 0 : chatPorts(project.id, chatKey).length;
  }

  /// Ends one chat's Claude on the server. It never asks (BatchMode, no ticket): it runs at a close, when nobody waits for a
  /// prompt. When it cannot log in that way, the guard of the chat script ends Claude with its ssh session.
  chatStop(project: { id: string; path: string; server?: string }, chatId: string): void {
    const profile = findProfile(project.server ?? '', loadProfiles());
    if (!profile) return;
    const jump = jumpProfile(profile, loadProfiles());
    let args: string[];
    try {
      args = ['-n', ...chatLoginArgs(profile, jump, chatStopScript(chatId), { asks: false })];
    } catch {
      return;
    }
    endsWithApp(execFile(sshProgram(), args, { timeout: 20_000, windowsHide: true, env: withoutToken({ ...(process.env as Record<string, string>) }) }, () => undefined));
  }

  /// What the chat service needs from this hub.
  chatHost(): ServerChatHost {
    return {
      login: (project) => this.chatLogin(project),
      spawn: (project, chatKey, chatId, args, attempt) => this.chatSpawn(project, chatKey, chatId, args, attempt),
      attempts: (project, chatKey) => this.chatAttempts(project, chatKey),
      stop: (project, chatId) => this.chatStop(project, chatId),
      terminal: (project) => this.launch(project, 'agent'),
    };
  }

  folders(name: string): Promise<string[]> {
    const list = loadProfiles();
    const profile = findProfile(name, list);
    if (!profile) throw new Error(`no server profile named ${name}`);
    const jump = jumpProfile(profile, list);
    const ticket = this.askpass.ticket(profile, jump);
    return listServerFolders(profile, jump, ticket.env).finally(() => ticket.dispose());
  }

  // ---------- tokens ----------

  tokenFor(projectId: string): string {
    return this.tokens.tokenFor(projectId);
  }

  /// The open project of a token, by a constant-time compare over all stored tokens. A closed project's token stays
  /// stored (a Claude job on the server keeps it across a restart) but does not resolve.
  projectOfToken(token: string): ProjectInfo | null {
    return projectOfToken(this.tokens, token, (id) => this.d.projects.get(id));
  }

  // ---------- commands ----------

  /// Why a terminal_run must not run, or null: the fork's hold (MCP/MCPService.swift confirmServerRun), for every caller.
  async confirmRun(project: ProjectInfo, command: string, cwd: string | undefined, local: boolean): Promise<string | null> {
    if (!project.server) return null;
    const loaded = this.loaded.get(project.id) ?? findProfile(project.server, loadProfiles()) ?? null;
    const saved = loaded ? lookUp(loaded, readProfiles()) : ({ kind: 'missing' } as const);
    const refusal = liveToggleRefusal(loaded, saved);
    if (refusal) return refusal;
    if (!needsQuestion(loaded, saved)) return null;
    for (const [text, what] of [[command, 'the command'], [cwd ?? '', 'the folder (cwd)'], [project.path, 'the server folder']] as const) {
      const reason = unsafeCharacters(text, what);
      if (reason) return `refused: ${reason}`;
    }
    const place = local ? `this computer (the ${loaded!.name} project)` : loaded!.name;
    const directory = local ? cwd || 'the home folder' : runFolder(project.path, cwd);
    const asker = 'Claude';
    const form: QuestionForm = {
      kind: 'hold',
      title: `Run this command on ${place}?`,
      info: `${asker} asks to run it in the command terminal, in ${visible(directory)}${cwd ? ` (cwd as Claude gave it: ${visible(cwd)})` : ''}. ${size(command)}; ↵ marks a line end, ⇥ a tab. With no answer in 2 minutes it is refused.`,
      textLabel: 'Command',
      text: visible(command),
      holdTitle: 'Hold to run',
      refuseTitle: 'Refuse',
      verb: 'Run',
    };
    const answer = await this.questions.ask(form, { group: project.id });
    return 'run' in answer ? null : 'refused' in answer ? answer.refused : 'refused by the user';
  }

  /// One command in a login of its own, in a tab the person watches. The earlier ended run tab goes, so tabs do not pile up.
  async runOnServer(project: ProjectInfo, command: string, cwd: string | undefined, waitMs: number): Promise<{ output: string; code: number | null; timedOut: boolean; run: number }> {
    const list = loadProfiles();
    const profile = this.profileOf(project);
    if (!profile.allowClaude) throw new Error(`${profile.name} does not allow Claude any more; terminal_run runs nothing there.`);
    const loaded = this.loaded.get(project.id);
    if (loaded && !sameLogin(loaded, profile)) throw new Error(`${profile.name} names another login now. Close this project and open it again.`);
    const unsafe = cwd ? unsafeCharacters(cwd, 'the folder (cwd)') : null;
    if (unsafe) throw new Error(unsafe);
    const jump = jumpProfile(profile, list);
    const earlier = this.runTabs.get(project.id);
    if (earlier !== undefined && this.d.terminals.list().some((t) => t.id === earlier && !t.alive)) this.d.terminals.close(earlier);
    const ticket = this.askpass.ticket(profile, jump);
    return new Promise((resolve, reject) => {
      let finished = false;
      let ended: RunState | null = null;
      let run = 0;
      let timer: NodeJS.Timeout;
      const launch: Launch = {
        ...runLaunch(profile, jump, project.path, cwd, command),
        env: ticket.env,
        project: project.id,
        rebuild: () => { throw new Error('A command does not run twice. Claude can ask for it again.'); },
        once: true,
        onExit: (_id, code, output) => {
          ticket.dispose();
          ended = { output: stripOutput(stripAnsi(output)), finished: true, code };
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve({ output: ended.output, code, timedOut: false, run });
        },
      };
      let id: number;
      try {
        id = this.d.terminals.create(launch).id;
      } catch (error) {
        ticket.dispose();
        reject(error);
        return;
      }
      this.runTabs.set(project.id, id);
      run = this.d.terminals.addRun(project.id, 'server', id, () => ended ?? { output: stripOutput(stripAnsi(this.d.terminals.buffer(id))), finished: false });
      this.d.reveal(project, 'shell');
      timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        // The command keeps running, as in macOS Vibex; terminal_output reads it by its run number.
        resolve({ output: stripOutput(stripAnsi(this.d.terminals.buffer(id))), code: null, timedOut: true, run });
      }, waitMs);
    });
  }

  // ---------- ports ----------

  /// A login nobody watches must not fail by itself: a failed askpass makes ssh send an empty password, and a server
  /// that counts those can lock the account. With a saved secret it gets one try; with none it never asks at all.
  private quietOptions(profile: ServerProfile): string[] {
    return quietLoginOptions(this.secrets.has(profile, expectedSecret(profile)), this.gate.mayConfirm());
  }

  private autoOn(profile: ServerProfile): boolean {
    return this.settings.autoForward?.[profile.name] ?? !profile.confirmCommands;
  }

  private ensurePorts(project: ProjectInfo, profile: ServerProfile): void {
    if (this.forwards.has(project.id)) return;
    const jump = jumpProfile(profile, loadProfiles());
    const changed = () => this.d.send('mod:servers:changed', project.id);
    const ticket = (silent: boolean, refused?: () => void) => this.askpass.ticket(profile, jump, silent, refused);
    const quiet = () => this.quietOptions(profile);
    const forwards = new ServerForwards({ profile, jump, ticket, quiet, changed });
    this.forwards.set(project.id, forwards);
    const watcher = new PortWatcher({
      forwards,
      profile,
      jump,
      ignored: new Set([profile.port ?? 22, ...(profile.forward ?? [])]),
      isUp: () => this.d.terminals.list().some((t) => t.alive && t.project === project.id),
      ticket,
      quiet,
      changed,
      announce: (message) => this.d.send('mod:servers:toast', 'Port forwarded', message),
      confirm: profile.confirmCommands ? async (port) => {
        if (this.questions.busy(project.id)) return null;
        const answer = await this.questions.ask(this.forwardForm(port, profile, `A new port listens on ${profile.name}: localhost:${port}. Refuse leaves it alone while this project is open.`), { group: project.id });
        return 'run' in answer;
      } : undefined,
    }, this.autoOn(profile));
    this.watchers.set(project.id, watcher);
    watcher.start();
  }

  private forwardForm(port: number, profile: ServerProfile, why: string): QuestionForm {
    return {
      kind: 'hold',
      title: `Forward server port ${port} to this computer?`,
      info: `${why} The app opens a new ssh login to ${profile.name} that forwards its localhost:${port} to a free port on this computer's 127.0.0.1, until the project closes. With no answer in 2 minutes it is refused.`,
      textLabel: 'Forward',
      text: `localhost:${port} on ${profile.name}  →  127.0.0.1 on this computer`,
      holdTitle: 'Hold to forward',
      refuseTitle: 'Refuse',
      verb: 'Forward',
    };
  }

  /// A forward Claude asked for: on a server with "confirmCommands" the person's hold comes first.
  private async forwardForClaude(project: ProjectInfo, target: Target): Promise<number> {
    const forwards = this.forwards.get(project.id);
    if (!forwards) throw new Error('this project has no connection yet');
    const profile = this.profileOf(project);
    const confirm = profile.confirmCommands || this.loaded.get(project.id)?.confirmCommands
      ? async () => 'run' in await this.questions.ask(this.forwardForm(target.port, profile, `Claude on ${profile.name} asks to show a page it serves there.`), { group: project.id })
      : undefined;
    const known = forwards.macPorts;
    const port = await forwards.forward(target, { confirm });
    if (!known.includes(port)) this.d.send('mod:servers:toast', `Forwarded port ${target.port} of ${profile.name}`, `Claude's page opens at 127.0.0.1:${port} on this computer. The Servers section lists and stops forwards.`);
    return port;
  }

  guard(): ServerGuardDeps {
    return {
      forwards: (project) => [...(this.forwards.get(project.id)?.macPorts ?? []), ...(this.loaded.get(project.id)?.forward ?? [])],
      portMap: (project) => {
        const map = new Map(this.forwards.get(project.id)?.portMap ?? []);
        for (const port of this.loaded.get(project.id)?.forward ?? []) map.set(port, port);
        return map;
      },
      forward: (project, target) => this.forwardForClaude(project, target),
    };
  }

  applyGuard(server: Parameters<typeof guardForServer>[0], project: ProjectInfo): void {
    guardForServer(server, project, this.guard());
  }

  projectClosed(id: string): void {
    // The stored token stays: a Claude job on the server still runs with it after a restart. It does not resolve while closed.
    this.loaded.delete(id);
    this.agentPorts.delete(id);
    this.runTabs.delete(id);
    this.questions.cancel(id);
    this.watchers.get(id)?.stop();
    this.watchers.delete(id);
    this.forwards.get(id)?.close();
    this.forwards.delete(id);
  }

  closeAll(): void {
    for (const id of [...this.forwards.keys()]) this.projectClosed(id);
    this.askpass.stop();
  }

  // ---------- the window ----------

  private saveFile(change: (list: any[]) => any[]): void {
    updateProfiles(profilesFile(), change);
    this.d.serversChanged();
  }

  /// A person allowed Claude on this server, in the app's own dialog.
  allowClaude(name: string): void {
    this.saveFile((list) => list.map((p) => (p && p.name === name ? { ...p, allowClaude: true } : p)));
  }

  private formInput(raw: any): ServerProfile {
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const forwardText = typeof raw?.forward === 'string' ? raw.forward : '';
    const forward = forwardText.split(/[\s,]+/).filter(Boolean).map(Number);
    const port = text(raw?.port);
    const input: any = {
      name: text(raw?.name) ?? '',
      host: text(raw?.host) ?? '',
      user: text(raw?.user) ?? '',
    };
    if (port) input.port = Number(port);
    if (raw?.authentication === 'password' || raw?.authentication === 'key') input.authentication = raw.authentication;
    if (text(raw?.identityFile)) input.identityFile = text(raw.identityFile);
    if (text(raw?.projectPath)) input.projectPath = text(raw.projectPath);
    if (forward.length) input.forward = forward;
    if (text(raw?.jump)) input.jump = text(raw.jump);
    if (raw?.allowClaude === true) input.allowClaude = true;
    if (raw?.confirmCommands === true) input.confirmCommands = true;
    return input;
  }

  private portsState(projectId: string) {
    const project = this.d.projects.get(projectId);
    if (!project?.server) return null;
    const forwards = this.forwards.get(projectId);
    const watcher = this.watchers.get(projectId);
    return {
      forwards: (forwards?.live ?? []).map((f) => ({ serverPort: f.target.port, macPort: f.macPort, manual: f.manual, auto: f.auto })).sort((a, b) => a.serverPort - b.serverPort),
      listening: watcher?.detection.listening ?? [],
      auto: watcher?.autoForward ?? false,
      error: watcher?.lastError ?? null,
    };
  }

  startIpc(host: Pick<ModuleHost, 'handle' | 'on'>): void {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (win) this.questions.holdProof = holdProofOf(pointerOf(win));
    host.handle('mod:servers:answer', (id: unknown, value: unknown) => { if (typeof id === 'string') this.questions.answer(id, value); });
    host.handle('mod:servers:ready', () => this.questions.showCurrent());
    host.handle('mod:servers:overlay', (on: unknown) => this.d.coverBrowsers('form', on === true));
    host.handle('mod:servers:list', () => {
      const read = readProfiles();
      return {
        problem: 'error' in read ? read.error : null,
        askpassProblem: this.askpass.problem,
        secretsAvailable: this.secrets.available(),
        servers: ('ok' in read ? read.ok : []).map((p) => ({
          name: p.name,
          address: `${p.user}@${p.host}${p.port && p.port !== 22 ? `:${p.port}` : ''}`,
          secret: expectedSecret(p),
          hasSecret: this.secrets.has(p, expectedSecret(p)),
          allowClaude: !!p.allowClaude,
          confirmCommands: !!p.confirmCommands,
        })),
      };
    });
    host.handle('mod:servers:get', (name: unknown) => {
      const found = typeof name === 'string' ? findProfile(name, loadProfiles()) : undefined;
      if (!found) throw new Error(`no server profile named ${String(name)}`);
      return found;
    });
    host.handle('mod:servers:save', (raw: unknown, previous: unknown) => {
      const input = this.formInput(raw);
      const before = typeof previous === 'string' ? previous : null;
      const read = readProfiles();
      if ('error' in read) throw new Error(read.error);
      const problem = checkProfile(input, read.ok, before);
      if (problem) throw new Error(problem);
      if (!isValid(input)) throw new Error('These values cannot be saved.');
      const old = before ? findProfile(before, read.ok) : undefined;
      if (old && old.name !== input.name && this.d.projects.list().some((p) => p.server === old.name)) throw new Error(`Close the projects on ${old.name} before you rename it.`);
      this.saveFile((list) => savedProfile(list, input, before));
      if (old && (old.name !== input.name || !sameLogin(old, input))) this.secrets.rename(old, input);
    });
    host.handle('mod:servers:remove', (name: unknown) => {
      if (typeof name !== 'string') return;
      if (this.d.projects.list().some((p) => p.server === name)) throw new Error(`Close the projects on ${name} before you remove it.`);
      const old = findProfile(name, loadProfiles());
      this.saveFile((list) => list.filter((p) => !(p && p.name === name)));
      if (old) this.secrets.forget(old);
    });
    host.handle('mod:servers:save-secret', (name: unknown, value: unknown) => {
      const profile = typeof name === 'string' ? findProfile(name, loadProfiles()) : undefined;
      if (!profile || typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) throw new Error('Enter a secret in one line.');
      this.secrets.set(profile, expectedSecret(profile), value);
    });
    host.handle('mod:servers:forget-secret', (name: unknown) => {
      const profile = typeof name === 'string' ? findProfile(name, loadProfiles()) : undefined;
      if (profile) this.secrets.forget(profile);
    });
    host.handle('mod:servers:confirm-remove', (name: unknown) => (typeof name === 'string' ? this.d.confirmRemove(name) : false));
    host.handle('mod:servers:ports', (id: unknown) => (typeof id === 'string' ? this.portsState(id) : null));
    host.handle('mod:servers:forward', async (id: unknown, port: unknown) => {
      const n = Number(port);
      if (typeof id !== 'string' || !Number.isInteger(n) || n < 1024 || n > 65535) throw new Error('Enter a server port between 1024 and 65535.');
      const forwards = this.forwards.get(id);
      if (!forwards) throw new Error('This project has no connection yet.');
      return forwards.forward({ host: 'localhost', port: n }, { manual: true });
    });
    host.handle('mod:servers:stop', (id: unknown, macPort: unknown) => {
      if (typeof id === 'string' && typeof macPort === 'number') this.forwards.get(id)?.stopByPerson(macPort);
    });
    host.handle('mod:servers:detect', async (id: unknown) => {
      if (typeof id === 'string') await this.watchers.get(id)?.detectNow();
    });
    host.handle('mod:servers:auto', (id: unknown, on: unknown) => {
      if (typeof id !== 'string') return;
      const project = this.d.projects.get(id);
      const watcher = this.watchers.get(id);
      if (!project?.server || !watcher) return;
      watcher.setAuto(on === true);
      this.settings.autoForward = { ...this.settings.autoForward, [project.server]: on === true };
      try {
        writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
      } catch (error) {
        this.d.send('mod:servers:toast', 'Could not save this setting', plainError(error));
      }
    });
  }
}

/// For the Playwright tests through electronApp.evaluate. A function and not a method, so a release bundle drops it.
export function hubTestHooks(hub: ServerHub) {
  const h = hub as any;
  return {
    tokenFor: (id: string) => h.tokenFor(id),
    tunnelPort: (id: string) => h.agentPorts.get(id),
    askpassSocket: () => h.askpass.socketPath,
    saveSecret: (name: string, kind: 'password' | 'passphrase', value: string) => h.secrets.set(findProfile(name, loadProfiles())!, kind, value),
    forget: (name: string) => h.secrets.forget(findProfile(name, loadProfiles())!),
    quietOptions: (name: string) => h.quietOptions(findProfile(name, loadProfiles())!),
    setQuestionTimeout: (ms: number | null) => { h.questions.timeoutMs = ms ?? 120_000; },
    testQuestion: () => void h.questions.ask({ kind: 'hold', title: 'Test', info: 'A question for the tests.', textLabel: 'Text', text: 'test', holdTitle: 'Hold', refuseTitle: 'Refuse', verb: 'Run' }),
    agentArgs: (profile: ServerProfile, folder: string) => tunnelLaunch(profile, undefined, folder, 'agent', { remotePort: serverPorts('x')[0], localPort: h.mcpPort ?? 1, windowId: 'x', token: 'x' }).args,
    shellPorts,
  };
}

let hub: ServerHub | null = null;

/// server_list and server_connect, in the MODULES list.
export const serversModule = serverToolsModule(() => {
  const h = hub;
  if (!h) return null;
  const d = (h as any).d as HubDeps;
  return {
    allowed: () => loadProfiles().filter((p) => p.allowClaude).map((p) => ({
      name: p.name,
      address: `${p.user}@${p.host}${p.port && p.port !== 22 ? `:${p.port}` : ''}`,
      login: p.authentication === 'password' ? 'password' : p.authentication === 'key' || p.identityFile ? 'key' : 'as the ssh config says',
      confirm: !!p.confirmCommands,
    })),
    here: (project) => (project.server ? { server: project.server, folder: project.path } : null),
    connect: (name, project) => {
      const profile = findProfile(name, loadProfiles().filter((p) => p.allowClaude));
      if (!profile) throw new Error(`no server named ${name} allows Claude; see server_list`);
      d.terminals.create(h.connectTab(profile, project));
      d.reveal(project, 'shell');
      d.send('mod:servers:toast', `SSH to ${profile.name}`, `${profile.user}@${profile.host}`);
      return `Opened an SSH tab to ${profile.name} (${profile.user}@${profile.host}${profile.port && profile.port !== 22 ? `:${profile.port}` : ''}) in the command terminal.`;
    },
  };
});
