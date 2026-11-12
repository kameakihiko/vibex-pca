import { app, dialog, shell } from 'electron';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModuleHost, VibexModule } from './modules';
import { PCA_HOST } from './pcaHostKey';
import { programPath } from './programs';
import { SITE } from './site';
import { claudeDir, validSkillName } from './skills';

// The PCA edition: a server offer, a pack of skills, and a sample of Claude Code managed settings. Each one waits for a
// click. Nothing in this file writes to a person's Claude settings, and nothing installs the managed settings (that needs
// an administrator). The Inbox is another matter: ./inbox.ts adds its hooks to Claude's settings.json at start, with no
// question, unless the person turned them off there (README, "Agents, Go and Inbox"). The files that ship live in
// electron/pca/ and are copied beside the app by electron-builder.

/// The prefilled profile. All people log in with one name (./site.ts) and their own key; the folder they open says who they are. No key,
/// folder or password is shipped. Its host key is pinned (./pcaHostKey.ts).
export const PCA_PROFILE = { name: 'PCA', host: PCA_HOST, port: 22, user: SITE.user, authentication: 'key', allowClaude: true, confirmCommands: true } as const;

/// The person's key on the team server. The owner gives it; nothing guesses it from a name.
const PERSON_KEY = /^[a-z][a-z0-9-]{1,30}$/;
export const validPersonKey = (key: unknown): key is string => typeof key === 'string' && PERSON_KEY.test(key);

/// The folder of a person on the team server.
export function personFolder(key: string): string {
  if (!validPersonKey(key)) throw new Error('Enter the key name that the owner gave you: small letters, digits and dashes.');
  return `/srv/pca/people/${key}`;
}

export interface LoginKey {
  file: string;
  /// The one line the person copies to the owner: the public half.
  line: string;
}

/// The pair of a chosen file, by either of its two names. Only the .pub file is read: the private file stays unread, and on this PC.
export function pickedKey(chosen: string): LoginKey {
  const file = chosen.endsWith('.pub') ? chosen.slice(0, -4) : chosen;
  if (!existsSync(file)) throw new Error('That key has no private file beside it, so it cannot log in from this computer.');
  if (!existsSync(`${file}.pub`)) throw new Error('That key has no .pub file beside it. Choose a key with both files, or make a new one.');
  const lines = readFileSync(`${file}.pub`, 'utf8').trim().split(/\r?\n/);
  if (lines.length !== 1) throw new Error('The .pub file must hold one line.');
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$/.test(lines[0])) throw new Error('This is not an ed25519 key. The PCA server takes ed25519 keys.');
  return { file, line: lines[0] };
}

/// Makes the login key, with no passphrase: a login key only. It creates the .ssh folder, which a new PC does not have (ssh-keygen
/// then fails with "Saving key ... failed: No such file or directory"). A key that is there is never replaced.
export async function makeLoginKey(home: string, personKey: string): Promise<LoginKey> {
  personFolder(personKey);
  const file = path.join(home, '.ssh', 'pca_ed25519');
  // A second make while one runs is the same action: a second ssh-keygen would stop at its overwrite question.
  let running = makingKeys.get(file);
  if (!running) {
    running = makeOneKey(file, personKey).finally(() => makingKeys.delete(file));
    makingKeys.set(file, running);
  }
  return running;
}

const makingKeys = new Map<string, Promise<LoginKey>>();

