import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectInfo } from '../src/main/projects';
import { ServerTokens, projectOfToken } from '../src/main/serverTokens';
import type { Crypt } from '../src/main/serverSecrets';
import { savedProfile, updateProfiles } from '../src/main/servers';

// No app window: the token store with a stand-in for the system store, and the servers.json guard.

const crypt = (available = true): Crypt => ({
  available: () => available,
  encrypt: (text) => Buffer.from(`enc:${text.split('').reverse().join('')}`),
  decrypt: (data) => {
    const s = data.toString();
    if (!s.startsWith('enc:')) throw new Error('bad data');
    return s.slice(4).split('').reverse().join('');
  },
});

let dir = '';
test.beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'vibex-token-'));
});
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

const info = (id: string) => ({ id }) as ProjectInfo;

test.describe('server tokens survive a restart', () => {
  test('a second store on the same file returns the same token', () => {
    const file = path.join(dir, 'server-tokens.json');
    const first = new ServerTokens(file, crypt()).tokenFor('p1');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const again = new ServerTokens(file, crypt());
    expect(again.tokenFor('p1')).toBe(first);
    expect(again.tokenFor('p2')).not.toBe(first);
    expect(readFileSync(file, 'utf8')).not.toContain(first); // stored encrypted
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('a token resolves only while its project is open, and the same token again after reopening', () => {
    const store = new ServerTokens(path.join(dir, 't.json'), crypt());
    const t1 = store.tokenFor('p1');
    const t2 = store.tokenFor('p2');
    let open = new Set(['p1', 'p2']);
    const get = (id: string) => (open.has(id) ? info(id) : null);
    expect(projectOfToken(store, t1, get)?.id).toBe('p1');
    expect(projectOfToken(store, t2, get)?.id).toBe('p2');
    expect(projectOfToken(store, 'x'.repeat(64), get)).toBeNull();
    expect(projectOfToken(store, '', get)).toBeNull();
    open = new Set(['p2']); // p1 closed: the store is not told to forget
    expect(projectOfToken(store, t1, get)).toBeNull();
    expect(projectOfToken(store, t2, get)?.id).toBe('p2');
    open = new Set(['p1', 'p2']);
    expect(store.tokenFor('p1')).toBe(t1);
    expect(projectOfToken(store, t1, get)?.id).toBe('p1');
  });

  test('after a restart a stored token resolves before any tab asks for it, only while open', () => {
    const file = path.join(dir, 't.json');
    const t1 = new ServerTokens(file, crypt()).tokenFor('p1');
    const restarted = new ServerTokens(file, crypt());
    expect(projectOfToken(restarted, t1, (id) => (id === 'p1' ? info(id) : null))?.id).toBe('p1');
    expect(projectOfToken(restarted, t1, () => null)).toBeNull();
  });

  test('with no system store no file is written, and a token lives in memory', () => {
    const file = path.join(dir, 't.json');
    const store = new ServerTokens(file, crypt(false));
    const t = store.tokenFor('p1');
    expect(store.tokenFor('p1')).toBe(t);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect(projectOfToken(store, t, info)?.id).toBe('p1');
  });

  test('a corrupt file does not crash and is not overwritten', () => {
    const file = path.join(dir, 't.json');
    writeFileSync(file, '{ not json');
    const store = new ServerTokens(file, crypt());
    const t = store.tokenFor('p1');
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(store.tokenFor('p1')).toBe(t);
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
    writeFileSync(file, '[1,2]'); // valid JSON, wrong shape
    expect(() => new ServerTokens(file, crypt()).tokenFor('p1')).not.toThrow();
    expect(readFileSync(file, 'utf8')).toBe('[1,2]');
  });

  test('a decrypt that fails once leaves the stored entry byte-identical; a later store gets the ORIGINAL token', () => {
    const file = path.join(dir, 't.json');
    const a = new ServerTokens(file, crypt());
    const t1 = a.tokenFor('p1');
    const t2 = a.tokenFor('p2');
    const before = readFileSync(file, 'utf8');
    let fail = true;
    const flaky: Crypt = { ...crypt(), decrypt: (d) => { if (fail) throw new Error('keychain busy'); return crypt().decrypt(d); } };
    const b = new ServerTokens(file, flaky);
    const temp = b.tokenFor('p1'); // memory-only token for this run
    expect(temp).not.toBe(t1);
    expect(b.tokenFor('p1')).toBe(temp);
    b.tokenFor('p3'); // a later write must keep p1 and p2 as they were
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.p1).toBe(JSON.parse(before).p1);
    expect(after.p2).toBe(JSON.parse(before).p2);
    fail = false;
    const c = new ServerTokens(file, crypt());
    expect(c.tokenFor('p1')).toBe(t1);
    expect(c.tokenFor('p2')).toBe(t2);
  });

  test('an empty decrypted value is not taken as a token and does not replace the entry', () => {
    const file = path.join(dir, 't.json');
    const t1 = new ServerTokens(file, crypt()).tokenFor('p1');
    const before = readFileSync(file, 'utf8');
    const empty: Crypt = { ...crypt(), decrypt: () => '' };
    const s = new ServerTokens(file, empty);
    expect(s.tokenFor('p1')).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(new ServerTokens(file, crypt()).tokenFor('p1')).toBe(t1);
  });

  test('many lookups decrypt each entry at most once', () => {
    const file = path.join(dir, 't.json');
    const a = new ServerTokens(file, crypt());
    const ts = ['p1', 'p2', 'p3'].map((id) => a.tokenFor(id));
    let calls = 0;
    const counting: Crypt = { ...crypt(), decrypt: (d) => { calls++; return crypt().decrypt(d); } };
    const b = new ServerTokens(file, counting);
    for (let i = 0; i < 20; i++) for (const t of ts) projectOfToken(b, t, info);
    projectOfToken(b, 'nope', info);
    expect(b.tokenFor('p1')).toBe(ts[0]);
    expect(calls).toBeLessThanOrEqual(3);
  });

  test('a stale .tmp file with a wide mode ends up private', () => {
    if (process.platform === 'win32') return;
    const file = path.join(dir, 't.json');
    writeFileSync(`${file}.tmp`, 'old', { mode: 0o644 });
    new ServerTokens(file, crypt()).tokenFor('p1');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});

test.describe('the hub keeps the stored token', () => {
  const src = readFileSync(path.join(__dirname, '../src/main/serverHub.ts'), 'utf8');
  const body = (name: string) => {
    const at = src.indexOf(`  ${name}(`);
    return src.slice(at, src.indexOf('\n  }\n', at));
  };
  test('projectClosed does not touch the token store', () => {
    const closed = body('projectClosed');
    expect(closed.length).toBeGreaterThan(50);
    expect(closed).not.toMatch(/tokens/);
  });
  test('projectOfToken still requires an open project', () => {
    const of = body('projectOfToken');
    expect(of).toContain('this.d.projects.get(id)');
    expect(of).toContain('projectOfToken(this.tokens');
  });
});

test.describe('servers.json entry with no id (Swift #58 guard)', () => {
  test('saving a profile keeps the unknown keys of its entry and of the others', () => {
    const file = path.join(dir, 'servers.json');
    const list = [
      { name: 'one', host: 'h1', user: 'u', note: 'keep me', options: { a: 1 }, extraList: [1, 2] },
      { name: 'two', host: 'h2', user: 'u', futureKey: true },
    ];
    writeFileSync(file, JSON.stringify(list));
    updateProfiles(file, (l) => savedProfile(l, { name: 'one', host: 'h9', user: 'u', port: 2222 }, 'one'));
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after[0]).toEqual({ name: 'one', host: 'h9', user: 'u', port: 2222, note: 'keep me', options: { a: 1 }, extraList: [1, 2] });
    expect(after[1]).toEqual(list[1]);
    expect(after).toHaveLength(2);
  });
});
