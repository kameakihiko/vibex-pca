import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import type { Ticket } from './askpass';
import { findProgram } from './programs';
import { loginArgs, sshProgram, viaSh, type ServerProfile } from './servers';

// Ports of a server opened on this computer's loopback (fork: Servers/ServerPortForward.swift, ServerPortWatcher.swift).
// The fork shares one ssh connection through a ControlMaster socket, except on a server with "confirmCommands". Windows
// OpenSSH has no ControlMaster, so here every forward is its own login on all systems, as the fork's confirmCommands
// mode is. So a saved password or a key answers each login, and a forward needs no window's connection to stay up.

/// The server ports the app forwards: no privileged port.
export const PORTS = [1024, 65535] as const;
const MAC_PORTS = [50_000, 59_999] as const;
export const MAX_FORWARDS = 8;
const LOGIN_MS = 150_000;
/// The server ports of the app's own tunnels (the Claude tab: 20000-59999; other tabs: 60000-64999).
export const TUNNEL_PORTS = [20_000, 64_999] as const;

export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export interface Listening { port: number; host: string }
export interface Target { host: string; port: number }

const END_MARKER = '#vibex-ports-end';

/// The listing, in POSIX sh: ss, else netstat, else lsof. Fixed text: nothing in it comes from a person, a profile or the
/// server. Read-only.
const LIST_FUNCTION = `vibex_list() {
  if command -v ss >/dev/null 2>&1; then
    o=$(ss -ltnH 2>/dev/null) || o=$(ss -ltn 2>/dev/null)
    case "$o" in *LISTEN*) printf '%s\\n' '#vibex-ports ss' "$o"; return 0 ;; esac
  fi
  if command -v netstat >/dev/null 2>&1; then
    o=$(netstat -ltn 2>/dev/null)
    case "$o" in *LISTEN*) ;; *) o=$(netstat -an -p tcp 2>/dev/null) ;; esac
    case "$o" in *LISTEN*) printf '%s\\n' '#vibex-ports netstat' "$o"; return 0 ;; esac
  fi
  if command -v lsof >/dev/null 2>&1; then
    o=$(lsof -iTCP -sTCP:LISTEN -nP 2>/dev/null)
    printf '%s\\n' '#vibex-ports lsof' "$o"; return 0
  fi
  echo '#vibex-ports none'
}`;

export const ONCE_COMMAND = viaSh(`${LIST_FUNCTION}\nvibex_list\n`);
export const LOOP_COMMAND = viaSh(`${LIST_FUNCTION}\nwhile :; do vibex_list; echo '${END_MARKER}'; sleep 5; done\n`);
/// What a forward's login runs: it reads stdin, so it ends when this app ends, also after a crash, on each system.
export const HOLD_COMMAND = viaSh('cat >/dev/null\n');

function localAddress(tokens: string[]): string | null {
  // lsof: ... TCP 127.0.0.1:8790 (LISTEN)
  const at = tokens.indexOf('(LISTEN)');
  if (at >= 2 && tokens[at - 2] === 'TCP') return tokens[at - 1];
  // ss: LISTEN 0 4096 127.0.0.1:8790 0.0.0.0:*
  if (tokens[0] === 'LISTEN' && tokens.length >= 5) return tokens[3];
  // netstat: tcp 0 0 127.0.0.1:8790 0.0.0.0:* LISTEN (Linux), tcp4 0 0 127.0.0.1.8790 *.* LISTEN (BSD)
  if (tokens[0]?.toLowerCase().startsWith('tcp') && tokens.length >= 6 && tokens.at(-1) === 'LISTEN') return tokens[3];
  return null;
}

