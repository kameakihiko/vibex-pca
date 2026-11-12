import { expect, test } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { logWindowsProcesses, tempDir } from './fixtures';

// A quit as a person's app has it: no Playwright and no inspector, so no test guard either (main.ts). The other specs quit under
// --inspect, where Node's exit joined a thread that did not end. If this goes red, the hang reaches people.
test('Windows: with no inspector the app ends after its window closes, 10 of 10, with tabs that have run', async () => {
  test.skip(process.platform !== 'win32', 'a Windows hang');
  test.setTimeout(600_000);
  const dir = tempDir('vibex-quit-plain-');
  const electron = require('electron') as unknown as string;
  let ended = 0;
  try {
    for (let i = 0; i < 10; i++) {
      const userData = path.join(dir, `profile-${i}`);
      const work = path.join(dir, `work-${i}`);
      mkdirSync(userData);
      mkdirSync(work);
      writeFileSync(path.join(userData, 'projects.json'), JSON.stringify({ open: [work] }));
      const child = spawn(electron, ['.'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, VIBEX_TEST: '1', VIBEX_USER_DATA: userData, VIBEX_MCP_PORT: '0', VIBEX_SECRET_CRYPT: 'test', CLAUDE_CONFIG_DIR: path.join(dir, `claude-${i}`) },
        stdio: 'ignore',
      });
      const gone = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 38_000);
        child.once('exit', () => { clearTimeout(timer); resolve(true); });
      });
      // The tabs start and print their first lines; a quit soon after output is when the hang came in the other specs.
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      // With no /F: a close message to the window, as the person's close button sends.
      try {
        execFileSync(path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
      } catch (error) {
        console.log(`close message ${i}: ${String(error).slice(0, 160)}`);
      }
      if (await gone) ended++;
      else {
        logWindowsProcesses(`plain quit ${i}`);
        child.kill();
      }
    }
    console.log(`plain quits: ${ended} of 10 ended`);
    expect(ended).toBe(10);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  }
});
