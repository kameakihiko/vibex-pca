import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeSlug, excludes, linksIn, loadConfig, NoteLibrary, refusal, Refusal, saveCopy, saveNote, tagsIn, words, writeAtomic, type NotesConfig, type NotesEnv } from '../src/main/notes';
import { report } from '../src/main/notesTools';
import { renderMarkdown } from '../src/renderer/notesMarkdown';
import { tempDir, firstWindow } from './fixtures';

// Notes: the files and their rules (pure, fast), the Markdown renderer, then the sidebar, the note tab and the MCP tool in the app.

const noLinks = { wiki: () => null, path: () => null };
const write = (file: string, text: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };

const made: string[] = [];
test.afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/// A made-up home with a project, its memory store, and a vault with a notes folder.
function world(prefix: string) {
  const root = realpathSync(tempDir(prefix));
  made.push(root);
  const home = path.join(root, 'home');
  const project = path.join(root, 'shop');
  const vault = path.join(root, 'vault');
  mkdirSync(home); mkdirSync(project); mkdirSync(vault);
  const env: NotesEnv = { home, claudeDir: path.join(home, '.claude'), settingsFile: path.join(root, 'notes.json') };
  return { root, home, project, vault, env };
}
const withFolder = (w: ReturnType<typeof world>, rel: string | null) => {
  writeFileSync(w.env.settingsFile, JSON.stringify({ vault: w.vault, folders: rel === null ? {} : { [w.project]: rel } }));
};

test.describe('the exclude list', () => {
  test('splits names into words and hides credential names', () => {
    expect(words('GitHubToken2')).toEqual(['git', 'hub', 'token', '2']);
    for (const name of ['passwords.md', 'API key.md', 'Parollar.md', 'ключи.md', 'sshkey.md', '2FA codes.md', 'secrets/a.md']) expect(excludes(name), name).toBe(true);
    for (const name of ['Keyboard shortcuts.md', 'monkey.md', 'plan.md', 'launch/ideas.md']) expect(excludes(name), name).toBe(false);
  });
  test('extra terms come from .vibex.json and add to the defaults', () => {
    expect(excludes('bank card.md', [words('bank card')])).toBe(true);
    expect(excludes('bank.md', [words('bank card')])).toBe(false);
  });
});

test.describe('config: where the notes live', () => {
  test('memory: the repo store first, else the Claude store, else none', () => {
    const w = world('notes-cfg-');
    withFolder(w, null);
    expect(loadConfig(w.project, w.env).memory).toBeNull();
    const store = path.join(w.env.claudeDir, 'projects', claudeSlug(w.project), 'memory');
    mkdirSync(store, { recursive: true });
    expect(loadConfig(w.project, w.env).memory).toBe(store);
    mkdirSync(path.join(w.project, '.claude', 'memory'), { recursive: true });
    expect(loadConfig(w.project, w.env).memory).toBe(path.join(w.project, '.claude', 'memory'));
  });
  test('a .vibex.json memory path outside the project and the Claude store is ignored', () => {
    const w = world('notes-cfg2-');
    withFolder(w, null);
    mkdirSync(path.join(w.root, 'elsewhere'));
    writeFileSync(path.join(w.project, '.vibex.json'), JSON.stringify({ memory: '../elsewhere' }));
    expect(loadConfig(w.project, w.env).memory).toBeNull();
  });
  test('the notes folder is only a suggestion until chosen; bad folders are refused', () => {
    const w = world('notes-cfg3-');
    mkdirSync(path.join(w.vault, 'Shop'));
    mkdirSync(path.join(w.vault, '.obsidian'));
    mkdirSync(path.join(w.vault, 'Claude Memory'));
    mkdirSync(path.join(w.vault, 'passwords'));
    writeFileSync(path.join(w.project, '.vibex.json'), JSON.stringify({ notes: 'Shop' }));
    withFolder(w, null);
    let c = loadConfig(w.project, w.env);
    expect(c.notes).toBeNull();
    expect(c.suggested).toBe('Shop');
    withFolder(w, 'Shop');
    c = loadConfig(w.project, w.env);
    expect(c.notes).toBe(path.join(w.vault, 'Shop'));
    expect(c.suggested).toBeNull();
    for (const bad of ['.obsidian', 'Claude Memory', 'passwords', '../outside', 'missing']) {
      withFolder(w, bad);
      expect(loadConfig(w.project, w.env).notes, bad).toBeNull();
    }
    withFolder(w, '');
    expect(loadConfig(w.project, w.env).suggested).toBeNull();
  });
});

