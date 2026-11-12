import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ServerProfile } from './servers';

export type SecretKind = 'password' | 'passphrase';

/// Electron safeStorage in the app; a stand-in in the tests, so they never touch a real system store.
export interface Crypt {
  available: () => boolean;
  encrypt: (text: string) => Buffer;
  decrypt: (data: Buffer) => string;
}

const loginOf = (p: ServerProfile) => `${p.user}@${p.host}:${p.port ?? 22}`;

/// Saved passwords and key passphrases: one file, each value encrypted by the system store, 0600. Each value keeps the
/// login it was saved for, so an entry that later names another host or user does not get it. A file that cannot be
/// read answers nothing and is never overwritten.
export class SecretStore {
  private entries: Record<string, { login: string; data: string }> = {};
  private unreadable = false;

  constructor(private readonly file: string, private readonly crypt: Crypt) {
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
      this.entries = raw;
    } catch {
      this.unreadable = true;
    }
  }

  available(): boolean {
    return this.crypt.available();
  }

  get(p: ServerProfile, kind: SecretKind): string | null {
    const entry = this.entries[`${p.name}|${kind}`];
    if (!entry || entry.login !== loginOf(p) || !this.available()) return null;
    try {
      return this.crypt.decrypt(Buffer.from(entry.data, 'base64'));
    } catch {
      return null; // Another user or a reset store: the person types it again.
    }
  }

  /// Whether a value is saved for this login. It decrypts nothing: a read of the value passes the presence gate
  /// (savedSecretGate.ts), and this answer does not. A value that later fails to decrypt reads as none in `get`.
  has(p: ServerProfile, kind: SecretKind): boolean {
    const entry = this.entries[`${p.name}|${kind}`];
    return !!entry && entry.login === loginOf(p) && this.available();
  }

  set(p: ServerProfile, kind: SecretKind, value: string): void {
    if (!this.available()) throw new Error('This computer has no system store that encrypts, so the app does not save secrets. It asks each time.');
    if (this.unreadable) throw new Error('server-secrets.json cannot be read, so the app does not change it.');
    this.entries[`${p.name}|${kind}`] = { login: loginOf(p), data: this.crypt.encrypt(value).toString('base64') };
    this.write();
  }

  forget(p: ServerProfile): void {
    if (this.unreadable) throw new Error('server-secrets.json cannot be read, so the app does not change it.');
    delete this.entries[`${p.name}|password`];
    delete this.entries[`${p.name}|passphrase`];
    this.write();
  }

  /// A new name for the same login. A changed host, port or user drops the secrets (`get` refuses them already).
  rename(from: ServerProfile, to: ServerProfile): void {
    if (this.unreadable) return;
    for (const kind of ['password', 'passphrase'] as const) {
      const entry = this.entries[`${from.name}|${kind}`];
      if (!entry) continue;
      delete this.entries[`${from.name}|${kind}`];
      if (loginOf(from) === loginOf(to)) this.entries[`${to.name}|${kind}`] = { login: loginOf(to), data: entry.data };
    }
    this.write();
  }

  private write(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.entries, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