function splitAddress(address: string): [string, number] | null {
  const separator = Math.max(address.lastIndexOf(':'), address.lastIndexOf('.'));
  if (separator < 0) return null;
  const port = Number(address.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  let host = address.slice(0, separator);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zone = host.indexOf('%');
  return [zone >= 0 ? host.slice(0, zone) : host, port];
}

/// The listening ports on the server's loopback or a wildcard. A port bound only to another address is left out: a
/// forward to the loopback would not reach it.
export function parseListing(output: string): Listening[] {
  const binds = new Map<number, string[]>();
  for (const line of output.split(/\r?\n/)) {
    const address = localAddress(line.split(/[ \t]+/).filter(Boolean));
    const parts = address && splitAddress(address);
    if (!parts) continue;
    const [host, port] = parts;
    if (!['127.0.0.1', '0.0.0.0', '::1', '::', '*'].includes(host)) continue;
    binds.set(port, [...(binds.get(port) ?? []), host]);
  }
  return [...binds].map(([port, found]) => ({
    port,
    host: found.some((h) => h === '127.0.0.1' || h === '0.0.0.0') ? '127.0.0.1' : found.includes('::1') ? '::1' : 'localhost',
  })).sort((a, b) => a.port - b.port);
}

/// The ports detection offers: 1024 and up, not the app's own tunnels, not `ignoring`.
export function offered(listening: Listening[], ignoring: Set<number>): Listening[] {
  return listening.filter((l) => l.port >= PORTS[0] && l.port <= PORTS[1] && !(l.port >= TUNNEL_PORTS[0] && l.port <= TUNNEL_PORTS[1]) && !ignoring.has(l.port));
}

const GRACE_LISTINGS = 2;

/// What changed between two listings. The ports at the first listing were there before the app looked, so they are only
/// offered, as VS Code does. A dev server that restarts within one listing keeps its forward.
export class PortDetection {
  private baseline: Set<number> | null = null;
  listening: Listening[] = [];
  private missing = new Map<number, number>();

  update(now: Listening[], forwarded: Set<number>, heldBack: Set<number>): { new: Listening[]; gone: number[] } {
    const ports = new Set(now.map((l) => l.port));
    const gone: number[] = [];
    for (const port of new Set([...this.listening.map((l) => l.port), ...this.missing.keys()])) {
      if (ports.has(port)) continue;
      const count = (this.missing.get(port) ?? 0) + 1;
      if (count >= GRACE_LISTINGS) {
        this.missing.delete(port);
        this.baseline?.delete(port);
        gone.push(port);
      } else {
        this.missing.set(port, count);
      }
    }
    for (const port of ports) this.missing.delete(port);
    this.listening = now;
    if (!this.baseline) {
      this.baseline = ports;
      return { new: [], gone };
    }
    const baseline = this.baseline;
    return { new: now.filter((l) => !baseline.has(l.port) && !forwarded.has(l.port) && !heldBack.has(l.port)), gone: gone.sort((a, b) => a - b) };
  }
}

function isBusy(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (e: NodeJS.ErrnoException) => resolve(e.code !== 'EADDRNOTAVAIL' && e.code !== 'EAFNOSUPPORT'));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(false)));
  });
}

/// A free port here: nothing listens on it on 127.0.0.1 or ::1, so no local service is shadowed.
async function freePort(avoid: Set<number>): Promise<number | null> {
  for (let i = 0; i < 64; i++) {
    const port = MAC_PORTS[0] + Math.floor(Math.random() * (MAC_PORTS[1] - MAC_PORTS[0] + 1));
    if (avoid.has(port)) continue;
    if (!(await isBusy(port, '127.0.0.1')) && !(await isBusy(port, '::1'))) return port;
  }
  return null;
}

const accepts = (port: number) => new Promise<boolean>((resolve) => {
  const c = net.connect(port, '127.0.0.1');
  c.once('connect', () => { c.destroy(); resolve(true); });
  c.once('error', () => resolve(false));
});

export interface Forward {
  target: Target;
  macPort: number;
  /// The person's own forward: its own allowance.
  manual: boolean;
  /// From detection: it gives its place to a forward Claude or the person asks for.
  auto: boolean;
  lastUsed: number;
  process: ChildProcess;
  ticket: Ticket;
}