test.describe('reading, links, tags and search', () => {
  test('a scan skips hidden files, links, big files and credential names; MEMORY.md comes first', async () => {
    const w = world('notes-scan-');
    const mem = path.join(w.project, '.claude', 'memory');
    write(path.join(mem, 'zeta.md'), 'Zeta fact #area/ops\n');
    write(path.join(mem, 'MEMORY.md'), '- [[zeta]]\n');
    write(path.join(mem, '.hidden.md'), 'hidden');
    write(path.join(mem, 'passwords.md'), 'secret');
    write(path.join(mem, 'big.md'), 'x'.repeat(1_000_001));
    write(path.join(mem, 'note10.md'), 'ten'); write(path.join(mem, 'note2.md'), 'two');
    symlinkSync(path.join(w.root, 'outside.md'), path.join(mem, 'link.md'));
    write(path.join(w.root, 'outside.md'), 'outside');
    withFolder(w, null);
    const lib = await NoteLibrary.load(loadConfig(w.project, w.env));
    expect(lib.notes.map((n) => n.relativePath)).toEqual(['MEMORY.md', 'note2.md', 'note10.md', 'zeta.md']);
  });
  test('links, tags and front matter', () => {
    const text = '---\ntags: [alpha, "beta"]\n---\nSee [[Other note|shown]] and [doc](sub/x.md#h) and `[[code]]` #area/ops #123\n```\n[[fenced]]\n```\n';
    expect(linksIn(text)).toEqual([{ target: 'Other note', shown: 'shown', isPath: false }, { target: 'sub/x.md#h', shown: 'doc', isPath: true }]);
    expect(tagsIn(text)).toEqual(['alpha', 'beta', 'area/ops']);
  });
  test('search: every word, #tag, name hits first, 3 lines; links resolve and backlinks list', async () => {
    const w = world('notes-search-');
    const mem = path.join(w.project, '.claude', 'memory');
    write(path.join(mem, 'MEMORY.md'), 'index [[deploy gate]]\n');
    write(path.join(mem, 'deploy gate.md'), 'The deploy gate needs a go.\nline two\n#decision\n');
    write(path.join(mem, 'other.md'), 'About the Deploy only.\n');
    withFolder(w, null);
    const lib = await NoteLibrary.load(loadConfig(w.project, w.env));
    expect(lib.search('deploy GATE').map((m) => m.note.name)).toEqual(['deploy gate', 'MEMORY']);
    expect(lib.search('deploy').map((m) => m.note.name)).toEqual(['deploy gate', 'MEMORY', 'other']);
    expect(lib.search('#decision').map((m) => m.note.name)).toEqual(['deploy gate']);
    expect(lib.search('   ')).toEqual([]);
    const index = lib.notes.find((n) => n.isIndex)!;
    expect(lib.resolve(index.links[0], index)?.name).toBe('deploy gate');
    expect(lib.backlinks(lib.notes.find((n) => n.name === 'deploy gate')!).map((n) => n.name)).toEqual(['MEMORY']);
    const text = report(lib, 'gate', 20);
    expect(text.split('\n')[0]).toContain('2 of 3 notes match "gate"');
    expect(text).toContain(path.join(mem, 'deploy gate.md'));
    expect(text).toContain('  1: The deploy gate needs a go.');
    expect(report(lib, 'deploy', 1)).toContain('… 2 more; narrow the query or raise limit.');
  });
});

