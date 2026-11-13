import { app, safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { testEnv } from './testSwitches';

export type TokenStore = 'os-store' | 'memory';

/// True when safeStorage really encrypts: DPAPI on Windows, Keychain on macOS, libsecret or KWallet on Linux.
/// Linux 'basic_text' uses a fixed key, which is plain text in practice, so it does not count.
export function osStoreAvailable(): boolean {
  if (testEnv('VIBEX_TOKEN_STORE') === 'memory') return false;
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend();
    return backend !== 'basic_text' && backend !== 'unknown';
  }
  return true;
}

/// The MCP bearer token. It is kept only encrypted by the OS store; if there is no store,
/// a new token lives in memory for this run and nothing is written to disk.
export function loadMcpToken(): { token: string; store: TokenStore } {
  if (!osStoreAvailable()) return { token: randomBytes(32).toString('base64url'), store: 'memory' };
  const file = path.join(app.getPath('userData'), 'mcp-token.bin');
  if (existsSync(file)) {
    try {
      return { token: safeStorage.decryptString(readFileSync(file)), store: 'os-store' };
    } catch {
      // Unreadable (another user or a reset store): replace it below.
    }
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(file, safeStorage.encryptString(token), { mode: 0o600 });
  return { token, store: 'os-store' };
}

/// The stored key without creating one: for `--mcp-headers`, which Claude Code runs to get the header.
export function readStoredToken(): string | null {
  // PROOF ONLY, not for main: why no key came back, on stderr.
  const why = (text: string) => { try { process.stderr.write(`VIBEX-KEY-WHY ${text}; userData=${app.getPath('userData')}; localState=${existsSync(path.join(app.getPath('userData'), 'Local State'))}\n`); } catch { /* no stderr */ } };
  if (!osStoreAvailable()) { why(`store not available (isEncryptionAvailable=${safeStorage.isEncryptionAvailable()})`); return null; }
  const file = path.join(app.getPath('userData'), 'mcp-token.bin');
  if (!existsSync(file)) { why('no token file'); return null; }
  try {
    return safeStorage.decryptString(readFileSync(file));
  } catch (error) {
    why(`decrypt failed: ${String(error).slice(0, 200)}`);
    return null;
  }
}
