import { expect, test } from '@playwright/test';
import { runningWork, workPhrase } from '../src/main/runningWork';

// Pure functions, no app window. The questions before closing a project, quitting and restarting for an update
// count only work that stops (busy), not every alive tab (Swift #49 A1, A2).
const shell = { alive: true, busy: false, project: 'p1' };
const busyChat = { alive: true, busy: true, chat: true, project: 'p1' };
const busyCommand = { alive: true, busy: true, project: 'p1' };

test('1. three idle alive tabs count as 0 and have no question text', () => {
  const work = runningWork([shell, shell, shell]);
  expect(work.claude).toBe(0);
  expect(work.commands).toBe(0);
  expect(work.total).toBe(0);
  expect(workPhrase(work)).toBeNull();
});

test('2. a busy chat, a busy command and an idle shell count as 1 Claude session and 1 command', () => {
  const work = runningWork([busyChat, busyCommand, shell]);
  expect(work).toMatchObject({ claude: 1, commands: 1, total: 2, projects: 1 });
  expect(workPhrase(work)).toBe('1 Claude session and 1 command');
});

test('3. a dead tab never counts, busy or not', () => {
  const work = runningWork([{ ...busyChat, alive: false }, { ...busyCommand, alive: false }]);
  expect(work.total).toBe(0);
  expect(workPhrase(work)).toBeNull();
});

test('4. an agent pane terminal is a Claude session; projects are counted from busy tabs only', () => {
  const work = runningWork([{ alive: true, busy: true, pane: 'agent', project: 'p1' }, { ...busyCommand, project: 'p2' }, { ...shell, project: 'p3' }]);
  expect(work).toMatchObject({ claude: 1, commands: 1, projects: 2 });
});

test('5. the phrase uses the singular and the plural right', () => {
  expect(workPhrase({ claude: 2, commands: 1 })).toBe('2 Claude sessions and 1 command');
  expect(workPhrase({ claude: 1, commands: 0 })).toBe('1 Claude session');
  expect(workPhrase({ claude: 0, commands: 2 })).toBe('2 commands');
  expect(workPhrase({ claude: 0, commands: 1 })).toBe('1 command');
});