export interface ForwardDeps {
  profile: ServerProfile;
  jump?: ServerProfile;
  /// `refused`: the saved secret of this silent login was not confirmed (askpass.ts).
  ticket: (silent: boolean, refused?: () => void) => Ticket;
  /// The options of a login nobody watches.
  quiet: () => string[];
  changed: () => void;
  /// Starts a forward's ssh (tests give a stand-in). Default: the ssh of this computer.
  launch?: (args: string[], env: NodeJS.ProcessEnv, stdio: ('pipe' | 'ignore')[]) => ChildProcess;
}

/// The ports one project forwards. They end when the project closes, and at most 8 of Claude's and 8 of the person's.
export class ServerForwards {
  private list: Forward[] = [];
  private starting = new Map<number, { manual: boolean; job: Promise<number> }>();
  private reserved = new Set<number>();
  private closed = false;
  /// Server ports detection must leave alone for the rest of this project's life.
  readonly heldBack = new Set<number>();

  constructor(private readonly deps: ForwardDeps) {}

  get live(): Forward[] {
    return this.list.filter((f) => f.process.exitCode === null && f.process.signalCode === null);
  }
  get macPorts(): number[] {
    return this.live.map((f) => f.macPort);
  }
  get portMap(): Map<number, number> {
    return new Map(this.live.map((f) => [f.target.port, f.macPort]));
  }
  get autoSlotsFree(): number {
    return MAX_FORWARDS - this.live.filter((f) => !f.manual).length - [...this.starting.values()].filter((s) => !s.manual).length;
  }

  touch(serverPort: number): void {
    const found = this.list.find((f) => f.target.port === serverPort);
    if (found) found.lastUsed = Date.now();
  }

