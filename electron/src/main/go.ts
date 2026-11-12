import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BrowserWindow, safeStorage, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { describeLogged, describeRequest, GoDesk, GoError, GoLog, MAX_WAIT_SECONDS, parseAsk } from './goDesk';
import type { InboxService } from './inbox';
import type { ModuleHost, ToolContext } from './modules';
import { isTestRun, testEnv } from './testSwitches';
import { osStoreAvailable } from './token';
import { pointerOf, type WindowPointer } from './windowPointer';

// The Go gate, wired to the window (macOS Vibex: Go/GoPanel.swift, MCP/Tools/GoTools.swift).
// The answer comes only from the window's own mouse input: this file reads Electron's `input-event` on the app
// window (the main process sees every real mouse event before the page does), and a hold on Go must match it.
// No MCP tool, no page in the side browser (no IPC at all), and no script in the window (it makes no input event)
// can answer. What it does not stop: a program that injects OS-level mouse input into the window (xdotool,
// SendInput, osascript). The arm delay, the hold, and the window having to be in front are the only brakes there;
// macOS Vibex also checks the process that posted the event, which Windows and Linux do not give.

const DEFAULT_ARM_MS = 1500;
const DEFAULT_HOLD_MS = 1000;

/// The signing key of the go log: 32 random bytes kept encrypted by the OS store (DPAPI, Keychain, libsecret). With no
/// store it lives in memory for this run, so an entry signed in an earlier run shows as "tampered" in the log.
function logKey(userData: string): () => Buffer {
  let cached: Buffer | null = null;
  return () => {
    if (cached) return cached;
    if (!osStoreAvailable()) return (cached = randomBytes(32));
    const file = path.join(userData, 'go-log.key.bin');
    if (existsSync(file)) {
      try {
        const key = Buffer.from(safeStorage.decryptString(readFileSync(file)), 'base64');
        if (key.length === 32) return (cached = key);
      } catch {
        // Unreadable (another user or a reset store): a new key below. Older entries then show as unverified.
      }
    }
    const key = randomBytes(32);
    writeFileSync(file, safeStorage.encryptString(key.toString('base64')), { mode: 0o600 });
    return (cached = key);
  };
}

export class GoService {
  private host!: ModuleHost;
  private desk!: GoDesk;
  private inbox!: InboxService;
  private win: BrowserWindow | null = null;
  private pointer: WindowPointer | null = null;
  private isFront: () => boolean = () => false;

