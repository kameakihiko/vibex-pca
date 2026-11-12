import { execFile } from 'node:child_process';
import { endsWithApp } from './programs';
import { findProgram } from './programs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { claudeBinary, installedServers } from './mcpServers';

// What Vibex needs on this computer, as macOS Vibex's Setup window (Setup/SetupModel.swift) has it, for the tools of
// this edition: git, ssh, Node where something needs it, and Claude Code. A check only reads. Nothing is installed
// until the person presses a button, and the install runs in the command terminal where they can watch it.

export type SetupId = 'git' | 'ssh' | 'node' | 'claude';
export type SetupStatus = 'ready' | 'needed' | 'optional';

export interface SetupItem {
  id: SetupId;
  title: string;
  /// What it is for, one line.
  why: string;
  status: SetupStatus;
  /// The version it reported, when it is there.
  version?: string;
  /// A plain next step when it is not ready.
  next?: string;
  /// What the button does: open a download page, or run the installer in the command terminal.
  action?: { label: string; kind: 'open' | 'install'; url?: string };
}

/// Runs a program and gives back its first line of output, or null when it is not there. Both streams are read,
/// because `ssh -V` writes its version to stderr.
export type Probe = (file: string, args: string[]) => Promise<string | null>;

export const probe: Probe = (file, args) => new Promise((resolve) => {
  endsWithApp(execFile(file, args, { timeout: 8000, windowsHide: true }, (error, stdout, stderr) => {
    const text = `${stdout}${stderr}`.trim().split(/\r?\n/)[0];
    // A program that is not there fails to start; one that starts but exits with an error is there.
    resolve(error && ((error as any).code === 'ENOENT' || (error as any).code === 'EACCES') ? null : text || 'found');
  }));
});

const PAGES = {
  // On Windows not git-scm.com: the office network of the owner resets its TLS.
  git: process.platform === 'win32' ? 'https://github.com/git-for-windows/git/releases/latest' : 'https://git-scm.com/downloads',
  node: 'https://nodejs.org/en/download',
};

const NEXT: Record<'git' | 'ssh', Record<string, string>> = {
  git: {
    win32: 'Install Git for Windows, then click the round arrow above. If it still shows Not found, close Vibex PCA and open it again.',
    darwin: 'Install the command line tools: run "xcode-select --install" in a terminal, then press Check again.',
    linux: 'Install it with your package manager, for example "sudo apt install git", then press Check again.',
  },
  ssh: {
    win32: 'Turn on the OpenSSH Client: Settings, Apps, Optional features, Add a feature. Then click the round arrow above. If it still shows Not found, close Vibex PCA and open it again.',
    darwin: 'ssh comes with macOS. If it is missing, install the command line tools: "xcode-select --install".',
    linux: 'Install it with your package manager, for example "sudo apt install openssh-client", then press Check again.',
  },
};

const next = (kind: 'git' | 'ssh') => NEXT[kind][process.platform] ?? NEXT[kind].linux;

/// The command that installs Claude Code with Anthropic's own installer (no Node, no administrator right needed).
/// It is a fixed text of this app; no page or file can change it.
export function claudeInstallCommand(): string {
  return process.platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash';
}

/// True when the project or a server Claude uses here needs Node.
export function nodeNeeded(project: string): boolean {
  if (existsSync(path.join(project, 'package.json'))) return true;
  return installedServers(project).some((s) => /^(npx|node|npm|pnpm|yarn|bunx?)(\s|$)/.test(s.detail));
}

export async function runChecks(project: string, run: Probe = probe, claude: () => string | null = claudeBinary): Promise<SetupItem[]> {
  const look = async (name: string, args: string[]) => {
    const file = findProgram(name);
    return file ? run(file, args) : null;
  };
  const [git, ssh, node] = await Promise.all([look('git', ['--version']), look('ssh', ['-V']), look('node', ['--version'])]);
  const claudeFile = claude();
  const claudeVersion = claudeFile ? await run(claudeFile, ['--version']) : null;
  const needsNode = nodeNeeded(project);
  return [
    {
      id: 'git', title: 'Git', why: 'Shows what Claude changed, and saves your work in a project.',
      status: git ? 'ready' : 'needed', version: git ?? undefined,
      ...(git ? {} : { next: next('git'), action: { label: 'Open download page', kind: 'open' as const, url: PAGES.git } }),
    },
    {
      id: 'ssh', title: 'SSH', why: 'Opens projects and terminals on a server.',
      status: ssh ? 'ready' : 'needed', version: ssh ?? undefined,
      ...(ssh ? {} : { next: next('ssh') }),
    },
    {
      id: 'node', title: 'Node.js', why: needsNode ? 'This project or a server Claude uses here starts with Node.' : 'Only some projects and servers start with Node. This one does not need it now.',
      status: node ? 'ready' : needsNode ? 'needed' : 'optional', version: node ?? undefined,
      ...(node ? {} : { next: 'Install Node.js (the LTS version), then click the round arrow above.', action: { label: 'Open download page', kind: 'open' as const, url: PAGES.node } }),
    },
    {
      id: 'claude', title: 'Claude Code', why: 'The assistant in the left column.',
      status: claudeVersion ? 'ready' : 'needed', version: claudeVersion ?? undefined,
      ...(claudeVersion ? {} : { next: 'Click Install Claude Code. The installer runs in the command terminal, where you can watch it. When it stops, click the round arrow above. A new Claude tab opens on the left, and you sign in there.', action: { label: 'Install Claude Code', kind: 'install' as const } }),
    },
  ];
}

/// The download pages that a button may open. The renderer sends an item id, never an address.
export function pageFor(id: string): string | null {
  return (PAGES as Record<string, string>)[id] ?? null;
}