test.describe('saving never loses text', () => {
  function setup() {
    const w = world('notes-save-');
    const mem = path.join(w.project, '.claude', 'memory');
    write(path.join(mem, 'a.md'), 'one');
    withFolder(w, null);
    return { w, mem, file: path.join(mem, 'a.md'), config: loadConfig(w.project, w.env) as NotesConfig };
  }
  test('writes through a rename, leaves no temp file, keeps the mode', () => {
    const { mem, file, config } = setup();
    if (process.platform !== 'win32') chmodSync(file, 0o600);
    expect(saveNote('two', file, 'one', config)).toBe('Saved.');
    expect(readFileSync(file, 'utf8')).toBe('two');
    expect(readdirSync(mem)).toEqual(['a.md']);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  test('a failed rename leaves the old text and no temp file', () => {
    const { mem, file } = setup();
    const ops = { ...require('node:fs'), renameSync: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
    expect(() => writeAtomic(file, 'new', ops)).toThrow('disk full');
    expect(readFileSync(file, 'utf8')).toBe('one');
    expect(readdirSync(mem)).toEqual(['a.md']);
  });
  test('a rename that fails once on Windows-style locks is tried again', () => {
    const { file } = setup();
    let calls = 0;
    const real = require('node:fs');
    const ops = { ...real, renameSync: (a: string, b: string) => { if (calls++ < 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); real.renameSync(a, b); } };
    writeAtomic(file, 'again', ops);
    expect(readFileSync(file, 'utf8')).toBe('again');
    expect(calls).toBe(3);
  });
  test('a file that changed on disk is a conflict: nothing is written', () => {
    const { file, config } = setup();
    writeFileSync(file, 'changed in Obsidian');
    try { saveNote('mine', file, 'one', config); throw new Error('no conflict'); } catch (e) {
      expect(e).toBeInstanceOf(Refusal);
      expect((e as Refusal).conflict).toBe(true);
      expect((e as Refusal).message).toContain('changed on disk');
    }
    expect(readFileSync(file, 'utf8')).toBe('changed in Obsidian');
  });
  test('a removed file is a conflict too, and a copy keeps the text under a new name', () => {
    const { mem, file, config } = setup();
    rmSync(file);
    expect(() => saveNote('mine', file, 'one', config)).toThrow('moved or removed');
    const copy = saveCopy('mine', file, config);
    expect(readFileSync(copy, 'utf8')).toBe('mine');
    expect(path.basename(copy)).toMatch(/^a \(conflict \d{8}-\d{6}\)\.md$/);
    expect(readdirSync(mem).length).toBe(1);
  });
  test('refuses the mirror, the exclude list, other folders, other types, and text over 1 MB', () => {
    const { w, mem, config } = setup();
    write(path.join(mem, 'passwords.md'), 'x');
    write(path.join(mem, 'plain.txt'), 'x');
    write(path.join(w.vault, 'Claude Memory', 'shop', 'a.md'), 'x');
    write(path.join(w.root, 'other.md'), 'x');
    expect(refusal(path.join(mem, 'passwords.md'), config)).toContain('exclude list');
    expect(refusal(path.join(mem, 'plain.txt'), config)).toContain('markdown');
    expect(refusal(path.join(w.root, 'other.md'), config)).toContain('Only notes');
    expect(refusal(path.join(w.vault, 'Claude Memory', 'shop', 'a.md'), config)).toContain('nightly');
    expect(refusal(path.join(mem, 'a.md'), config)).toBeNull();
    expect(() => saveNote('x'.repeat(1_000_001), path.join(mem, 'a.md'), 'one', config)).toThrow('over 1 MB');
  });
  test('a file reached through a link out of the folder is refused', () => {
    const { w, mem, config } = setup();
    write(path.join(w.root, 'target.md'), 'x');
    symlinkSync(path.join(w.root, 'target.md'), path.join(mem, 'l.md'));
    expect(refusal(path.join(mem, 'l.md'), config)).toContain('Only notes');
  });
});

test.describe('the Markdown renderer treats a note as untrusted text', () => {
  test('escapes HTML and never makes a script link', () => {
    const html = renderMarkdown('<script>window.__pwned = 1</script>\n\n<img src=x onerror="window.__pwned=1">\n\n[click](javascript:alert(1)) [ok](https://example.com/a?b=1&c=2) `<b>`', noLinks);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toMatch(/href="javascript/i);
    expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"');
    expect(html).toContain('<code>&lt;b&gt;</code>');
  });
  test('quotes in names and ids cannot break out of an attribute', () => {
    const html = renderMarkdown('[[x" onclick="1]] #tag', { wiki: () => 'a"b.md', path: () => null });
    expect(html).not.toMatch(/<[^>]* onclick=/);
    expect(html).toContain('data-note="a&quot;b.md"');
  });
  test('headings, lists, tasks, quotes, tables, fences, emphasis and wiki links', () => {
    const md = '---\ntags: [x]\n---\n# Title\n\n- one\n  - nested\n- [x] done\n\n1. first\n\n> quote\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\n<raw>\n```\n\n**bold** *it* _it2_ ~~del~~ ==mark== [[known]] [[ghost]] #topic file_name_here\n';
    const html = renderMarkdown(md, { wiki: (t) => (t === 'known' ? '/m/known.md' : null), path: () => null });
    for (const part of ['<h1>Title</h1>', '<li>one<ul><li>nested</li></ul></li>', 'checked', '<ol><li>first</li></ol>', '<blockquote><p>quote</p></blockquote>', '<th>a</th>', '<td>2</td>', '<pre><code>&lt;raw&gt;</code></pre>', '<strong>bold</strong>', '<em>it</em>', '<em>it2</em>', '<del>del</del>', '<mark>mark</mark>', 'data-note="/m/known.md"', 'class="wiki missing"', 'data-tag="topic"', 'file_name_here']) {
      expect(html, part).toContain(part);
    }
    expect(html).not.toContain('tags:');
  });
});

// ---------- in the app ----------

test.describe('the Notes sidebar, the note tab and the tool', () => {
  test.describe.configure({ mode: 'serial' });
  let app: ElectronApplication;
  let page: Page;
  let w: ReturnType<typeof world>;
  let memFile: string;
  let mem: string;

  const mcp = async (windowId: string) => {
    const hook = await app.evaluate(() => { const t = (globalThis as any).__vibexTest; return { token: t.token as string, port: t.status.mcpPort as number }; });
    const client = new Client({ name: 'notes-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hook.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${hook.token}`, 'X-Vibex-Window': windowId } } }));
    return client;
  };

  test.beforeAll(async () => {
    w = world('notes-app-');
    mem = path.join(w.project, '.claude', 'memory');
    memFile = path.join(mem, 'deploy gate.md');
    write(path.join(mem, 'MEMORY.md'), '# Index\n- [[deploy gate]] and [[ghost]]\n');
    write(memFile, '# Deploy gate\n\nNeeds a go. #decision\n\n<script>window.__pwned = 1</script>\n');
    write(path.join(mem, 'passwords.md'), 'nope');
    mkdirSync(path.join(w.vault, 'Shop'));
    write(path.join(w.vault, 'Shop', 'plan.md'), 'The launch plan.\n');
    writeFileSync(path.join(w.project, '.vibex.json'), JSON.stringify({ notes: 'Shop' }));
    const data = path.join(w.root, 'data');
    mkdirSync(data);
    writeFileSync(path.join(data, 'notes.json'), JSON.stringify({ vault: w.vault }));
    const env = {
      ...process.env, VIBEX_TEST: '1', VIBEX_USER_DATA: data, VIBEX_MCP_PORT: '0', VIBEX_AGENT_COMMAND: 'echo AGENT-START-OK',
      CLAUDE_CONFIG_DIR: w.env.claudeDir, ...(process.platform === 'darwin' ? { VIBEX_TOKEN_STORE: 'memory' } : {}),
    } as Record<string, string>;
    const executablePath = process.env.VIBEX_APP_EXECUTABLE;
    app = await electron.launch(executablePath ? { executablePath, env } : { args: ['.'], cwd: path.join(__dirname, '..'), env });
    page = await firstWindow(app);
    await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
    await page.evaluate((f) => (window as any).vibex.projects.open(f), w.project);
    await page.waitForSelector('#workspace:not([hidden])');
  });

  test.afterAll(async () => {
    await app?.close();
    rmSync(w.root, { recursive: true, force: true });
  });

  test('the Notes button lists memory facts, hides credential names, and offers the suggested folder', async () => {
    await page.locator('#activity [data-activity="notes"]').click();
    await expect(page.locator('#sidebar-title')).toHaveText('Notes');
    const rows = page.locator('.note-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('MEMORY');
    await expect(page.locator('#sidebar-body')).not.toContainText('passwords');
    await expect(page.locator('.notes-suggest')).toContainText('"Shop"');
    await page.locator('.notes-suggest button', { hasText: 'Use' }).first().click();
    await expect(rows).toHaveCount(3);
    await expect(page.locator('.notes-group').nth(1)).toHaveText('Notes (1)');
  });

  test('search narrows the list; a tag search works', async () => {
    const search = page.locator('.notes-search');
    await search.fill('launch');
    await expect(page.locator('.note-row')).toHaveCount(1);
    await expect(page.locator('.note-row-line')).toContainText('The launch plan.');
    await search.fill('#decision');
    await expect(page.locator('.note-row')).toHaveCount(1);
    await search.fill('zzzz');
    await expect(page.locator('#sidebar-body')).toContainText('No note matches');
    await search.fill('');
    await expect(page.locator('.note-row')).toHaveCount(3);
  });

  test('a note opens in a tab with a preview; a script tag in it is text and does not run', async () => {
    await page.locator('.note-row', { hasText: 'deploy gate' }).click();
    const preview = page.locator('#doc-view .note-preview');
    await expect(preview.locator('h1')).toHaveText('Deploy gate');
    await expect(preview).toContainText('<script>window.__pwned = 1</script>');
    expect(await preview.locator('script').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    await expect(page.locator('#doc-tabs .tab', { hasText: 'deploy gate' })).toBeVisible();
    await expect(page.locator('#doc-view .note-tags')).toContainText('#decision');
    await expect(page.locator('#doc-view .note-back')).toContainText('memory/MEMORY.md');
    if (process.env.NOTES_SHOTS) await page.screenshot({ path: path.join(process.env.NOTES_SHOTS, 'notes-preview.png') });
  });

  test('a [[link]] opens the note it names; a missing one is marked', async () => {
    await page.locator('.note-row', { hasText: 'MEMORY' }).click();
    await expect(page.locator('#doc-view .note-preview .wiki.missing')).toHaveText('ghost');
    await page.locator('#doc-view .note-preview a.wiki', { hasText: 'deploy gate' }).click();
    await expect(page.locator('#doc-view .note-title')).toHaveText('deploy gate');
  });

  test('typing saves by itself, through a rename, with no temp file left', async () => {
    await page.locator('#doc-view .note-head button', { hasText: 'Edit' }).click();
    const area = page.locator('#doc-view textarea.note-edit');
    await area.fill('# Deploy gate\n\nChanged in the app.\n');
    await expect(page.locator('#doc-view .note-status')).toHaveText('Saved', { timeout: 10_000 });
    expect(readFileSync(memFile, 'utf8')).toBe('# Deploy gate\n\nChanged in the app.\n');
    expect(readdirSync(mem).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  test('a change made on disk meanwhile gives a conflict message and keeps the typed text', async () => {
    const area = page.locator('#doc-view textarea.note-edit');
    writeFileSync(memFile, 'Changed by Obsidian.\n');
    await area.fill('My second edit.\n');
    await expect(page.locator('#doc-view .note-banner')).toContainText('changed on disk', { timeout: 10_000 });
    if (process.env.NOTES_SHOTS) await page.screenshot({ path: path.join(process.env.NOTES_SHOTS, 'notes-conflict.png') });
    expect(readFileSync(memFile, 'utf8')).toBe('Changed by Obsidian.\n');
    await expect(area).toHaveValue('My second edit.\n');
    await page.locator('#doc-view .note-banner button', { hasText: 'Save as a copy' }).click();
    await expect.poll(() => readdirSync(mem).filter((n) => n.includes('conflict')).length).toBe(1);
    const copy = readdirSync(mem).find((n) => n.includes('conflict'))!;
    expect(readFileSync(path.join(mem, copy), 'utf8')).toBe('My second edit.\n');
    await page.locator('#doc-view .note-banner button', { hasText: 'Replace the file' }).click();
    await expect.poll(() => readFileSync(memFile, 'utf8')).toBe('My second edit.\n');
    rmSync(path.join(mem, copy));
  });

  test('closing a tab saves what is unsaved', async () => {
    const area = page.locator('#doc-view textarea.note-edit');
    await area.fill('Typed just before the close.\n');
    await page.locator('#doc-tabs .tab', { hasText: 'deploy gate' }).locator('.close').click();
    await expect.poll(() => readFileSync(memFile, 'utf8')).toBe('Typed just before the close.\n');
  });

  test('opening and closing a CRLF note or a note with a BOM never rewrites it; an edit keeps the line end and the BOM', async () => {
    const crlf = path.join(mem, 'crlf.md');
    const bom = path.join(mem, 'bom.md');
    writeFileSync(crlf, 'one\r\ntwo\r\n');
    writeFileSync(bom, '\ufeffone\ntwo\n');
    const before = { crlf: statSync(crlf).mtimeMs, bom: statSync(bom).mtimeMs };
    if (!(await page.locator('.notes-search').isVisible())) await page.locator('#activity [data-activity="notes"]').click();
    for (const name of ['crlf', 'bom']) {
      await page.locator('.notes-bar button[title="Read the files again"]').click();
      await page.locator('.note-row', { hasText: name }).first().click();
      await expect(page.locator('#doc-view .note-title')).toHaveText(name);
      await page.locator('#doc-view .note-head button', { hasText: 'Edit' }).click();
      await page.waitForTimeout(600);
      await page.locator('#doc-tabs .tab', { hasText: name }).locator('.close').click();
    }
    await page.waitForTimeout(800);
    expect(readFileSync(crlf, 'utf8')).toBe('one\r\ntwo\r\n');
    expect(readFileSync(bom, 'utf8')).toBe('\ufeffone\ntwo\n');
    expect(statSync(crlf).mtimeMs).toBe(before.crlf);
    expect(statSync(bom).mtimeMs).toBe(before.bom);
    for (const [name, file] of [['crlf', crlf], ['bom', bom]] as const) {
      await page.locator('.note-row', { hasText: name }).first().click();
      await page.locator('#doc-view .note-head button', { hasText: 'Edit' }).click();
      const area = page.locator('#doc-view textarea.note-edit');
      await area.fill('one\ntwo\nthree\n');
      await expect(page.locator('#doc-view .note-status')).toHaveText('Saved', { timeout: 10_000 });
      await page.locator('#doc-tabs .tab', { hasText: name }).locator('.close').click();
      expect(readFileSync(file, 'utf8')).toBe(name === 'crlf' ? 'one\r\ntwo\r\nthree\r\n' : '\ufeffone\ntwo\nthree\n');
    }
    rmSync(crlf); rmSync(bom);
  });

  test('notes_search answers with the same name, inputs and text as the macOS tool', async () => {
    const id = await page.evaluate(() => (window as any).vibex.projects.list().then((s: any) => s.current));
    const client = await mcp(id);
    const tools = (await client.listTools()).tools;
    const tool = tools.find((t) => t.name === 'notes_search')!;
    expect(Object.keys((tool.inputSchema as any).properties).sort()).toEqual(['limit', 'project_path', 'query']);
    expect((tool.inputSchema as any).required).toEqual(['query']);
    const res: any = await client.callTool({ name: 'notes_search', arguments: { query: 'launch' } });
    const text: string = res.content[0].text;
    expect(readdirSync(mem).filter((n) => n.includes('conflict'))).toEqual([]);
    expect(text.split('\n')[0]).toContain('1 of 3 notes match "launch"');
    expect(text).toContain(path.join(w.vault, 'Shop', 'plan.md'));
    const none: any = await client.callTool({ name: 'notes_search', arguments: { query: 'passwords' } });
    expect(none.content[0].text).toContain('0 of 3 notes match');
    await client.close();
  });

  test('no file outside the notes is readable through the app', async () => {
    const r = await page.evaluate(([project, file]) => (window as any).vibex.mod.invoke('mod:notes:read', project, file), [await page.evaluate(() => (window as any).vibex.projects.list().then((s: any) => s.current)), path.join(w.root, 'home', 'x.md')]);
    expect(r.ok).toBe(false);
    expect(existsSync(path.join(w.root, 'home', 'x.md'))).toBe(false);
  });

  test('closing the project saves a note being edited and closes its tab', async () => {
    const id: string = await page.evaluate(() => (window as any).vibex.projects.list().then((s: any) => s.current));
    /// The app ends with its last project, so another one stays open.
    const other = path.join(w.root, 'other');
    mkdirSync(other, { recursive: true });
    await page.evaluate((f) => (window as any).vibex.projects.open(f), other);
    await page.evaluate((f) => (window as any).vibex.projects.open(f), w.project);
    await page.waitForSelector('#workspace:not([hidden])');
    if (!(await page.locator('.notes-search').isVisible())) await page.locator('#activity [data-activity="notes"]').click();
    await page.locator('.note-row', { hasText: 'deploy gate' }).first().click();
    await page.locator('#doc-view .note-head button', { hasText: 'Edit' }).click();
    await page.locator('#doc-view textarea.note-edit').fill('Typed just before the project closed.\n');
    expect(readFileSync(memFile, 'utf8')).not.toBe('Typed just before the project closed.\n');
    /// Close Project asks while a tab runs; the test answers "Close Project".
    await app.evaluate(({ dialog }) => { (dialog as any).showMessageBox = async () => ({ response: 0 }); });
    await page.evaluate((p) => (window as any).vibex.projects.close(p), id);
    await expect.poll(() => readFileSync(memFile, 'utf8')).toBe('Typed just before the project closed.\n');
    await page.evaluate((f) => (window as any).vibex.projects.open(f), w.project);
    await page.waitForSelector('#workspace:not([hidden])');
    await expect(page.locator('#doc-tabs .tab')).toHaveCount(0);
  });
});