  start(host: ModuleHost, inbox: InboxService): void {
    this.host = host;
    this.inbox = inbox;
    const test = isTestRun();
    const number = (value: string | undefined, fallback: number) => (test && /^\d+$/.test(value ?? '') ? Number(value) : fallback);
    this.desk = new GoDesk(new GoLog(path.join(host.userData, 'go-log.json'), logKey(host.userData)), {
      armMs: number(testEnv('VIBEX_GO_ARM_MS'), DEFAULT_ARM_MS),
      holdMs: number(testEnv('VIBEX_GO_HOLD_MS'), DEFAULT_HOLD_MS),
    });
    this.desk.onChange = () => host.send('mod:go:changed', this.snapshot());

    this.win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
    if (this.win) {
      const win = this.win;
      // The tests may run on a computer where other programs take the focus; only then they can ask not to need it.
      const needFocus = !(test && testEnv('VIBEX_GO_ASSUME_FRONT') === '1');
      this.isFront = () => (!needFocus || win.isFocused()) && win.isVisible() && !win.isMinimized();
      const front = this.isFront;
      for (const event of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore']) win.on(event as any, () => this.desk.setFront(front()));
      this.desk.setFront(front());
      this.pointer = pointerOf(win);
    }

    host.handle('mod:go:state', () => this.snapshot());
    host.on('mod:go:shown', (projectId: string, id: string | null) => this.desk.noteShown(String(projectId), id ? String(id) : null));
    host.on('mod:go:read', (id: string) => this.desk.noteReadToEnd(String(id)));
    host.on('mod:go:fits', (fits: boolean) => this.desk.setFits(!!fits));
    host.handle('mod:go:blocker', (projectId: string, id: string) => {
      // The events can arrive late or out of order; the window's state now is what counts.
      this.desk.setFront(this.isFront());
      return this.desk.goBlocker(String(id), String(projectId));
    });
    host.handle('mod:go:answer', (id: string, decision: string, note: string | null) => this.answer(String(id), decision, note));
    host.handle('mod:go:open', (id: string, which: string) => this.open(String(id), which));
  }

  private snapshot() {
    return {
      holdMs: this.desk.options.holdMs,
      armMs: this.desk.options.armMs,
      requests: this.host.projects.list().flatMap((p) => this.desk.all(p.id).slice(-20)),
    };
  }

  /// The owner's answer: proved by the press the window itself saw on the button of that answer.
  private async answer(id: string, decision: string, note: string | null) {
    if (decision !== 'go' && decision !== 'declined') throw new GoError('the answer is go or declined');
    const request = this.desk.request(id);
    if (!request) throw new GoError(`no request ${id}`);
    this.desk.setFront(this.isFront());
    if (!this.pointer) throw new GoError('the window is not there');
    const button = `.go-panel[data-project=${JSON.stringify(request.projectId)}] ${decision === 'go' ? '.go-yes' : '.go-no'}`;
    const click = await this.pointer.verify(button, decision === 'go' ? this.desk.options.holdMs : null);
    this.desk.answer(id, decision, note ? String(note).slice(0, 300) : null, click);
    return { ok: true };
  }

  /// Opens a link of a request: a web page in the side browser, a local review page in the file manager.
  private async open(id: string, which: string): Promise<void> {
    const request = this.desk.request(id);
    const project = request && this.host.projects.get(request.projectId);
    const link = which === 'review' ? request?.reviewUrl : which === 'pr' ? request?.prUrl : null;
    if (!project || !link) throw new GoError('this request has no such link');
    if (/^https?:/i.test(link)) await this.host.browserFor(project).navigate(link);
    else shell.showItemInFolder(link);
  }

  tools(server: McpServer, ctx: ToolContext): void {
    server.registerTool('vibex_request_go', {
      description: "Ask the owner for the go before a merge, a deploy, a production write or a message to real people. Shows a Go panel in this project's window with the title, the numbered items (exactly what will ship or run) and links. Only the owner's hold on Go, or a click on Not now, with the mouse in the panel, answers it; no tool can. Returns at once with a request id: read the answer with vibex_go_status. Changed items need a new request. A typed go in chat still counts.",
      inputSchema: {
        title: z.string().describe('What needs the go, e.g. Merge PR #12 and deploy the shop'),
        items: z.array(z.string()).describe('Exactly what will ship or run, one item each (commits, commands, hosts, messages)'),
        review_url: z.string().optional().describe('Optional before/after review page: http(s) URL, or an absolute path to a local .html file'),
        pr_url: z.string().optional().describe('Optional pull request URL (http(s))'),
        device: z.enum(['desktop', 'phone', 'tablet']).optional().describe('Where to open the review page: desktop (side browser, default). The phone and tablet simulators are not in this build'),
        ...ctx.scope,
      },
    }, async (args: any) => {
      const project = ctx.project(args.project_path);
      if (project.server) throw new GoError(`${project.name} runs on a server; the Go panel works for projects on this computer in this build`);
      const ask = parseAsk(args);
      const before = this.desk.pending(project.id).map((r) => r.id);
      const request = this.desk.submit(ask, project.id, project.name, project.path);
      const repeated = before.includes(request.id);
      const lines = [
        'status: pending',
        repeated ? `The same request is already waiting in the Go panel: id ${request.id}.` : `Request ${request.id} waits in the Go panel of the ${project.name} window.`,
        `items hash: ${request.itemsHash}`,
      ];
      const others = this.desk.pending(project.id).length - 1;
      if (others > 0) lines.push(`${others} other request${others === 1 ? '' : 's'} also wait${others === 1 ? 's' : ''} there.`);
      if (ask.device && ask.device !== 'desktop') lines.push('The simulators are not in this build. The review page opens from the Go panel.');
      if (!repeated) {
        this.host.reveal(project, 'browser');
        this.inbox.notify('Claude asks for your go', `${project.name}: a request waits in the Go panel`);
      } else {
        // A repeat of a request whose panel the person closed opens the panel again.
        this.host.reveal(project, 'browser');
        this.host.send('mod:go:show', project.id);
      }
      lines.push(`Only the owner's hold on Go in the panel answers it. Read it with vibex_go_status (wait_seconds up to ${MAX_WAIT_SECONDS}).`);
      return ctx.said(lines.join('\n'), project);
    });

    server.registerTool('vibex_go_status', {
      description: 'The answer to a vibex_request_go request. The first line is status: pending, go or declined (only for an answer given in this run of Vibex), or unverified for one found only in the log, which is never a go; the second is JSON with the id, title, items hash, answer time and the owner\'s note. wait_seconds (up to 600) waits for the answer.',
      inputSchema: {
        id: z.string().describe('Request id from vibex_request_go'),
        wait_seconds: z.number().int().optional().describe('Seconds to wait while it is pending (default 0, max 600)'),
        ...ctx.scope,
      },
    }, async ({ id, wait_seconds, project_path }: any) => {
      const project = ctx.project(project_path);
      const found = this.desk.status(id, project.id, project.path);
      if (found.logged) return ctx.said(describeLogged(found.logged), project);
      let request = found.request!;
      const wait = Math.min(Math.max(wait_seconds ?? 0, 0), MAX_WAIT_SECONDS);
      if (!request.answer && wait > 0) request = (await this.desk.wait(id, wait)) ?? request;
      return ctx.said(describeRequest(request), project);
    });
  }
}
