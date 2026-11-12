import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import net from 'node:net';

// The rule that Claude on a server never reads or reaches a page of this computer or the LAN: what counts as such an
// address, and who is asking. BrowserPane applies it; the tools only pass through it.

function expandIPv6(text: string): number[] | null {
  const bare = text.split('%')[0];
  if (!net.isIPv6(bare)) return null;
  const [head, tail] = bare.split('::');
  const part = (t?: string) => (t ? t.split(':').flatMap((g) => {
    if (g.includes('.')) {
      const b = g.split('.').map(Number);
      return [(b[0] << 8) | b[1], (b[2] << 8) | b[3]];
    }
    return [parseInt(g, 16)];
  }) : []);
  const a = part(head);
  const b = part(tail);
  return bare.includes('::') ? [...a, ...Array(8 - a.length - b.length).fill(0), ...b] : a;
}

function isPublicIPv6(text: string): boolean {
  const g = expandIPv6(text);
  if (!g) return false;
  // Loopback, unspecified, IPv4-mapped and -compatible: the first 80 bits are zero.
  if (g.slice(0, 5).every((x) => x === 0)) return false;
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return false;
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xff00) === 0xff00) return false;
  if (g[0] === 0x0064 && g[1] === 0xff9b) return false;
  // 6to4 and Teredo carry an IPv4 address inside, which may be a private one.
  if (g[0] === 0x2002 || (g[0] === 0x2001 && g[1] === 0)) return false;
  return true;
}

function isPublicIPv4(text: string): boolean {
  const [a, b, c] = text.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if ((a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)) return false;
  if ((a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19))) return false;
  return true;
}

/// A resolved address on this computer or the LAN. What cannot be read as an address counts as one.
export function isPrivateAddress(ip: string): boolean {
  const text = ip.trim().replace(/^\[|\]$/g, '');
  if (net.isIPv4(text)) return !isPublicIPv4(text);
  return !isPublicIPv6(text);
}

/// A page Claude on a server may open, judged by its text: the internet, about:blank, and this project's forwards on
/// 127.0.0.1. Never this computer's other services, its files or the LAN.
export function serverMayOpen(raw: string, forwards: number[]): boolean {
  if (raw === 'about:blank') return true;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const scheme = url.protocol.slice(0, -1);
  if (scheme !== 'http' && scheme !== 'https') return false;
  // A user name before the host only hides the host from a person and from a text rule.
  if (url.username || url.password) return false;
  // The host as written: no percent escapes or other spellings for the browser to decode.
  const written = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]*)/i.exec(raw)?.[1]?.toLowerCase() ?? '';
  if (!written || !/^[a-z0-9.\-:[\]]+$/.test(written)) return false;
  const host = url.hostname.toLowerCase();
  const port = url.port ? Number(url.port) : scheme === 'https' ? 443 : 80;
  if (host === '127.0.0.1' && written === '127.0.0.1') return forwards.includes(port);
  let bare = host.replace(/^\[|\]$/g, '');
  while (bare.endsWith('.')) bare = bare.slice(0, -1);
  if (bare.includes(':')) return isPublicIPv6(bare);
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local') || bare.endsWith('.lan') || bare.endsWith('.internal') || !bare.includes('.')) return false;
  if (net.isIPv4(bare)) {
    // Another spelling of an address (2130706433, 0x7f.1, 127.1) reads as an address only after the parser.
    if (written.replace(/\.+$/, '') !== bare) return false;
    return isPublicIPv4(bare);
  }
  return true;
}

export type Resolver = (host: string) => Promise<string[]>;

const httpForm = (raw: string) => raw.replace(/^ws(s?):/i, 'http$1:');

/// `true` when the address is the project's own forward: the one loopback address the rule lets through.
export function isForward(raw: string, forwards: number[]): boolean {
  const text = httpForm(raw);
  try {
    // The parsed host: in `http://127.0.0.1:41000@name/` the text starts as a forward, and the host is `name`.
    return new URL(text).hostname === '127.0.0.1' && serverMayOpen(text, forwards);
  } catch {
    return false;
  }
}

/// The text rule, then the address a name resolves to: a public name can point at this computer. Every answer counts,
/// because the network code may take any of them; no answer proves nothing, so it is a refusal.
export async function addressAllowed(raw: string, forwards: number[], resolve: Resolver): Promise<boolean> {
  const text = httpForm(raw);
  if (!serverMayOpen(text, forwards) || text === 'about:blank') return text === 'about:blank';
  const host = new URL(text).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (net.isIP(host)) return true;
  try {
    const answers = await resolve(host);
    return answers.length > 0 && answers.every((ip) => !isPrivateAddress(ip));
  } catch {
    return false;
  }
}

/// Each server project has its own logins, so Claude on one server cannot use those of another, or those of the person's
/// local projects. Local projects share one partition.
export function partitionFor(projectId: string, onServer: boolean): string {
  if (!onServer) return 'persist:vibex-browser';
  return `persist:vibex-server-${createHash('sha256').update(projectId).digest('hex').slice(0, 24)}`;
}

const caller = new AsyncLocalStorage<true>();

/// Runs a tool call of a server token. All code it awaits sees isServerCaller(), so no tool can forget the rule.
export function asServerCaller<T>(work: () => T): T {
  return caller.run(true, work);
}

export function isServerCaller(): boolean {
  return caller.getStore() === true;
}
