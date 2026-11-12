import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Crypt } from './serverSecrets';

/// The Claude token of each server project, one per project id. It is kept in one file under userData, each value
/// encrypted by the system store (0600), so a Claude job still running on the server keeps its token after the app
/// restarts. If the system store does not encrypt, tokens live in memory for this run and no file is written.
/// A file that cannot be read (not JSON, or not an object) is left exactly as it is, never overwritten: the store
/// then works in memory for this run. A stored entry that cannot be decrypted is never replaced or dropped: the project gets a memory-only token for this run.
export class ServerTokens {
  /// The stored ciphertext as read, base64. An entry is never dropped or changed unless this run made it.
  private raw: Record<string, string> = {};
  /// Tokens known this run: decrypted once, or made now. A project whose stored entry would not decrypt gets a
  /// memory-only token here, and its stored entry stays as it is.
  private known = new Map<string, string>();
  /// Ids whose stored entry was tried, so each entry is decrypted at most once per run.
  private tried = new Set<string>();
  private unreadable = false;

  constructor(private readonly file: string, private readonly crypt: Crypt) {
    if (!crypt.available() || !existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      for (const [id, data] of Object.entries(parsed)) if (typeof data === 'string') this.raw[id] = data;
    } catch {
      this.unreadable = true;
    }
  }

  private persists(): boolean {
    return this.crypt.available() && !this.unreadable;
  }

  /// Decrypts the stored entry of `id` once. Null if there is none or it cannot be read; a failure never changes it.
  private load(id: string): string | null {
    const known = this.known.get(id);
    if (known) return known;
    if (!this.persists() || this.tried.has(id) || this.raw[id] === undefined) return null;
    this.tried.add(id);
    try {
      const token = this.crypt.decrypt(Buffer.from(this.raw[id], 'base64'));
      if (!token) return null; // An empty value is no token.
      this.known.set(id, token);
      return token;
    } catch {
      return null; // A busy or reset system store: the stored entry stays for a later run.
    }
  }

  tokenFor(projectId: string): string {
    const known = this.load(projectId);
    if (known) return known;
    const token = randomBytes(32).toString('hex');
    this.known.set(projectId, token);
    // A stored entry that could not be read is kept: this run uses a memory-only token for the project.
    if (this.persists() && this.raw[projectId] === undefined) {
      try {
        this.raw[projectId] = this.crypt.encrypt(token).toString('base64');
        this.write();
      } catch {
        delete this.raw[projectId]; // Cannot write: the token still works for this run.
      }
    }
    return token;
  }

  /// Every token, stored or new, for the compare. After a restart a job holds an old token before any tab asks for it,
  /// so the stored ones count too. Each stored entry is decrypted once per run.
  entries(): [string, string][] {
    for (const id of Object.keys(this.raw)) this.load(id);
    return [...this.known];
  }

  private write(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    rmSync(temp, { force: true }); // A stale file keeps its old mode.
    writeFileSync(temp, JSON.stringify(this.raw, null, 2), { mode: 0o600 });
    try {
      renameSync(temp, this.file);
    } catch {
      // On Windows an antivirus or the indexer often holds the file for a moment.
      renameSync(temp, this.file);
    }
  }
}

/// The open project of a token, by a constant-time compare over all tokens. A closed project's token stays stored but
/// does not resolve: `get` answers null for it.
export function projectOfToken<T>(store: ServerTokens, token: string, get: (id: string) => T | null): T | null {
  const hash = (text: string) => createHash('sha256').update(text).digest();
  const given = hash(token);
  for (const [id, value] of store.entries()) {
    if (timingSafeEqual(given, hash(value))) return get(id);
  }
  return null;
}
