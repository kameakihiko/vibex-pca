import { expect, test } from '@playwright/test';
import { Terminals, type Launch } from '../src/main/terminals';
import { sleeper } from './fixtures';

// Flows that need no window: Reopen Closed Tab and what may be on its list.

const sh = (title: string, extra: Partial<Launch> = {}): Launch => ({ ...sleeper(), kind: 'none', title, project: 'p', ...extra });

test.describe('Reopen Closed Tab', () => {
  let terminals: Terminals;
  test.beforeEach(() => { terminals = new Terminals(); });
  test.afterEach(() => terminals.closeAll());

  test('a run tab is not on the list: its command does not run again', () => {
    let rebuilt = 0;
    const tab = terminals.create(sh('Run', { once: true, rebuild: () => { rebuilt++; throw new Error('A command does not run twice.'); } }));
    terminals.close(tab.id);
    expect(terminals.reopenClosed('p')).toBeNull();
    expect(rebuilt).toBe(0);
    expect(terminals.list().length).toBe(0);
  });

  test('a run tab that closed last does not hide the tab closed before it', () => {
    const shell = terminals.create(sh('shell'));
    const run = terminals.create(sh('Run', { once: true }));
    terminals.close(shell.id);
    terminals.close(run.id);
    expect(terminals.reopenClosed('p')?.title).toBe('shell');
  });

  test('a tab with a rebuild is made fresh, and one that refuses is skipped', () => {
    let tickets = 0;
    const ssh = terminals.create(sh('ssh pca', { rebuild: () => sh('ssh pca', { env: { TICKET: String(++tickets) } }) }));
    const dead = terminals.create(sh('gone', { rebuild: () => { throw new Error('refused'); } }));
    terminals.close(ssh.id);
    terminals.close(dead.id);
    expect(terminals.reopenClosed('p')?.title).toBe('ssh pca');
    expect(tickets).toBe(1);
    expect(terminals.reopenClosed('p')).toBeNull();
  });

  test('closing the project forgets its closed tabs', () => {
    const a = terminals.create(sh('shell'));
    terminals.close(a.id);
    terminals.closeProject('p');
    expect(terminals.reopenClosed('p')).toBeNull();
  });
});