  /// A live forward of the same server port is used again. `confirm`, for a server with "confirmCommands": the person's
  /// hold comes before the login. `silent`: the login never asks the person (detection).
  /// `refused`: an auto login's saved secret was not confirmed; its ssh is ended at once, before it can send an empty password.
  async forward(target: Target, o: { confirm?: () => Promise<boolean>; manual?: boolean; auto?: boolean; refused?: () => void } = {}): Promise<number> {
    const manual = !!o.manual;
    if (!LOOPBACK_HOSTS.has(target.host)) throw new Error("The app forwards only the server's own loopback (localhost, 127.0.0.1, [::1]).");
    if (!Number.isInteger(target.port) || target.port < PORTS[0] || target.port > PORTS[1]) throw new Error(`Server port ${target.port} is outside ${PORTS[0]}-${PORTS[1]}.`);
    if (this.closed) throw new Error('The project closed.');
    const running = this.starting.get(target.port);
    if (running) return running.job;
    const existing = this.live.find((f) => f.target.port === target.port);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.macPort;
    }
    const count = this.live.filter((f) => f.manual === manual).length + [...this.starting.values()].filter((s) => s.manual === manual).length;
    if (count >= MAX_FORWARDS && (manual || o.auto || !this.live.some((f) => f.auto))) throw new Error(`This project forwards ${MAX_FORWARDS} server ports already. Stop one in the Servers section.`);
    const job = this.open(target, manual, !!o.auto, o.confirm, o.refused);
    this.starting.set(target.port, { manual, job });
    try {
      const macPort = await job;
      if (!manual) this.yieldOverflow(macPort);
      return macPort;
    } finally {
      this.starting.delete(target.port);
    }
  }

  private yieldOverflow(keep: number): void {
    while (this.live.filter((f) => !f.manual).length > MAX_FORWARDS) {
      const victim = this.live.filter((f) => f.auto && f.macPort !== keep).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!victim) return;
      this.heldBack.add(victim.target.port);
      this.stop(victim.macPort);
    }
  }

  private async open(target: Target, manual: boolean, auto: boolean, confirm?: () => Promise<boolean>, refused?: () => void): Promise<number> {
    if (confirm && !(await confirm())) throw new Error('The person did not allow the forward.');
    if (this.closed) throw new Error('The project closed.');
    let last: Error = new Error('No free port on this computer.');
    for (let attempt = 0; attempt < 2; attempt++) {
      const macPort = await freePort(new Set([...this.reserved, ...this.list.map((f) => f.macPort)]));
      if (macPort === null) break;
      this.reserved.add(macPort);
      try {
        await this.start(target, macPort, manual, auto, refused);
        this.deps.changed();
        return macPort;
      } catch (error) {
        last = error as Error;
        if (!/address already in use|port forwarding failed|cannot listen/i.test(last.message)) throw last;
      } finally {
        this.reserved.delete(macPort);
      }
    }
    throw last;
  }

  private async start(target: Target, macPort: number, manual: boolean, auto: boolean, refused?: () => void): Promise<void> {
    const host = target.host === '::1' ? '[::1]' : target.host;
    let launched: ChildProcess | null = null;
    const ticket = this.deps.ticket(auto, auto ? () => {
      launched?.kill();
      refused?.();
    } : undefined);
    const args = loginArgs(this.deps.profile, this.deps.jump, [...(auto ? this.deps.quiet() : []), '-L', `127.0.0.1:${macPort}:${host}:${target.port}`, '-o', 'ExitOnForwardFailure=yes'], HOLD_COMMAND);
    const env = { ...process.env, ...ticket.env };
    const child = this.deps.launch ? this.deps.launch(args, env, ['pipe', 'ignore', 'pipe']) : spawn(sshProgram(), args, { env, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    launched = child;
    let errors = '';
    child.stderr?.on('data', (d: Buffer) => { errors = (errors + d.toString()).slice(-2000); });
    const ended = new Promise<void>((resolve) => { child.once('close', () => resolve()); child.once('error', () => resolve()); });
    void ended.then(() => {
      ticket.dispose();
      if (this.list.some((f) => f.process === child)) {
        this.list = this.list.filter((f) => f.process !== child);
        this.deps.changed();
      }
    });
    const deadline = Date.now() + LOGIN_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) break;
      if (await accepts(macPort)) {
        this.list.push({ target, macPort, manual, auto, lastUsed: Date.now(), process: child, ticket });
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (child.exitCode === null && child.pid !== undefined) child.kill();
    await ended;
    const line = errors.trim().split('\n').pop();
    throw new Error(line ? `ssh: ${line}` : `The forward to port ${macPort} was not ready in time.`);
  }

  stop(macPort: number): void {
    const found = this.list.find((f) => f.macPort === macPort);
    if (!found) return;
    this.list = this.list.filter((f) => f !== found);
    found.process.kill();
    this.deps.changed();
  }

  /// The person's Stop: detection leaves the port alone from then on.
  stopByPerson(macPort: number): void {
    const found = this.list.find((f) => f.macPort === macPort);
    if (found) this.heldBack.add(found.target.port);
    this.stop(macPort);
  }

  /// The server stopped listening: its detected forward ends. Others stay.
  serverPortGone(port: number): void {
    for (const f of this.list.filter((x) => x.auto && x.target.port === port)) this.stop(f.macPort);
  }

  close(): void {
    this.closed = true;
    for (const f of [...this.list]) this.stop(f.macPort);
  }
}

export interface WatcherDeps {
  forwards: ServerForwards;
  profile: ServerProfile;
  jump?: ServerProfile;
  ignored: Set<number>;
  /// Whether a tab of the project runs now. Nothing is listed while none does.
  isUp: () => boolean;
  /// `refused`: the saved secret of this silent login was not confirmed (askpass.ts).
  ticket: (silent: boolean, refused?: () => void) => Ticket;
  quiet: () => string[];
  /// Starts the listing's ssh (tests give a stand-in). Default: the ssh of this computer.
  launch?: (args: string[], env: NodeJS.ProcessEnv, stdio: ('pipe' | 'ignore')[]) => ChildProcess;
  /// The person's hold for a new port on a server with "confirmCommands": true forward, false no, null asked nothing.
  confirm?: (port: number) => Promise<boolean | null>;
  changed: () => void;
  announce: (message: string) => void;
}

const RETRY_MS = 60_000;
/// Listing logins that end with no listing, in a row, before detection stops until the person asks: each may be a
/// failed login on the server.
const MAX_STREAM_FAILURES = 3;
const QUESTION_GAP_MS = 5 * 60_000;
const FORWARD_REFUSED = 'Automatic forwarding stopped: the saved secret was not confirmed. Detect Ports tries again.';

/// Port detection of one project: one login that lists every 5 seconds while a tab runs. It answers from saved secrets
/// only and never asks by itself, so a server with no saved password has only the person's "Detect Ports".
export class PortWatcher {
  detection = new PortDetection();
  lastError: string | null = null;
  autoForward: boolean;
  private stream: ChildProcess | null = null;
  private streamTicket: Ticket | null = null;
  private retryAfter = 0;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private pending = new Set<number>();
  private failures = new Map<number, number>();
  private announced = new Set<number>();
  private lastQuestion = 0;
  private streamFailures = 0;
  /// The person did not confirm the listing's saved secret (fork: streamRefused). No new listing, so no new prompt, until
  /// the person presses Detect Ports or connects again.
  private streamRefused = false;
  /// The same for the logins of detected ports: one refusal pauses automatic forwarding for this connection.
  private forwardRefused = false;

  constructor(private readonly deps: WatcherDeps, autoForward: boolean) {
    this.autoForward = autoForward;
  }

  start(): void {
    this.timer ??= setInterval(() => this.tick(), 5_000);
    this.tick();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.endStream();
  }

  setAuto(on: boolean): void {
    this.autoForward = on;
    if (on) this.tick();
    else {
      this.endStream();
      this.streamRefused = false;
      this.forwardRefused = false;
    }
  }

  private endStream(): void {
    this.stream?.kill();
    this.stream = null;
    this.streamTicket?.dispose();
    this.streamTicket = null;
  }

  private tick(): void {
    if (this.closed) return;
    if (!this.autoForward || !this.deps.isUp()) {
      // The connection is down (or detection is off): the next connection may ask again.
      this.streamRefused = false;
      this.forwardRefused = false;
      return this.endStream();
    }
    if (this.stream || this.streamRefused || Date.now() < this.retryAfter || this.streamFailures >= MAX_STREAM_FAILURES) return;
    // No ssh on this computer: this runs on a timer, so nothing could catch the error.
    if (!this.deps.launch && !findProgram('ssh')) return;
    let child: ChildProcess | null = null;
    const refused = () => {
      if (!child || this.stream !== child) return;
      this.streamRefused = true;
      this.lastError = 'Port detection stopped: the saved secret was not confirmed. Detect Ports tries again.';
      this.endStream();
      this.deps.changed();
    };
    const ticket = this.deps.ticket(true, refused);
    child = this.launch(loginArgs(this.deps.profile, this.deps.jump, this.deps.quiet(), LOOP_COMMAND), { ...process.env, ...ticket.env }, ['pipe', 'pipe', 'ignore']);
    this.stream = child;
    this.streamTicket = ticket;
    let text = '';
    let last = 0;
    let listed = false;
    child.stdout?.on('data', (d: Buffer) => {
      text = (text + d.toString()).slice(-256 * 1024);
      let at: number;
      while ((at = text.indexOf(END_MARKER)) >= 0) {
        const listing = text.slice(0, at);
        text = text.slice(at + END_MARKER.length);
        listed = true;
        this.streamFailures = 0;
        // A server that writes listings as fast as it can changes nothing more often.
        if (Date.now() - last >= 4_000) {
          last = Date.now();
          this.apply(listing);
        }
      }
    });
    const ended = () => {
      if (this.stream !== child) return;
      this.stream = null;
      ticket.dispose();
      this.streamTicket = null;
      this.retryAfter = Date.now() + RETRY_MS;
      if (!listed && ++this.streamFailures >= MAX_STREAM_FAILURES) {
        this.lastError = 'The app could not list the ports by itself. Save the login, then press Detect Ports.';
        this.deps.changed();
      }
    };
    child.once('close', ended);
    child.once('error', ended);
  }

  /// "Detect Ports": one listing now, whatever the setting. It may ask for a password, as any login the person starts.
  detectNow(): Promise<void> {
    this.streamFailures = 0;
    // The person's own action: the listing and automatic forwarding may ask again.
    this.streamRefused = false;
    this.forwardRefused = false;
    return new Promise((resolve) => {
      const ticket = this.deps.ticket(false);
      const child = this.launch(loginArgs(this.deps.profile, this.deps.jump, [], ONCE_COMMAND), { ...process.env, ...ticket.env }, ['ignore', 'pipe', 'pipe']);
      let out = '';
      let err = '';
      child.stdout?.on('data', (d: Buffer) => { if (out.length < 1024 * 1024) out += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-1000); });
      const done = (code: number | null) => {
        ticket.dispose();
        if (this.closed) return resolve();
        if (code === 0) this.apply(out);
        else this.lastError = err.trim().split('\n').pop() || 'The listing did not finish.';
        this.deps.changed();
        resolve();
      };
      child.once('close', done);
      child.once('error', () => done(null));
    });
  }

  private launch(args: string[], env: NodeJS.ProcessEnv, stdio: ('pipe' | 'ignore')[]): ChildProcess {
    return this.deps.launch ? this.deps.launch(args, env, stdio) : spawn(sshProgram(), args, { env, stdio, windowsHide: true });
  }

  apply(output: string): void {
    if (this.closed) return;
    this.lastError = output.includes('#vibex-ports none') ? 'The server has none of ss, netstat or lsof.' : this.forwardRefused ? FORWARD_REFUSED : null;
    const { forwards } = this.deps;
    const list = offered(parseListing(output), this.deps.ignored);
    const change = this.detection.update(list, new Set([...forwards.portMap.keys(), ...this.deps.ignored]), forwards.heldBack);
    for (const port of change.gone) {
      this.failures.delete(port);
      forwards.serverPortGone(port);
    }
    // Only a different listing redraws the Servers section: a redraw every 5 s takes a half-typed password away.
    if (change.new.length || change.gone.length) this.deps.changed();
    if (!this.autoForward || this.forwardRefused) return;
    const now = Date.now();
    const fresh = change.new.filter((l) => !this.pending.has(l.port) && now - (this.failures.get(l.port) ?? 0) >= RETRY_MS);
    if (fresh.length) void this.forwardNew(fresh);
  }

  private async forwardNew(items: Listening[]): Promise<void> {
    for (const l of items) this.pending.add(l.port);
    const opened: [number, number][] = [];
    for (const item of items) {
      const { forwards, confirm } = this.deps;
      if (this.closed || !this.autoForward || this.forwardRefused || forwards.autoSlotsFree <= 0) break;
      // One question per 5 minutes: a server that opens a new port each listing cannot keep the person answering.
      if (confirm && Date.now() - this.lastQuestion < QUESTION_GAP_MS) break;
      let notAsked = false;
      try {
        const macPort = await forwards.forward({ host: item.host, port: item.port }, {
          auto: true,
          refused: () => {
            this.forwardRefused = true;
            this.lastError = FORWARD_REFUSED;
            this.deps.changed();
          },
          confirm: confirm && (async () => {
            const answer = await confirm(item.port);
            if (answer === null) {
              notAsked = true;
              return false;
            }
            this.lastQuestion = Date.now();
            return answer;
          }),
        });
        this.failures.delete(item.port);
        opened.push([item.port, macPort]);
      } catch (error) {
        if (/did not allow/.test(String(error)) && !notAsked) forwards.heldBack.add(item.port);
        else this.failures.set(item.port, Date.now());
      }
    }
    for (const l of items) this.pending.delete(l.port);
    const told = opened.filter(([port]) => {
      if (this.announced.has(port)) return false;
      this.announced.add(port);
      return true;
    });
    if (told.length && !this.closed) this.deps.announce(`${this.deps.profile.name}: forwarded ${told.map(([s, m]) => `${s} to 127.0.0.1:${m}`).join(', ')}.`);
    this.deps.changed();
  }
}
