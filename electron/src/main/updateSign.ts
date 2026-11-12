import { createPublicKey, verify } from 'node:crypto';
import { load } from 'js-yaml';
import type { UpdateEngine } from './updateFlow';

// Signed updates (security review N1). An Ed25519 signature over the exact bytes of latest*.yml, which holds the installer's
// SHA-512. The app checks it before the library reads the feed, and again that the library took what was signed, so
// whoever can write the feed folder cannot make a PC run their installer. publish-update.sh signs; the key stays off the repo.

/// The public half of the owner's release key: base64 of the 32 raw bytes. The private half stays on his Mac, and only his
/// run of scripts/release.sh reads it. A test key reaches only a proof build (./updater.ts); a release has no way to take one.
export const PINNED_UPDATE_PUBLIC_KEY = '0kgKWEIBvSGf8ZH5ZDsSX6SNeC76zhnpBzejfJC2QI0=';

/// What comes before the 32 raw bytes in the standard form of an Ed25519 public key.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class FeedRefused extends Error {
  constructor() {
    super('The update feed has no valid signature, so nothing was downloaded. Tell the person who installed Vibex PCA.');
    this.name = 'FeedRefused';
  }
}

export function verifyFeedSignature(yml: Buffer, signature: string | null, publicKey: string): boolean {
  const text = signature?.trim() ?? '';
  if (!/^[A-Za-z0-9+/]{86}==$/.test(text)) return false;
  const raw = Buffer.from(publicKey, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== publicKey) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    return verify(null, yml, key, Buffer.from(text, 'base64'));
  } catch {
    return false;
  }
}

/// The same value with its keys in one order, so two readings of one yml compare equal.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/// The library read the feed a second time. The whole of what it took must equal what was signed: version, file, SHA-512, admin rights.
export function sameRelease(signedYml: Buffer, info: unknown): boolean {
  try {
    return JSON.stringify(canonical(load(signedYml.toString('utf8')))) === JSON.stringify(canonical(info));
  } catch {
    return false;
  }
}

/// The yml the library asks for on this system (its getChannelFilePrefix, channel "latest").
export function feedFileName(platform: string, arch: string): string {
  if (platform !== 'linux') return 'latest.yml';
  return arch === 'x64' ? 'latest-linux.yml' : `latest-linux-${arch}.yml`;
}

export interface SignedEngineParts {
  publicKey: string;
  fileName: string;
  /// A file of the feed, or null when the feed does not have it. A network failure rejects.
  fetchFile: (name: string) => Promise<Buffer | null>;
  /// The library's own check: it reads the feed itself, and keeps what it read for the download.
  check: () => Promise<{ available: boolean; info: unknown } | null>;
  download: (onPercent: (percent: number) => void) => Promise<void>;
  /// How long to wait before the second read of a refused pair. Left out: 2 seconds.
  retryMs?: number;
}

/// The engine that auto-update runs on. Nothing reaches the library before the signature passes.
export function signedEngine(o: SignedEngineParts): UpdateEngine {
  let cleared = false;
  return {
    latest: async () => {
      cleared = false;
      // A publish swaps the yml and its signature by two renames, a moment apart, and this makes two reads: a mismatch can be
      // a read in between. So it reads once more. A real refusal stays a refusal, and nothing downloaded.
      for (let attempt = 1; ; attempt++) {
        const yml = await o.fetchFile(o.fileName);
        if (!yml) throw new Error('the feed has no release yet');
        const signature = await o.fetchFile(`${o.fileName}.sig`);
        const good = verifyFeedSignature(yml, signature?.toString('utf8') ?? null, o.publicKey);
        const found = good ? await o.check() : null;
        if (good && !found) return null;
        if (good && sameRelease(yml, found!.info)) {
          cleared = true;
          return found!.available ? (found!.info as { version: string }).version : null;
        }
        if (attempt === 2) throw new FeedRefused();
        await new Promise((resolve) => setTimeout(resolve, o.retryMs ?? 2000));
      }
    },
    download: async (onPercent) => {
      if (!cleared) throw new FeedRefused();
      await o.download(onPercent);
    },
  };
}