async function makeOneKey(file: string, personKey: string): Promise<LoginKey> {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!existsSync(file) && !existsSync(`${file}.pub`)) {
    await new Promise<void>((resolve, reject) => {
      let keygen: string;
      try {
        keygen = programPath('ssh-keygen');
      } catch {
        reject(new Error('ssh-keygen is not on this computer. Install the OpenSSH client, then try again.'));
        return;
      }
      execFile(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', `pca-${personKey}`, '-f', file], { windowsHide: true, timeout: 30_000 }, (error, _out, stderr) => {
        if (!error) return resolve();
        // Only its own half-made files: a key that was there never reaches this call.
        for (const part of [file, `${file}.pub`]) rmSync(part, { force: true });
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error('ssh-keygen is not on this computer. Install the OpenSSH client, then try again.'));
        const said = String(stderr).trim().split(/\r?\n/).pop()?.slice(0, 200);
        reject(new Error(error.killed ? 'ssh-keygen did not finish in 30 seconds. Try again.' : `ssh-keygen could not make the key${said ? `: ${said}` : '.'}`));
      });
    });
  }
  return pickedKey(file);
}

/// The offer shows while no saved server is the PCA host. A servers.json that cannot be read, or is no list, is not ours to touch.
export function profileOffer(serversFile: string): typeof PCA_PROFILE | null {
  if (!existsSync(serversFile)) return PCA_PROFILE;
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(serversFile, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(saved)) return null;
  const holdsPca = saved.some((p) => typeof p?.host === 'string' && p.host.toLowerCase() === PCA_HOST.toLowerCase());
  return holdsPca ? null : PCA_PROFILE;
}

/// The folder with the shipped files: beside the app when installed, in the source tree in development.
export function pcaDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'pca') : path.join(__dirname, '..', 'pca');
}

/// Names of the skills in a pack: each is a folder with a SKILL.md.
export function listPack(pack: string): string[] {
  try {
    return readdirSync(pack, { withFileTypes: true })
      .filter((e) => e.isDirectory() && validSkillName(e.name) && existsSync(path.join(pack, e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/// Copies each skill that is not in `target` yet. A name that exists, also a link or a broken link, stays as it is.
export function installPack(pack: string, target: string): { installed: string[]; skipped: string[] } {
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const name of listPack(pack)) {
    const there = path.join(target, name);
    if (lstatSync(there, { throwIfNoEntry: false })) {
      skipped.push(name);
      continue;
    }
    mkdirSync(target, { recursive: true });
    cpSync(path.join(pack, name), there, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    installed.push(name);
  }
  return { installed, skipped };
}

/// Where Claude Code looks for the managed settings file on each system (an administrator writes there).
export function managedSettingsTarget(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

const skillsFolder = () => path.join(claudeDir(), 'skills');

function status() {
  const available = listPack(path.join(pcaDir(), 'skills'));
  const folder = skillsFolder();
  return {
    available,
    present: available.filter((n) => lstatSync(path.join(folder, n), { throwIfNoEntry: false })),
    target: managedSettingsTarget(process.platform),
  };
}

let userData = '';

export const pcaEditionModule: VibexModule = {
  name: 'pca-edition',
  start: (host: ModuleHost) => {
    userData = host.userData;
    host.handle('mod:pcaedition:offer', () => profileOffer(path.join(userData, 'servers.json')));
    host.handle('mod:pcaedition:status', () => status());
    host.handle('mod:pcaedition:make-key', (personKey: unknown) => {
      if (!validPersonKey(personKey)) throw new Error('Enter the key name that the owner gave you first: small letters, digits and dashes.');
      return makeLoginKey(os.homedir(), personKey);
    });
    host.handle('mod:pcaedition:pick-key', async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog({ title: 'Pick your ed25519 login key', defaultPath: path.join(os.homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'] });
      return canceled || !filePaths[0] ? null : pickedKey(filePaths[0]);
    });
    host.handle('mod:pcaedition:folder', (personKey: unknown) => (validPersonKey(personKey) ? personFolder(personKey) : ''));
    host.handle('mod:pcaedition:install-skills', () => {
      const result = installPack(path.join(pcaDir(), 'skills'), skillsFolder());
      return { ...result, ...status() };
    });
    host.handle('mod:pcaedition:show-sample', () => {
      const file = path.join(pcaDir(), 'managed-settings.json');
      if (!existsSync(file)) throw new Error('The sample file is not in this build.');
      shell.showItemInFolder(file);
    });
  },
};
