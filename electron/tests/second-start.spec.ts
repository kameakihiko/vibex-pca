import { _electron as electron, expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { answerSecondStart, endHolder, firstAnswered, holderPid, newStartKey, noteHolder } from '../src/main/secondStart';
import { firstWindow, tempDir } from './fixtures';

// A second start while a first one holds the lock. A healthy first one answers and shows its window. One that stays after its quit
// answers nothing, and the second start then says so in a box, where before it quit with no word (review 4, C1).

test.describe('a second start: the answer of the first', () => {
  let dir: string;
  test.beforeEach(() => { dir = tempDir('vibex-second-'); });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('a first one that runs answers, and the second start reads it at once and leaves no file', async () => {
    const key = newStartKey();
    expect(answerSecondStart(dir, { vibexStart: key }, false)).toBe(true);
    const started = Date.now();
    expect(await firstAnswered(dir, key, 5000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(readdirSync(dir)).toEqual([]);
  });

  test('a first one that is quitting does not answer: only a person can decide then', async () => {
    const key = newStartKey();
    expect(answerSecondStart(dir, { vibexStart: key }, true)).toBe(false);
    expect(await firstAnswered(dir, key, 150)).toBe(false);
  });

  test('no answer in the time: false, not a wait for ever', async () => {
    const started = Date.now();
    expect(await firstAnswered(dir, newStartKey(), 200)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('a late answer inside the time counts', async () => {
    const key = newStartKey();
    setTimeout(() => answerSecondStart(dir, { vibexStart: key }, false), 200);
    expect(await firstAnswered(dir, key, 3000)).toBe(true);
  });

  test('what another program sends is no file name', () => {
    for (const data of [undefined, null, {}, { vibexStart: 7 }, { vibexStart: '../../evil' }, { vibexStart: 'a'.repeat(31) }, { vibexStart: `${'a'.repeat(32)}/x` }]) {
      expect(answerSecondStart(dir, data, false), JSON.stringify(data)).toBe(false);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  test('a first start notes its process; only that process is ended, never this one, and a bad note ends nothing', () => {
    const killed: number[] = [];
    const kill = (pid: number) => { killed.push(pid); };
    expect(holderPid(dir)).toBeNull();
    expect(endHolder(dir, 100, kill)).toBe(false);
    noteHolder(dir, 4242);
    expect(holderPid(dir)).toBe(4242);
    expect(endHolder(dir, 100, kill)).toBe(true);
    expect(killed).toEqual([4242]);
    expect(endHolder(dir, 4242, kill)).toBe(false);
    for (const text of ['', 'abc', '-1', '0', '1.5', '99999999999999999999']) {
      writeFileSync(path.join(dir, 'main-process.pid'), text);
      expect(holderPid(dir), text).toBeNull();
    }
    expect(killed).toEqual([4242]);
    noteHolder(dir, 4243);
    expect(endHolder(dir, 100, () => { throw new Error('no such process'); })).toBe(false);
  });

  test('a first start on a new PC makes its folder', () => {
    const folder = path.join(dir, 'not', 'there');
    noteHolder(folder, 4242);
    expect(existsSync(path.join(folder, 'main-process.pid'))).toBe(true);
  });
});

test.describe('a second start in the app', () => {
  test('with a healthy first one it leaves at once, with no box', async () => {
    const dir = realpathSync.native(tempDir('vibex-second-app-'));
    const data = path.join(dir, 'data');
    mkdirSync(data);
    const env = { ...process.env, VIBEX_TEST: '1', VIBEX_USER_DATA: data, VIBEX_MCP_PORT: '0', CLAUDE_CONFIG_DIR: path.join(dir, 'cfg'), ...(process.platform === 'darwin' ? { VIBEX_TOKEN_STORE: 'memory' } : {}) } as Record<string, string>;
    // A step of the workflow sets this to an empty word for a run from source.
    const packaged = process.env.VIBEX_APP_EXECUTABLE || null;
    const app = await electron.launch(packaged ? { executablePath: packaged, env } : { args: ['.'], cwd: path.join(__dirname, '..'), env });
    try {
      const page = await firstWindow(app);
      await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
      // The binary itself, as a person starts it, with no Playwright: require('electron') in Node gives its path.
      const binary = packaged ?? (require('electron') as unknown as string);
      const second = spawn(binary, packaged ? [] : ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore', windowsHide: true });
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => { second.kill(); resolve(-1); }, 30_000);
        second.on('exit', (exit) => { clearTimeout(timer); resolve(exit); });
      });
      expect(code).toBe(0);
      expect(readdirSync(data).filter((name) => name.startsWith('second-start-'))).toEqual([]);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
