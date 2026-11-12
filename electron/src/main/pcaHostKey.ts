import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SITE } from './site';

// The PCA server's host key ships with the app (security review N7), so the first connection on a hostile network cannot be
// answered by another machine, and no person has to compare a fingerprint. A changed key stops the connection. If the
// server gets a new key, a new app version must carry it. No other server is touched. The address and the key come from
// the site values (./site.ts): made up in the repository, real in a release build.

export const PCA_HOST = SITE.host;
export const PCA_HOST_KEY_LINE = `${PCA_HOST} ${SITE.hostKey}`;
export const PCA_HOST_KEY_FINGERPRINT = SITE.hostKeyFingerprint;

let folder: string | null = null;

/// For a test with no app. In the app the file sits in the profile folder.
export function setHostKeyFolder(dir: string): void {
  folder = dir;
}

export const isPinnedHost = (host: string, port?: number) => host === PCA_HOST && (port ?? 22) === 22;

/// The -o options that pin the key. ssh keeps the first value it reads, so they go before any other option: the person's
/// config and the profile's own options cannot widen them. The address is the alias, so a Host block cannot rename it.
export function pinnedHostOptions(file: string): string[] {
  // ssh reads the value as words, and expands %. On Windows it takes forward slashes, with no backslash to read as an escape.
  const value = file.replace(/\\/g, '/').replace(/%/g, '%%');
  return [
    '-o', /\s/.test(value) ? `UserKnownHostsFile="${value}"` : `UserKnownHostsFile=${value}`,
    '-o', 'GlobalKnownHostsFile=none',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UpdateHostKeys=no',
    '-o', `HostKeyAlias=${PCA_HOST}`,
  ];
}

/// The options for the PCA address, with the key's file written first. The file holds only the line above.
export function pinnedHostArgs(): string[] {
  const dir = folder ?? app.getPath('userData');
  const file = path.join(dir, 'pca_known_hosts');
  let now = '';
  try {
    now = readFileSync(file, 'utf8');
  } catch {
    // Not there yet.
  }
  if (now !== `${PCA_HOST_KEY_LINE}\n`) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${PCA_HOST_KEY_LINE}\n`);
  }
  return pinnedHostOptions(file);
}

/// Plain words when ssh refused the key, or null for any other failure.
export function hostKeyFailureText(name: string, sshOutput: string): string | null {
  if (!/host key verification failed/i.test(sshOutput)) return null;
  return `${name} answered with a different host key from the one this app trusts, so Vibex PCA did not connect and sent no password. Another machine may be answering on this network, or the server has a new key. Tell the person who manages the server.`;
}

/// True for the options above, in a command that is about to run.
export const isPinnedLaunch = (args: string[]) => args.includes(`HostKeyAlias=${PCA_HOST}`);

/// What to do with a question from ssh that names the PCA address (a jump through it has no pinned file): `match`, `changed`
/// or, for another address, null. Text with no fingerprint of this key counts as changed.
export function hostKeyVerdict(prompt: string): 'match' | 'changed' | null {
  // The address as a whole word, as ssh writes it for port 22. The same digits after a 1 are another server, [address]:2222 is another
  // port with its own key, and "name (address)" is another name: the pin is for the bare address alone.
  if (!new RegExp(`(^|[^0-9.[(])${PCA_HOST.replace(/\./g, '\\.')}($|[^0-9.\\]:])`).test(prompt)) return null;
  return prompt.includes(`${PCA_HOST_KEY_FINGERPRINT}.`) || prompt.endsWith(PCA_HOST_KEY_FINGERPRINT) ? 'match' : 'changed';
}
