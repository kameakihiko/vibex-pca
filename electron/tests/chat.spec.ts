import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import path from 'node:path';
import { approvalRefusal, ARM_MS } from '../src/main/chatGate';
import { allowLine, answerLine, controlLine, denyLine, parseChatLine, transcriptFile, userLine } from '../src/main/chatEvents';
import { ChatModel, claudeArgs, safeModel, safeSession, type ChatItem } from '../src/main/chatModel';
import { recentSessions } from '../src/main/chatProcess';
import { allowRefusal, alwaysAllowHelp, cardView, clipped, imageTypeOf, isTrustedIn, onlyRules, permissionRows, shownAbove, WHOLE_LIMIT } from '../src/main/chatTrust';
import { answerOn, filePathInPartial, reachedEnd, suggestions, terminalOnlyCommand, toolSummary, verbFor } from '../src/renderer/chatText';
import { firstWindow, startSite, startSshServer, tempDir } from './fixtures';

// The native Claude chat (macOS Vibex: Vibex/Claude/). A made-up `claude` (tests/fake-claude.cjs) speaks the stream format.
// The first half needs no window: the parser, the model and a real process of the fake. The second half runs the app.

const FAKE = path.join(__dirname, 'fake-claude.cjs');
const posix = process.platform !== 'win32';

/// On Windows the made-up claude cannot be a claude.exe: the app runs node with it as a script, by the test switches. The rest
/// of the path is the real one: a program by its full path, an argument list, three pipes, no shell.
function makeFakeBin(dir: string): string {
  if (!posix) return process.execPath;
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const file = path.join(bin, 'claude');
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

const readLog = (file: string): any[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sent = (file: string) => readLog(file).filter((l) => l.stdin).map((l) => l.stdin);
const answers = (file: string) => sent(file).filter((m) => m.type === 'control_response');
const starts = (file: string) => readLog(file).filter((l) => l.start);

// ------------------------------------------------------------------ no window

test.describe('chat: what Claude Code says', () => {
  test('init gives the session, the model, the commands and the mode', () => {
    const events = parseChatLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', slash_commands: ['compact'], permissionMode: 'plan' }));
    expect(events).toEqual([{ type: 'started', session: 's1', model: 'm', commands: ['compact'] }, { type: 'permissionMode', mode: 'plan' }]);
  });

  test('a line that is not JSON, or has no type, says nothing', () => {
    expect(parseChatLine('not json')).toEqual([]);
    expect(parseChatLine('{"a":1}')).toEqual([]);
    expect(parseChatLine('[1,2]')).toEqual([]);
  });

  test('a subagent stays inside its card', () => {
    expect(parseChatLine(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'text', text: 'inner' }] } }))).toEqual([]);
    expect(parseChatLine(JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'inner' }] } }))).toEqual([]);
  });

  test('deltas, text, tool calls and results', () => {
    expect(parseChatLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } }))).toEqual([{ type: 'textDelta', text: 'Hi' }]);
    expect(parseChatLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"a' } } }))).toEqual([{ type: 'toolInputDelta', text: '{"a' }]);
    expect(parseChatLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Write' } } }))).toEqual([{ type: 'toolStarting', name: 'Write' }]);
    expect(parseChatLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls', n: 3, o: { a: 1 } } }] } }))).toEqual([
      { type: 'text', text: 'Done' },
      { type: 'toolUse', tool: { id: 't', name: 'Bash', input: { command: 'ls', n: '3', o: '{"a":1}' } } },
    ]);
    const [result] = parseChatLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'image', source: { media_type: 'image/png', data: 'QUJD' } }] }] } }));
    expect(result).toEqual({ type: 'toolResult', result: { toolUseId: 't', text: 'a\nb', images: [{ mediaType: 'image/png', data: 'QUJD' }], isError: true } });
  });

  test('an image of a kind the app does not show is dropped', () => {
    const [result] = parseChatLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { media_type: 'image/svg+xml', data: 'QUJD' } }, { type: 'image', source: { media_type: 'image/png', data: 'not base64 !!' } }] }] } }));
    expect((result as any).result.images).toEqual([]);
  });

  test('a permission keeps the input exactly, and its suggestions', () => {
    const input = { command: 'ls', list: [1, 2] };
    const [event] = parseChatLine(JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'u1', input, permission_suggestions: [{ a: 1 }] } }));
    expect(event).toEqual({ type: 'permission', request: { id: 'r1', tool: { id: 'u1', name: 'Bash', input: { command: 'ls', list: '[1,2]' } }, rawInput: input, suggestions: [{ a: 1 }] } });
    expect(parseChatLine(JSON.stringify({ type: 'control_cancel_request', request_id: 'r1' }))).toEqual([{ type: 'permissionCancelled', id: 'r1' }]);
    // Anything else it asks gets an answer: with none it would wait for good.
    expect(parseChatLine(JSON.stringify({ type: 'control_request', request_id: 'r2', request: { subtype: 'elicitation' } }))).toEqual([{ type: 'unanswerable', id: 'r2', subtype: 'elicitation' }]);
  });

  test('the rest: result, reset, status, compact, commands, context, a refusal', () => {
    expect(parseChatLine(JSON.stringify({ type: 'result', is_error: true, duration_ms: 2500, result: 'no' }))).toEqual([{ type: 'turnEnded', seconds: 2.5, isError: true, message: 'no' }]);
    expect(parseChatLine(JSON.stringify({ type: 'conversation_reset', new_conversation_id: 'n' }))).toEqual([{ type: 'conversationReset', session: 'n' }]);
    expect(parseChatLine(JSON.stringify({ type: 'system', subtype: 'status', status: 'compacting' }))).toEqual([{ type: 'status', status: 'compacting' }]);
    expect(parseChatLine(JSON.stringify({ type: 'system', subtype: 'status', status: 'other' }))).toEqual([]);
    expect(parseChatLine(JSON.stringify({ type: 'system', subtype: 'compact_boundary' }))).toEqual([{ type: 'compacted' }]);
    expect(parseChatLine(JSON.stringify({ type: 'system', subtype: 'commands_changed', commands: [{ name: 'a', description: '(user) One. Two' }, { name: '__x' }] }))).toEqual([{ type: 'commandsChanged', commands: [{ name: 'a', summary: 'One', argumentHint: '' }] }]);
    expect(parseChatLine(JSON.stringify({ type: 'control_response', response: { subtype: 'success', response: { totalTokens: 5, percentage: 61 } } }))).toEqual([{ type: 'contextUsage', percent: 61 }]);
    expect(parseChatLine(JSON.stringify({ type: 'control_response', response: { subtype: 'error', error: 'refused' } }))).toEqual([{ type: 'controlFailed', message: 'refused' }]);
  });

  // Lines of real Claude Code 2.1.316, recorded on 2026-11-02 against a made-up API, with the paths made up.
  const recorded = readFileSync(path.join(__dirname, 'chat-recorded-stream.jsonl'), 'utf8').split('\n').filter(Boolean);

  test('real stream: Always Allow suggests three things, and only the rules go back', () => {
    const [event] = parseChatLine(recorded[0]) as any[];
    expect(event.request.suggestions.map((s: any) => s.type)).toEqual(['addRules', 'addDirectories', 'setMode']);
    expect(onlyRules(event.request.suggestions)!.map((s: any) => s.type)).toEqual(['addRules']);
    expect(onlyRules([{ type: 'setMode', mode: 'acceptEdits' }])).toBeNull();
    expect(onlyRules(null)).toBeNull();
  });

  test('real stream: a change of mode comes in a status line and at each init', () => {
    expect(parseChatLine(recorded[1])).toEqual([{ type: 'status', status: null }, { type: 'permissionMode', mode: 'acceptEdits' }]);
    expect(parseChatLine(recorded[2]).at(-1)).toEqual({ type: 'permissionMode', mode: 'acceptEdits' });
  });

  test('a result with no text gives its first error; a retry says so', () => {
    expect(parseChatLine(JSON.stringify({ type: 'result', is_error: true, duration_ms: 0, errors: ['first', 'second'] }))).toEqual([{ type: 'turnEnded', seconds: 0, isError: true, message: 'first' }]);
    const [retry] = parseChatLine(JSON.stringify({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 1000 })) as any[];
    expect(retry.type).toBe('status');
    expect(retry.status).toContain('attempt 2 of 10');
  });

  test('an image is what its bytes say, not its file name', () => {
    expect(imageTypeOf(Buffer.from('89504e470d0a1a0a00', 'hex'))).toBe('image/png');
    expect(imageTypeOf(Buffer.from('ffd8ffe000', 'hex'))).toBe('image/jpeg');
    expect(imageTypeOf(Buffer.from('474946383961', 'hex'))).toBe('image/gif');
    expect(imageTypeOf(Buffer.from('52494646000000005745425056503820', 'hex'))).toBe('image/webp');
    expect(imageTypeOf(Buffer.from('<svg>'))).toBeNull();
  });

  test('markdown: a heading with U+2028 and an odd line end, inside a time limit', () => {
    // A child with a limit: an endless loop here would stop this whole test run.
    const built = buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'renderer', 'markdown.ts')], bundle: true, format: 'cjs', write: false, platform: 'node' }).outputFiles[0].text;
    const script = `
      const make = () => ({ children: [], append(...x) { this.children.push(...x); }, set textContent(t) { this.text = t; }, classList: { add() {} } });
      global.document = { createElement: make, createTextNode: (t) => t };
      const module = { exports: {} };
      new Function('module', 'exports', 'require', ${JSON.stringify(built)})(module, module.exports, require);
      for (const text of ['# a\\u2028b', '#\\u2028', '- \\u2028', '> \\u2028', '1.\\u2028x', '#\\u00a0a', '   ', '\\u2028\\u2029']) module.exports.renderMarkdown(text);
      console.log('done');`;
    const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10_000 });
    expect(run.error).toBeUndefined();
    expect(run.stdout).toContain('done');
  });

  test('a transcript hides what the person did not type', () => {
    expect(parseChatLine(JSON.stringify({ type: 'user', isMeta: true, message: { content: 'x' } }))).toEqual([]);
    expect(parseChatLine(JSON.stringify({ type: 'user', message: { content: '<system-reminder>x</system-reminder>' } }))).toEqual([]);
    expect(parseChatLine(JSON.stringify({ type: 'user', message: { content: '[Request interrupted by user]' } }))).toEqual([]);
    expect(parseChatLine(JSON.stringify({ type: 'user', message: { content: 'real words' } }))).toEqual([{ type: 'userText', text: 'real words' }]);
  });

  test('what goes to its stdin is what Swift writes', () => {
    expect(JSON.parse(userLine('hi'))).toEqual({ type: 'user', message: { role: 'user', content: 'hi' } });
    expect(JSON.parse(userLine('hi', [{ mediaType: 'image/png', data: 'QUJD' }]))).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }, { type: 'text', text: 'hi' }] } });
    expect(JSON.parse(allowLine('r', { a: 1 }))).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'r', response: { behavior: 'allow', updatedInput: { a: 1 } } } });
    expect(JSON.parse(allowLine('r', { a: 1 }, [{ b: 2 }])).response.response.updatedPermissions).toEqual([{ b: 2 }]);
    expect(JSON.parse(denyLine('r', 'no')).response.response).toEqual({ behavior: 'deny', message: 'no' });
    expect(JSON.parse(answerLine('r', { questions: [] }, { Q: 'A' })).response.response.updatedInput).toEqual({ questions: [], answers: { Q: 'A' } });
    const control = JSON.parse(controlLine('set_model', { model: 'opus' }));
    expect(control.type).toBe('control_request');
    expect(control.request).toEqual({ subtype: 'set_model', model: 'opus' });
    expect(control.request_id).toBeTruthy();
  });

  test('the transcript file of a session, as Claude Code names it', () => {
    expect(transcriptFile('abc', '/home/me/My App_2', '/cfg')).toBe(path.join('/cfg', 'projects', '-home-me-My-App-2', 'abc.jsonl'));
  });
});

test.describe('chat: arguments are never shell text', () => {
  test('the arguments are the ones Swift passes', () => {
    expect(claudeArgs({ resume: null, mode: 'default', model: '' })).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', 'default']);
    expect(claudeArgs({ resume: 'abc-1', mode: 'plan', model: 'opus' }).slice(-6)).toEqual(['--permission-mode', 'plan', '--resume', 'abc-1', '--model', 'opus']);
  });

  test('a typed model or session cannot be another switch', () => {
    expect(safeModel('opus')).toBe(true);
    expect(safeModel('claude-opus-5-5[1m]')).toBe(true);
    expect(safeModel('--dangerously-skip-permissions')).toBe(false);
    expect(safeModel('a b')).toBe(false);
    expect(safeSession('0f3c-11aa')).toBe(true);
    expect(safeSession('--dangerously-skip-permissions')).toBe(false);
    expect(safeSession('../../etc/passwd')).toBe(false);
  });
});

test.describe('chat: trust', () => {
  const config = (projects: object) => JSON.stringify({ projects });
  const posixPaths = { paths: path.posix, exists: () => false };

  test('a folder or one above it, until a repository root', () => {
    expect(isTrustedIn('/a/b', config({ '/a/b': { hasTrustDialogAccepted: true } }), posixPaths)).toBe(true);
    expect(isTrustedIn('/a/b/c', config({ '/a': { hasTrustDialogAccepted: true } }), posixPaths)).toBe(true);
    expect(isTrustedIn('/a/b/c', config({ '/a': { hasTrustDialogAccepted: true } }), { paths: path.posix, exists: (f: string) => f === '/a/b/.git' })).toBe(false);
    expect(isTrustedIn('/a/b', config({ '/a/b': { hasTrustDialogAccepted: false } }), posixPaths)).toBe(false);
  });

  test('a missing or broken config means not trusted', () => {
    expect(isTrustedIn('/a', null, posixPaths)).toBe(false);
    expect(isTrustedIn('/a', 'not json', posixPaths)).toBe(false);
    expect(isTrustedIn('/a', '{"projects":3}', posixPaths)).toBe(false);
  });

  test('Windows: the config writes the path with forward slashes (logic only, no Windows run)', () => {
    const win = { paths: path.win32, exists: () => false };
    expect(isTrustedIn('C:\\Users\\me\\app', config({ 'C:/Users/me/app': { hasTrustDialogAccepted: true } }), win)).toBe(true);
    expect(isTrustedIn('C:\\Users\\me\\app\\sub', config({ 'C:/Users/me/app': { hasTrustDialogAccepted: true } }), win)).toBe(true);
    expect(isTrustedIn('C:\\Users\\me\\app', config({ 'C:\\Users\\me\\app': { hasTrustDialogAccepted: true } }), win)).toBe(true);
    expect(isTrustedIn('C:\\Other', config({ 'C:/Users/me/app': { hasTrustDialogAccepted: true } }), win)).toBe(false);
  });
});

test.describe('chat: the words on the cards', () => {
  const tool = (name: string, input: Record<string, string> = {}) => ({ id: 'x', name, input });

  test('a card says what Claude acted on', () => {
    expect(toolSummary(tool('Read', { file_path: '/a/b/c.txt' }))).toMatchObject({ icon: 'file', title: 'Read c.txt', path: '/a/b/c.txt' });
    expect(toolSummary(tool('Edit', { file_path: '/a/c.txt' })).title).toBe('Edit c.txt');
    expect(toolSummary(tool('Bash', { command: 'ls -la' }))).toMatchObject({ icon: 'terminal', title: 'ls -la', isCode: true });
    expect(toolSummary(tool('Grep', { pattern: 'needle' })).title).toBe('Search for needle');
    expect(toolSummary(tool('WebSearch', { query: 'q' })).title).toBe('Search the web for q');
    expect(toolSummary(tool('Agent', { description: 'Look around' })).title).toBe('Look around');
    expect(toolSummary(tool('mcp__vibex__browser_click', { label: 'Pay' })).title).toBe('Browser: click “Pay”');
    expect(toolSummary(tool('mcp__other_server__do_thing')).title).toBe('other: server do thing');
    expect(toolSummary(tool('Unknown')).title).toBe('Unknown');
  });

  test('typed text never shows, and a ref wins over words Claude wrote', () => {
    expect(toolSummary(tool('mcp__vibex__browser_type', { text: 'my-password' })).title).toBe('Browser: type');
    expect(toolSummary(tool('mcp__vibex__browser_click', { ref: 'e5', label: 'Cancel' })).title).toBe('Browser: click');
  });

  test('the headline of an approval shows only what the tool is', () => {
    expect(toolSummary(tool('mcp__vibex__browser_click', { label: 'Cancel' }), false).title).toBe('Browser: click');
    expect(toolSummary(tool('Agent', { description: 'Harmless words' }), false).title).toBe('Agent');
    expect(verbFor('Bash')).toBe('run');
    expect(verbFor('Write')).toBe('create');
    expect(verbFor('MultiEdit')).toBe('edit');
    expect(verbFor('WebFetch')).toBe('go online');
    expect(verbFor('mcp__x__y')).toBe('use a tool');
  });

  test('what an approval shows besides the command', () => {
    expect([...shownAbove({ command: 'x', other: 'y' })]).toEqual(['command']);
    expect([...shownAbove({ file_path: 'x', old_string: 'a', new_string: 'b' })].sort()).toEqual(['file_path', 'new_string', 'old_string']);
    expect(permissionRows({ command: 'ls', description: 'List', n: { a: 1 } }, new Set(['command']))).toEqual([{ key: 'description', value: 'List' }, { key: 'n', value: '{\n  "a": 1\n}' }]);
    expect(clipped('x'.repeat(30), 10)).toBe(`${'x'.repeat(10)}\n… 20 more characters not shown`);
    expect(alwaysAllowHelp(null)).toBe('Also allow this from now on');
    expect(alwaysAllowHelp([{ a: 1 }])).toContain('Adds to Claude Code\'s permissions: [{"a":1}]');
  });

  test('small readers of what Claude writes', () => {
    expect(filePathInPartial('{"file_path":"/a/b.json","con')).toBe('/a/b.json');
    expect(filePathInPartial('{"file_pa')).toBeNull();
    expect(terminalOnlyCommand("/color isn't available in this environment.")).toBe('color');
    expect(terminalOnlyCommand("/co;rm isn't available in this environment.")).toBeNull();
    expect(terminalOnlyCommand('plain words')).toBeNull();
  });

  const commands = [{ name: 'compact', summary: 'Keep a summary', argumentHint: '[x]' }, { name: 'color', summary: 'A colour', argumentHint: '' }, { name: 'zeta', summary: 'needs a thing', argumentHint: '<thing>' }, { name: 'model', summary: 'Pick a model', argumentHint: '' }];
  const models = [{ value: 'default', title: 'Default', summary: 'Fake · x', effortLevels: [] }, { value: 'opus', title: 'Opus', summary: 'Big', effortLevels: [] }];
  const menu = (text: string, files: string[] = []) => suggestions(text, { commands, models, sessions: [{ id: 's1', title: 'Fix the bug', date: 0 }], files });

  test('slash commands: what people reach for comes first, with a description', () => {
    expect(menu('/')[0].title).toBe('/plan');
    expect(menu('/co').map((r) => r.title).slice(0, 2)).toEqual(['/compact', '/color']);
    const compact = menu('/compact')[0];
    expect(compact.detail).toBe('[x]  Keep a summary');
    expect(compact.action).toEqual({ run: '/compact' });
    expect(menu('/zeta')[0].action).toEqual({ insert: '/zeta ' });
    expect(menu('/model')[0].action).toEqual({ insert: '/model ' });
    expect(menu('/plan')[0].detail).toContain('Plan mode');
  });

  test('a command\'s argument has its own menu', () => {
    expect(menu('/model ').map((r) => r.title)).toEqual(['Default', 'Opus']);
    expect(menu('/model op')[0].action).toEqual({ run: '/model opus' });
    expect(menu('/effort h').map((r) => r.title)).toEqual(['high']);
    expect(menu('/resume ')[0]).toMatchObject({ title: 'Fix the bug', action: { run: '/resume s1' }, isCode: false });
    expect(menu('/compact now')).toEqual([]);
  });

  test('@ ranks the project files and keeps what was typed before it', () => {
    const rows = menu('look at @rea', ['src/main.ts', 'readme.txt']);
    expect(rows[0].title).toBe('readme.txt');
    expect(rows[0].action).toEqual({ insert: 'look at @readme.txt ' });
    expect(menu('plain words', ['a'])).toEqual([]);
  });
});

test.describe('chat: what a card can show truthfully', () => {
  const view = (input: Record<string, string>, whole = false) => cardView({ input }, input, whole);

  test('a plain command has nothing to say, and Allow waits only for a read', () => {
    const v = view({ command: 'ls -la\n\techo ok', description: 'List the files' });
    expect(v.refuse).toBeNull();
    expect(v.note).toBeNull();
    expect(v.cut).toBe(false);
    expect(allowRefusal(v, true)).toBeNull();
    expect(allowRefusal(v, false)).toMatch(/read to the end/i);
  });

  for (const [what, command, code] of [
    ['a bidi control', 'echo safe \u202E; rm -rf x', 'U+202E'],
    ['a zero width space', 'rm\u200B -rf x', 'U+200B'],
    ['a no-break space', 'echo safe\u00A0# ; rm -rf x', 'U+00A0'],
    ['a line separator', 'echo a\u2028rm -rf x', 'U+2028'],
    ['a control character', 'echo a\x1b[2K', 'U+001B'],
    ['a carriage return', 'echo safe\rrm -rf x', 'U+000D'],
  ] as const) {
    test(`${what} in a command: it is marked, and Allow is off whatever was read`, () => {
      const v = view({ command });
      expect(v.input.command).toContain(`<${code}>`);
      expect(v.input.command).not.toContain(String.fromCodePoint(Number.parseInt(code.slice(2), 16)));
      expect(v.refuse).toContain(code);
      expect(allowRefusal(v, true)).toContain(code);
    });
  }

  test('a file path and an unknown input count as the command does', () => {
    expect(view({ file_path: '/made/up/\u202Etxt.exe' }).refuse).toContain('U+202E');
    expect(view({ command: 'ls', url: 'https://example.invalid/\u200B' }).refuse).toContain('U+200B');
    expect(cardView({ input: { command: 'ls' } }, { command: 'ls', list: ['\u202E'] }).refuse).toContain('U+202E');
  });

  test('file text is marked with a line, and it can still be allowed: a line end of Windows and an emoji are normal there', () => {
    const v = view({ file_path: '/made/up/a.txt', old_string: 'a\r\nb', new_string: 'a\r\nb\u202Ec' });
    expect(v.refuse).toBeNull();
    expect(v.input.old_string).toBe('a\nb');
    expect(v.input.new_string).toBe('a\nb<U+202E>c');
    expect(v.note).toMatch(/marked/);
    expect(allowRefusal(v, true)).toBeNull();
    const written = cardView({ input: { file_path: '/made/up/a.txt', content: 'ok \uFE0F' } }, { file_path: '/made/up/a.txt', content: 'ok \uFE0F' });
    expect(written.rows).toEqual([{ key: 'content', value: 'ok <U+FE0F>' }]);
    expect(allowRefusal(written, true)).toBeNull();
  });

  test('a long command: the card holds only its start until the person asks for all of it; Allow is off until then, and until the end is read', () => {
    const command = `echo start\n${'x'.repeat(30_000)}\nrm -rf hidden-at-the-end`;
    const v = view({ command });
    expect(v.cut).toBe(true);
    expect(v.input.command).not.toContain('hidden-at-the-end');
    // What the page says about scrolling does not count while only the start is on the page.
    expect(allowRefusal(v, true)).toMatch(/Show All/);
    const all = view({ command }, true);
    expect(all.cut).toBe(false);
    expect(all.input.command).toBe(command);
    expect(allowRefusal(all, false)).toMatch(/read to the end/i);
    expect(allowRefusal(all, true)).toBeNull();
  });

  test('a row beyond the limit is cut the same way, and all of it comes on asking', () => {
    const content = `${'y'.repeat(25_000)}\nend-of-file`;
    const v = cardView({ input: { file_path: '/made/up/a.txt', content } }, { file_path: '/made/up/a.txt', content });
    expect(v.cut).toBe(true);
    expect(v.rows[0].value).not.toContain('end-of-file');
    expect(cardView({ input: { file_path: '/made/up/a.txt', content } }, { file_path: '/made/up/a.txt', content }, true).rows[0].value).toContain('end-of-file');
  });

  test('beyond what any card can show, Allow is off for good, and nothing asks for it', () => {
    const v = view({ command: 'x'.repeat(WHOLE_LIMIT + 1) });
    expect(v.tooLong).toBe(true);
    expect(allowRefusal(v, true)).toMatch(/too long/);
    expect(view({ command: 'x'.repeat(WHOLE_LIMIT + 1) }, true).input.command.length).toBeLessThan(WHOLE_LIMIT + 100);
  });

  test('the buttons: Allow and Always Allow wait for the arm, the read and a clean card; the others wait only for the arm', () => {
    for (const choice of ['allow', 'always']) {
      expect(answerOn(choice, true, true, false), choice).toBe(true);
      expect(answerOn(choice, false, true, false), choice).toBe(false);
      expect(answerOn(choice, true, false, false), choice).toBe(false);
      expect(answerOn(choice, true, true, true), choice).toBe(false);
    }
    for (const choice of ['deny', 'build', 'keep-planning', 'answer']) {
      expect(answerOn(choice, true, false, true), choice).toBe(true);
      expect(answerOn(choice, false, true, false), choice).toBe(false);
    }
  });

  test('the end of a box: at the end, within a rounding at 150 %, and not before; a box with no scroll is read', () => {
    expect(reachedEnd(0, 100, 100)).toBe(true);
    expect(reachedEnd(900, 100, 1000)).toBe(true);
    expect(reachedEnd(898.5, 100, 1000)).toBe(true);
    expect(reachedEnd(880, 100, 1000)).toBe(false);
    expect(reachedEnd(0, 100, 1000)).toBe(false);
  });
});

test.describe('chat: an approval comes from a person', () => {
  const shownAt = 10_000;
  const click = (at: number, movedAt: number) => ({ at, movedAt, heldFor: 0 });

  test('a click after the arm time, by a mouse that moved after the card came, passes', () => {
    expect(approvalRefusal({ shownAt, now: shownAt + ARM_MS + 100, click: click(shownAt + ARM_MS + 50, shownAt + 10) })).toBeNull();
  });

  test('a card that was never on screen cannot be answered', () => {
    expect(approvalRefusal({ shownAt: null, now: 1, click: click(1, 1) })).toMatch(/not on screen/);
  });

  test('a press before the arm time, or a mouse that rested, is refused', () => {
    expect(approvalRefusal({ shownAt, now: shownAt + 50, click: click(shownAt + 40, shownAt + 10) })).toMatch(/too soon/);
    expect(approvalRefusal({ shownAt, now: shownAt + ARM_MS + 100, click: click(shownAt + ARM_MS + 50, shownAt - 1) })).toMatch(/Move the pointer/);
  });

  test('neither a press nor a key is a refusal', () => {
    expect(approvalRefusal({ shownAt, now: shownAt + 9000 })).toMatch(/click or a key/);
  });

  test('a real key counts only for a moment, and never a repeat from before the card', () => {
    expect(approvalRefusal({ shownAt, now: shownAt + ARM_MS + 100, keyAt: shownAt + ARM_MS + 50 })).toBeNull();
    expect(approvalRefusal({ shownAt, now: shownAt + 9000, keyAt: shownAt + 1000 })).toMatch(/click or a key/);
    expect(approvalRefusal({ shownAt, now: shownAt + ARM_MS + 100, keyAt: shownAt + 5 })).toMatch(/too soon/);
  });
});

test.describe('chat: the model with a real process of the fake', () => {
  let dir: string;
  let folder: string;
  let config: string;
  let logFile: string;
  let binary: string;
  const open: ChatModel[] = [];

  test.beforeEach(() => {
    dir = realpathSync.native(tempDir('vibex-chat-model-'));
    folder = path.join(dir, 'project');
    mkdirSync(folder);
    config = path.join(dir, 'cfg');
    mkdirSync(config);
    logFile = path.join(dir, 'log.jsonl');
    binary = makeFakeBin(dir);
  });

  test.afterEach(() => {
    for (const m of open.splice(0)) m.terminate();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function chat(options: Partial<ConstructorParameters<typeof ChatModel>[0]> = {}): ChatModel {
    const model = new ChatModel({
      folder,
      configDir: config,
      environment: { ...process.env, CLAUDE_CONFIG_DIR: config, FAKE_CLAUDE_LOG: logFile, VIBEX_WINDOW: 'w1' } as Record<string, string>,
      binary: () => binary,
      leadArgs: posix ? [] : [FAKE],
      isTrusted: () => true,
      ...options,
    });
    open.push(model);
    return model;
  }
  const until = async (what: () => boolean) => expect.poll(what, { timeout: 15_000 }).toBe(true);
  const kinds = (m: ChatModel) => m.items.map((i: ChatItem) => i.kind);
  const texts = (m: ChatModel) => m.items.filter((i) => i.kind === 'text').map((i: any) => i.text);

  test('a message streams, ends the turn, and the process stays for the next one', async () => {
    const m = chat();
    m.send('hello');
    expect(m.busy).toBe(true);
    await until(() => !m.busy);
    expect(texts(m)).toEqual(['Hello from **fake** Claude']);
    expect(kinds(m)).toEqual(['user', 'text', 'done']);
    expect(m.session).toBeTruthy();
    expect(m.activeModel).toBe('fake-sonnet');
    m.send('again');
    await until(() => texts(m).includes('You said: again'));
    expect(starts(logFile)).toHaveLength(1);
    expect(starts(logFile)[0].cwd).toBe(folder);
    expect(starts(logFile)[0].env.VIBEX_WINDOW).toBe('w1');
  });

  test('a turn asks for the context, and the meter takes the reply', async () => {
    const m = chat();
    m.send('hello');
    await until(() => m.contextPercent === 12);
    expect(sent(logFile).some((s) => s.request?.subtype === 'get_context_usage')).toBe(true);
  });

  test('the title is what was asked first, cut to fit', async () => {
    const m = chat();
    expect(m.title).toBe('Claude');
    m.send('a very long first question that goes on and on');
    expect(m.title).toBe('a very long first question …');
  });

  test('an approval echoes Claude\'s own input and nothing else', async () => {
    const m = chat();
    m.send('bash');
    await until(() => m.permissions.length === 1);
    expect(m.permissions[0].tool.name).toBe('Bash');
    expect(m.needsAttention).toBe(true);
    m.allow(m.permissions[0].id);
    await until(() => texts(m).includes('The command ran.'));
    const [line] = answers(logFile);
    expect(line.response.response).toEqual({ behavior: 'allow', updatedInput: { command: 'echo made-up', description: 'Say made-up' } });
    expect(m.needsAttention).toBe(false);
    const tool: any = m.items.find((i) => i.kind === 'tool');
    expect(tool.result.text).toBe('made-up');
  });

  test('Always Allow adds what Claude Code suggested; a deny says no', async () => {
    const m = chat();
    m.send('bash');
    await until(() => m.permissions.length === 1);
    m.allow(m.permissions[0].id, true);
    await until(() => !m.busy);
    expect(answers(logFile)[0].response.response.updatedPermissions).toHaveLength(1);
    m.send('bash');
    await until(() => m.permissions.length === 1);
    m.deny(m.permissions[0].id);
    await until(() => texts(m).includes('The command did not run.'));
    expect(answers(logFile)[1].response.response.behavior).toBe('deny');
  });

  test('an answer names only a question and an option that were asked', async () => {
    const m = chat();
    m.send('question');
    await until(() => m.permissions.length === 1);
    const { id } = m.permissions[0];
    expect(() => m.answer(id, { 'Which colour?': 'Green' })).toThrow(/not an option/);
    expect(() => m.answer(id, { Other: 'Red' })).toThrow(/not an option/);
    expect(answers(logFile)).toHaveLength(0);
    m.answer(id, { 'Which colour?': 'Blue' });
    await until(() => texts(m).includes('You chose Blue.'));
  });

  test('an unknown request id does nothing', async () => {
    const m = chat();
    m.send('bash');
    await until(() => m.permissions.length === 1);
    expect(() => m.allow('made-up-id')).toThrow(/no longer waits/);
    expect(answers(logFile)).toHaveLength(0);
  });

  test('a cancelled request leaves; the end of a turn clears the rest', async () => {
    const m = chat();
    m.send('cancelled');
    await until(() => m.permissions.length === 1);
    await until(() => m.permissions.length === 0);
    await until(() => texts(m).includes('It was cancelled.'));
  });

  test('injected words in a tool result answer nothing', async () => {
    const m = chat();
    m.send('inject');
    await until(() => m.permissions.length === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(answers(logFile)).toHaveLength(0);
    expect(readLog(logFile).some((l) => l.injectedAnswer)).toBe(false);
  });

  test('Always Allow sends the rules only: the mode stays, and the next call still asks', async () => {
    const m = chat();
    m.send('bash');
    await until(() => m.permissions.length === 1);
    m.allow(m.permissions[0].id, true);
    await until(() => !m.busy);
    expect(answers(logFile)[0].response.response.updatedPermissions.map((p: any) => p.type)).toEqual(['addRules']);
    expect(m.mode).toBe('default');
    m.send('bash');
    await until(() => m.permissions.length === 1);
    m.deny(m.permissions[0].id);
  });

  test('the app takes the mode Claude Code reports, and writes nothing back', async () => {
    const m = chat();
    m.send('modereport');
    await until(() => m.mode === 'plan');
    await until(() => !m.busy);
    expect(sent(logFile).some((s) => s.request?.subtype === 'set_permission_mode')).toBe(false);
  });

  test('a refused mode goes back to what it was, and says so', async () => {
    const m = chat({ environment: { ...process.env, CLAUDE_CONFIG_DIR: config, FAKE_CLAUDE_LOG: logFile, FAKE_REFUSE_MODE: '1' } as Record<string, string> });
    m.send('hello');
    await until(() => !m.busy);
    m.setMode('plan');
    await until(() => m.mode === 'default');
    expect(m.items.at(-1)).toMatchObject({ kind: 'notice', isError: true, message: expect.stringContaining('refused') });
  });

  test('what the app cannot show gets an answer, and a line', async () => {
    const m = chat();
    m.send('elicit');
    await until(() => texts(m).includes('Asked for two things.'));
    await until(() => answers(logFile).length === 2);
    expect(answers(logFile)[0].response.response).toEqual({ action: 'cancel' });
    expect(answers(logFile)[1].response.subtype).toBe('error');
    expect(m.items.some((i: any) => i.kind === 'notice' && /terminal/.test(i.message))).toBe(true);
  });

  test('a turn that fails says its first error; a retry shows while it waits', async () => {
    const m = chat();
    m.send('errors');
    await until(() => !m.busy);
    expect(m.items.at(-1)).toMatchObject({ kind: 'notice', isError: true, message: 'made-up api error' });
    m.send('retry');
    await until(() => /attempt 2 of 10/.test(m.status ?? ''));
    await until(() => texts(m).includes('It went through.'));
    await until(() => m.status === null);
  });

  test('a second message: the turn after the first counts as work, and Stop still shows', async () => {
    const m = chat();
    m.send('hello');
    m.send('slow');
    await until(() => m.items.some((i) => i.kind === 'done'));
    await until(() => m.busy && texts(m).some((t) => t.startsWith('step')));
    m.stopTurn();
    await until(() => !m.busy);
  });

  test('Stop that gets no answer ends the program, and the next message resumes', async () => {
    const m = chat({ stopGraceMs: 300 });
    m.send('stubborn');
    await until(() => texts(m).length > 0);
    const session = m.session;
    m.stopTurn();
    await until(() => !m.busy);
    expect(m.items.at(-1)).toMatchObject({ kind: 'notice', message: expect.stringContaining('did not stop') });
    m.send('again');
    await until(() => starts(logFile).length === 2);
    expect(starts(logFile)[1].argv.join(' ')).toContain(`--resume ${session}`);
  });

  test('the end of a chat ends what its program started', async () => {
    const m = chat();
    m.send('child');
    await until(() => readLog(logFile).some((l) => l.childPid));
    const { childPid } = readLog(logFile).find((l) => l.childPid);
    m.terminate();
    await until(() => {
      try { process.kill(childPid, 0); return false; } catch { return true; }
    });
  });

  test("Claude's words do not take a command away", async () => {
    const m = chat();
    m.send('words');
    await until(() => !m.busy);
    expect(m.items.at(-1)).toMatchObject({ kind: 'needsTerminal', command: 'compact' });
    m.send('/compact');
    await until(() => sent(logFile).some((s) => s.type === 'user' && s.message.content === '/compact'));
  });

  test('send says when nothing went, so the window keeps the words', () => {
    expect(chat({ isTrusted: () => false }).send('hello')).toBe(false);
    expect(chat({ binary: () => null }).send('hello')).toBe(false);
    const m = chat();
    expect(m.send('/plan')).toBe(true);
    expect(m.send('hello')).toBe(true);
  });

  test('an answer for several choices names only options; the same question twice can finish', async () => {
    const m = chat();
    m.send('multi');
    await until(() => m.permissions.length === 1);
    expect(() => m.answer(m.permissions[0].id, { 'Which ones?': 'Red, Purple' })).toThrow(/not an option/);
    m.answer(m.permissions[0].id, { 'Which ones?': 'Red, Green' });
    await until(() => texts(m).includes('You chose Red, Green.'));
  });

  test('a folder reached by a link shows its history: Claude Code names it by the real path', async () => {
    test.skip(!posix, 'a link needs a right that the Windows runner may not give');
    const link = path.join(dir, 'link-to-project');
    symlinkSync(folder, link);
    const first = chat();
    first.send('hello');
    await until(() => !first.busy);
    const session = first.session!;
    first.terminate();
    const again = chat({ folder: link, resuming: session });
    await until(() => !again.loadingHistory);
    expect(again.items.map((i: any) => i.text)).toContain('hello');
    expect((await recentSessions(link, config)).map((s) => s.id)).toContain(session);
  });

  test('Stop interrupts the turn', async () => {
    const m = chat();
    m.send('slow');
    await until(() => texts(m).length > 0);
    m.stopTurn();
    await until(() => !m.busy);
    expect(sent(logFile).some((s) => s.request?.subtype === 'interrupt')).toBe(true);
  });

  test('Auto needs the person check by every road: a chained command is no way round it', () => {
    let asked = 0;
    const refuse = () => { asked += 1; throw new Error('Auto mode needs a click or a key in this window.'); };
    for (const text of ['/auto', '/auto a task', '/plan /auto', '/ask /auto x', '/accept-edits /auto x', '/plan /ask /accept-edits /auto y']) {
      const m = chat({ confirmAuto: refuse });
      const before = asked;
      expect(() => m.send(text), text).toThrow(/Auto mode needs/);
      expect(m.mode, text).not.toBe('auto');
      expect(asked, text).toBe(before + 1);
    }
    const direct = chat({ confirmAuto: refuse });
    expect(() => direct.setMode('auto')).toThrow(/Auto mode needs/);
    expect(direct.mode).not.toBe('auto');
    // Other modes never ask.
    const before = asked;
    direct.setMode('plan');
    direct.setMode('default');
    expect(asked).toBe(before);
    // A card's Build on Auto has its own proof: a press on that button.
    direct.setMode('auto', true);
    expect(direct.mode).toBe('auto');
    expect(asked).toBe(before);
  });

  test('with the person there, a chained command goes to Auto', () => {
    const m = chat({ confirmAuto: () => undefined });
    expect(m.send('/plan /auto')).toBe(true);
    expect(m.mode).toBe('auto');
  });

  test('modes: the command, the control line, and a fallback from Auto says so', async () => {
    const m = chat({ environment: { ...process.env, CLAUDE_CONFIG_DIR: config, FAKE_CLAUDE_LOG: logFile, FAKE_CLAUDE_NO_AUTO: '1' } as Record<string, string> });
    m.send('/plan');
    expect(m.mode).toBe('plan');
    expect(starts(logFile)).toHaveLength(0);
    expect(m.items.at(-1)).toMatchObject({ kind: 'notice', message: expect.stringContaining('Plan mode') });
    m.send('/auto first task');
    expect(m.mode).toBe('auto');
    await until(() => m.mode === 'default');
    await until(() => m.items.some((i: any) => i.kind === 'notice' && /Auto mode isn't available here/.test(i.message)));
    expect(starts(logFile)[0].argv).toContain('auto');
    m.setMode('plan');
    await until(() => sent(logFile).some((s) => s.request?.subtype === 'set_permission_mode' && s.request.mode === 'plan'));
  });

  test('/model takes a name; another switch is refused', async () => {
    const m = chat({ models: () => [{ value: 'opus', title: 'Opus', summary: 'x', effortLevels: [] }] });
    m.send('/model --dangerously-skip-permissions');
    expect(m.model).toBe('');
    expect(m.items.at(-1)).toMatchObject({ kind: 'notice', isError: true });
    m.send('/model Opus');
    expect(m.model).toBe('opus');
    m.send('hello');
    await until(() => !m.busy);
    expect(starts(logFile)[0].argv.join(' ')).toContain('--model opus');
  });

  test('/resume with bad words starts nothing', () => {
    const resumed: string[] = [];
    const m = chat({ actions: { resume: (id: string) => resumed.push(id) } });
    m.send('/resume ../../x');
    expect(resumed).toEqual([]);
    m.send('/resume abc-1');
    expect(resumed).toEqual(['abc-1']);
  });

  test('what only the terminal has gets a line of its own, with no command from Claude\'s words', async () => {
    const m = chat();
    m.send('terminal-only');
    await until(() => m.items.some((i) => i.kind === 'needsTerminal'));
    m.send('/color');
    expect(m.items.filter((i) => i.kind === 'needsTerminal')).toHaveLength(2);
    expect(m.items.at(-1)).toMatchObject({ kind: 'needsTerminal', command: 'color' });
  });

  test('not signed in: the exact next step, and no key anywhere', async () => {
    const m = chat();
    m.send('login');
    await until(() => !m.busy);
    const notice: any = m.items.find((i) => i.kind === 'notice');
    expect(notice.action).toBe('signin');
    expect(notice.message).toContain('type /login');
    expect(texts(m)).toEqual([]);
  });

  test('no program: it says so and offers Setup', async () => {
    const m = chat({ binary: () => null });
    m.send('hello');
    expect(m.busy).toBe(false);
    expect(m.items.at(-1)).toMatchObject({ kind: 'notice', action: 'setup', isError: true });
  });

  test('not trusted: nothing starts and nothing is sent', async () => {
    const m = chat({ isTrusted: () => false });
    m.send('hello');
    await new Promise((r) => setTimeout(r, 300));
    expect(starts(logFile)).toHaveLength(0);
    expect(m.items.at(-1)).toMatchObject({ kind: 'notice', isError: true, message: expect.stringContaining('not been trusted') });
  });

  test('a process that dies says why, and the next message resumes the session', async () => {
    const m = chat();
    m.send('hello');
    await until(() => !m.busy);
    const session = m.session!;
    m.send('die');
    await until(() => !m.busy);
    expect(m.items.at(-1)).toMatchObject({ kind: 'notice', isError: true, message: 'made-up failure text' });
    m.send('again');
    await until(() => starts(logFile).length === 2);
    expect(starts(logFile)[1].argv.join(' ')).toContain(`--resume ${session}`);
  });

  test('a chat made from a session shows its history, starts nothing and sends nothing', async () => {
    const first = chat();
    first.send('hello');
    await until(() => !first.busy);
    const session = first.session!;
    first.terminate();
    const before = starts(logFile).length;
    const sentBefore = sent(logFile).length;
    const again = chat({ resuming: session });
    await until(() => !again.loadingHistory);
    expect(again.items.map((i: any) => i.text)).toEqual(['hello', 'Hello from **fake** Claude']);
    expect(again.title).toBe('hello');
    expect(starts(logFile).length).toBe(before);
    expect(sent(logFile).length).toBe(sentBefore);
    again.send('more');
    await until(() => starts(logFile).length === before + 1);
    expect(starts(logFile).at(-1).argv.join(' ')).toContain(`--resume ${session}`);
  });

  test('recent sessions: the newest first, titled by what was asked', async () => {
    const first = chat();
    first.send('first question');
    await until(() => !first.busy);
    first.terminate();
    const second = chat();
    second.send('/plan');
    second.setMode('default');
    second.send('second question');
    await until(() => !second.busy);
    const sessions = await recentSessions(folder, config);
    expect(sessions.map((s) => s.title).sort()).toEqual(['first question', 'second question']);
    expect(sessions[0].date).toBeGreaterThan(0);
  });

  test('attachments: an image goes as an image, a file by its path', async () => {
    const m = chat();
    m.attachments = [
      { id: 'a', kind: 'image', name: 'p.png', mediaType: 'image/png', data: 'QUJD' },
      { id: 'b', kind: 'file', name: 'notes.txt', path: path.join(folder, 'notes.txt') },
    ];
    m.send('images here');
    await until(() => texts(m).includes('I got 1 image(s).'));
    const line = sent(logFile).find((s) => s.type === 'user');
    expect(line.message.content[1].text).toBe(`images here\n\nAttached files:\n- ${path.join(folder, 'notes.txt')}`);
    expect(m.attachments).toEqual([]);
    expect(m.items[0]).toMatchObject({ kind: 'attachments', files: ['notes.txt'] });
  });

  test('terminate ends the process, and a late event changes nothing', async () => {
    const m = chat();
    m.send('slow');
    await until(() => texts(m).length > 0);
    const { pid } = starts(logFile)[0];
    m.terminate();
    await until(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    });
    expect(m.busy).toBe(false);
  });
});

test('chat: the guide says how, and each step is one action under 20 words', () => {
  const read = (name: string) => readFileSync(path.join(__dirname, '..', name), 'utf8');
  const guide = read('INSTALL-WINDOWS.md');
  const part = guide.slice(guide.indexOf('## Step 6. Use the Claude chat'), guide.indexOf('## Step 7.'));
  for (const words of ['Check Again', '/login', 'Allow', 'New Claude Chat']) expect(part, words).toContain(words);
  for (const step of part.split('\n').filter((l) => /^\d+\. /.test(l))) expect(step.replace(/^\d+\. /, '').split(/\s+/).length, step).toBeLessThan(20);
  const check = read('WINDOWS-FIRST-RUN.md');
  expect(check).toContain('## The Claude chat');
  const readme = read('README.md');
  expect(readme.slice(readme.indexOf('## What is left out'), readme.indexOf('## What is unproven'))).not.toContain('Native Claude chat');
  expect(readme).toContain('## Native Claude chat');
});

test('chat: the real Claude Code still has the switches the chat passes', () => {
  // Only --help, with an empty config: no sign-in and no model. The fence installs the program for this.
  test.skip(!process.env.VIBEX_EXPECT_CLAUDE, 'needs the program, on the fence');
  const config = tempDir('vibex-chat-help-');
  const help = execFileSync('claude', ['--help'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config } });
  rmSync(config, { recursive: true, force: true });
  for (const flag of ['--input-format', '--output-format', '--include-partial-messages', '--permission-prompt', '--permission-mode', '--resume', '--model', '--verbose']) expect(help).toContain(flag);
});

// ------------------------------------------------------------------ the app

test.describe('chat in the app', () => {
  let app: ElectronApplication;
  let page: Page;
  let dir: string;
  let folder: string;
  let config: string;
  let logFile: string;
  const closers: (() => void)[] = [];

  /// A trusted project, unless the test says no.
  async function launch(options: { trusted?: boolean; env?: Record<string, string>; chatDefault?: boolean } = {}): Promise<void> {
    dir = realpathSync.native(tempDir('vibex-chat-'));
    folder = path.join(dir, 'made-up-project');
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'readme.txt'), 'made-up\n');
    mkdirSync(path.join(folder, 'src'));
    writeFileSync(path.join(folder, 'src', 'main.ts'), '// made-up\n');
    config = path.join(dir, 'cfg');
    mkdirSync(config);
    logFile = path.join(dir, 'log.jsonl');
    // As Claude Code writes it: forward slashes on Windows too.
    const projects = options.trusted === false ? {} : { [folder.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } };
    writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ projects }));
    const fake = makeFakeBin(dir);
    const env = {
      ...process.env,
      PATH: posix ? `${path.dirname(fake)}${path.delimiter}${process.env.PATH}` : process.env.PATH,
      VIBEX_TEST: '1',
      VIBEX_USER_DATA: path.join(dir, 'data'),
      VIBEX_MCP_PORT: '0',
      CLAUDE_CONFIG_DIR: config,
      FAKE_CLAUDE_LOG: logFile,
      ...(process.platform === 'darwin' ? { VIBEX_TOKEN_STORE: 'memory' } : {}),
      ...options.env,
    } as Record<string, string>;
    delete env.VIBEX_AGENT_COMMAND;
    // These tests are about the chat, so a Claude tab is one here. What a person gets today has its own test below.
    if (options.chatDefault !== false) env.VIBEX_CHAT_DEFAULT = '1';
    // Windows: the runner holds a real claude.exe, and a terminal Claude tab here must not start it.
    if (!posix) Object.assign(env, { VIBEX_CHAT_BIN: fake, VIBEX_CHAT_SCRIPT: FAKE, VIBEX_AGENT_COMMAND: 'Write-Host made-up-terminal' });
    const executablePath = process.env.VIBEX_APP_EXECUTABLE;
    app = await electron.launch(executablePath ? { executablePath, env } : { args: ['.'], cwd: path.join(__dirname, '..'), env });
    page = await firstWindow(app);
    await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
    await page.evaluate((f) => (window as any).vibex.projects.open(f), folder);
    await expect(options.chatDefault === false ? pane().locator('.term.active .xterm') : chatOn()).toBeVisible({ timeout: 20_000 });
  }

  test.afterEach(async () => {
    // A test may have left the close question on with a stand-in that says Cancel; a close must not hang on it.
    await app?.evaluate(() => { (globalThis as any).__vibexTest.askOnClose = false; }).catch(() => undefined);
    await app?.close();
    for (const close of closers.splice(0)) close();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /// A key as the system gives it: through the window, so main's before-input-event sees it. Playwright's keyboard goes in behind that.
  const realKey = (keyCode: string, modifiers: string[] = []) => app.evaluate(({ BrowserWindow }, [key, mods]) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: key as string, modifiers: mods as any });
    wc.sendInputEvent({ type: 'char', keyCode: key as string, modifiers: mods as any });
    wc.sendInputEvent({ type: 'keyUp', keyCode: key as string, modifiers: mods as any });
  }, [keyCode, modifiers] as const);
  const shortcutMod = process.platform === 'darwin' ? 'meta' : 'control';

  const pane = () => page.locator('.terminal-pane[data-pane="agent"]');
  const chatOn = () => pane().locator('.term.active.chat-surface');
  const input = () => chatOn().locator('.chat-input');
  const say = async (text: string) => {
    await input().fill(text);
    await input().press('Enter');
  };
  const items = (kind: string) => chatOn().locator(`.chat-item[data-kind="${kind}"]`);
  const lastText = () => items('text').last();
  const clickMenu = (label: string) => app.evaluate(({ Menu }, wanted) => {
    const find = (m: Electron.Menu | null): Electron.MenuItem | undefined => {
      for (const i of m?.items ?? []) {
        if (i.label === wanted) return i;
        const inner = find(i.submenu ?? null);
        if (inner) return inner;
      }
      return undefined;
    };
    find(Menu.getApplicationMenu())!.click();
  }, label);

  test('today a new Claude tab is a terminal, and the chat is one click away: a button, the menu, the palette', async () => {
    await launch({ chatDefault: false });
    await expect(pane().locator('.tab:visible')).toHaveCount(1);
    await expect(pane().locator('.term.active.chat-surface')).toHaveCount(0);
    await pane().locator('.new-tab').click();
    await expect(pane().locator('.tab:visible')).toHaveCount(2);
    await expect(pane().locator('.term.active .xterm')).toBeVisible();

    const button = pane().locator('.new-chat');
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-label', 'New Claude Chat');
    await button.click();
    await expect(chatOn()).toBeVisible();
    await expect(pane().locator('.tab:visible')).toHaveCount(3);

    await clickMenu('New Claude Chat');
    await expect(pane().locator('.tab:visible')).toHaveCount(4);
    await expect(chatOn()).toBeVisible();

    await realKey('P', [shortcutMod, 'shift']);
    await page.locator('#palette-input').fill('New Claude Chat');
    await expect(page.locator('.palette-row').first()).toContainText('New Claude Chat');
    await page.keyboard.press('Escape');
  });

  test('the Attach dialog picks files on every system: no folder picker', async () => {
    await launch();
    await app.evaluate(({ dialog }) => {
      (dialog as any).showOpenDialog = async (...args: any[]) => {
        (globalThis as any).__picked = args.at(-1);
        return { canceled: true, filePaths: [] };
      };
    });
    await chatOn().locator('.chat-attach').click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).__picked?.properties)).toEqual(['openFile', 'multiSelections']);
  });

  test('a heading with U+2028 does not freeze the window', async () => {
    await launch();
    await say('sep');
    await expect(lastText().locator('h2')).toContainText('a');
    await say('files after it');
    await expect(lastText()).toHaveText('You said: files after it');
  });

  test('raising the mode to Auto needs a person, as an answer does', async () => {
    await launch();
    const set = (mode: string) => page.evaluate(async ([m]) => {
      const api = (window as any).vibex;
      const tab = (await api.term.list()).find((t: any) => t.chat);
      return api.mod.invoke('mod:chat:mode', tab.id, m).then(() => 'set', () => 'refused');
    }, [mode]);
    const sendAuto = () => page.evaluate(async () => {
      const api = (window as any).vibex;
      const tab = (await api.term.list()).find((t: any) => t.chat);
      return api.mod.invoke('mod:chat:send', tab.id, '/auto').then(() => 'sent', () => 'refused');
    });
    const mode = chatOn().locator('.chat-mode');
    await page.waitForTimeout(3500);
    expect(await set('auto')).toBe('refused');
    expect(await sendAuto()).toBe('refused');
    await expect(mode).toHaveText('Ask');
    // Going down needs nothing; going up by a person's hand works.
    expect(await set('plan')).toBe('set');
    await expect(mode).toHaveText('Plan');
    await mode.click();
    await page.locator('.chat-popup .chat-popup-row', { hasText: 'Auto' }).click();
    await expect(mode).toHaveText('Auto');
  });

  test('a chained /plan /auto with no person there does not reach Auto', async () => {
    await launch();
    const mode = chatOn().locator('.chat-mode');
    const tab = Number(await chatOn().getAttribute('data-tab'));
    // Older than the time a recent click or key counts for.
    await page.waitForTimeout(2200);
    const said = await page.evaluate((id) => (window as any).vibex.mod.invoke('mod:chat:send', id, '/plan /auto').then(() => 'sent', (error: Error) => error.message), tab);
    expect(said).toMatch(/Auto mode needs/);
    await expect(mode).not.toHaveText('Auto');
  });

  test('a command with a bidi control shows the mark, and Allow and Ctrl+Return stay off', async () => {
    await launch();
    await say('bidibash');
    const card = chatOn().locator('.chat-card');
    await expect(card.locator('.chat-card-body')).toContainText('<U+202E>');
    await expect(card.locator('.chat-card-warning')).toContainText('U+202E');
    await expect(card.locator('.chat-deny')).toBeEnabled();
    await expect(card.locator('.chat-allow')).toBeDisabled();
    await input().focus();
    await realKey('Enter', [shortcutMod]);
    await expect(card.locator('.chat-card-problem')).toContainText('U+202E');
    expect(answers(logFile)).toHaveLength(0);
    await card.locator('.chat-deny').click();
    await expect(chatOn().locator('.chat-card')).toHaveCount(0);
  });

  test('a command longer than the box: Allow is off until the person scrolled to its end, and the key waits too', async () => {
    await launch();
    await say('longbash');
    const card = chatOn().locator('.chat-card');
    await expect(card.locator('.chat-deny')).toBeEnabled();
    await expect(card.locator('.chat-allow')).toBeDisabled();
    await expect(card.locator('.chat-card-hint')).toContainText('end');
    await input().focus();
    await realKey('Enter', [shortcutMod]);
    await expect(card.locator('.chat-card-problem')).toContainText('read to the end');
    expect(answers(logFile)).toHaveLength(0);
    await card.locator('.chat-card-body').evaluate((box) => { box.scrollTop = box.scrollHeight; });
    await expect(card.locator('.chat-allow')).toBeEnabled();
    await expect(card.locator('.chat-card-hint')).toBeHidden();
    await input().focus();
    await realKey('Enter', [shortcutMod]);
    await expect.poll(() => answers(logFile).length).toBe(1);
  });

  test('a command beyond the card: Show All brings the rest, and Allow waits for the end of that', async () => {
    await launch();
    await say('hugebash');
    const card = chatOn().locator('.chat-card');
    await expect(card.locator('.chat-deny')).toBeEnabled();
    await expect(card.locator('.chat-card-body')).not.toContainText('hidden-at-the-end');
    await expect(card.locator('.chat-allow')).toBeDisabled();
    await card.locator('.chat-card-body').evaluate((box) => { box.scrollTop = box.scrollHeight; });
    await expect(card.locator('.chat-allow')).toBeDisabled();
    await card.locator('.chat-show-all').click();
    await expect(card.locator('.chat-card-body')).toContainText('hidden-at-the-end');
    await expect(card.locator('.chat-show-all')).toHaveCount(0);
    await expect(card.locator('.chat-allow')).toBeDisabled();
    await card.locator('.chat-card-body').evaluate((box) => { box.scrollTop = box.scrollHeight; });
    await expect(card.locator('.chat-allow')).toBeEnabled();
    await card.locator('.chat-deny').click();
    await expect(chatOn().locator('.chat-card')).toHaveCount(0);
  });

  test('Ctrl+Return with words in the box does not allow a card', async () => {
    await launch();
    await say('bash');
    const card = chatOn().locator('.chat-card');
    await expect(card.locator('.chat-allow')).toBeEnabled();
    await input().fill('a task for an agent');
    await input().focus();
    await realKey('Enter', [shortcutMod]);
    await expect(card.locator('.chat-card-problem')).toContainText('Empty the box');
    expect(answers(logFile)).toHaveLength(0);
    await expect(input()).toHaveValue('a task for an agent');
  });

  test('a question of several choices has a Done; the same question twice can finish', async () => {
    await launch();
    await say('multi');
    const card = chatOn().locator('.chat-card');
    await card.getByRole('button', { name: /^Red/ }).click();
    await card.getByRole('button', { name: /^Green/ }).click();
    expect(answers(logFile)).toHaveLength(0);
    await card.locator('.chat-opt-done').click();
    await expect(lastText()).toHaveText('You chose Red, Green.');

    await say('dup');
    await card.locator('.chat-opt[data-opt="1-1"]').click();
    await expect(lastText()).toHaveText('You chose No.');
  });

  test('a plan with no text says so, and shows what it has', async () => {
    await launch();
    await say('emptyplan');
    const card = chatOn().locator('.chat-card');
    await expect(card).toContainText('sent no plan text');
    await expect(card).toContainText('/made-up/plan.md');
    await card.locator('.chat-keep-planning').click();
    await expect(lastText()).toHaveText('Planning more.');
  });

  test('words that could not go stay in the box', async () => {
    await launch({ trusted: false });
    await say('my long question');
    await expect(items('notice').first()).toContainText('not been trusted');
    await expect(input()).toHaveValue('my long question');
  });

  test('a new Claude tab is a chat where the switch says so, named after the project; a terminal Claude tab is one command away', async () => {
    await launch();
    await expect(pane().locator('.tab:visible')).toHaveCount(1);
    await expect(pane().locator('.tab:visible .label')).toHaveText('made-up-project - Claude');
    await expect(chatOn().locator('.chat-empty')).toBeVisible();
    await expect(chatOn().locator('.xterm')).toHaveCount(0);
    await pane().locator('.new-tab').click();
    await expect(pane().locator('.tab:visible')).toHaveCount(2);
    await expect(chatOn()).toBeVisible();

    await clickMenu('New Claude Terminal Tab');
    await expect(pane().locator('.tab:visible')).toHaveCount(3);
    await expect(pane().locator('.term.active .xterm')).toBeVisible();
    const list = await page.evaluate(() => (window as any).vibex.term.list());
    expect(list.filter((t: any) => t.pane === 'agent').map((t: any) => !!t.chat)).toEqual([true, true, false]);

    await realKey('P', [shortcutMod, 'shift']);
    await page.locator('#palette-input').fill('New Claude');
    await expect(page.locator('.palette-row')).toHaveCount(2);
    await expect(page.locator('.palette-list')).toContainText('New Claude Tab');
    await expect(page.locator('.palette-list')).toContainText('New Claude Terminal Tab');
    await page.keyboard.press('Escape');
  });

  test('a reply streams, renders as Markdown, and the tab takes the first question as its name', async () => {
    await launch();
    await say('hello');
    await expect(items('user')).toHaveText('hello');
    await expect(lastText().locator('strong')).toHaveText('fake');
    await expect(lastText()).toContainText('Hello from fake Claude');
    await expect(items('done')).toContainText('Finished in 2s');
    await expect(pane().locator('.tab:visible .label')).toHaveText('made-up-project - hello');
    await expect(input()).toHaveValue('');
    await expect(input()).toBeFocused();
    expect(starts(logFile).filter((s) => s.argv.includes('--resume'))).toHaveLength(0);
    const titles = await page.evaluate(() => (window as any).vibex.term.list());
    expect(titles[0].title).toBe('made-up-project - hello');
  });

  test('Markdown is safe: a script tag and a javascript: link do nothing', async () => {
    const site = await startSite();
    closers.push(site.close);
    await launch({ env: { FAKE_SITE: site.url } });
    await say('xss');
    await expect(lastText().locator('table td').first()).toHaveText('Made-up');
    await expect(lastText()).toContainText('<script>window.__xss=1</script>');
    await expect(lastText().locator('script, img, iframe')).toHaveCount(0);
    await expect(lastText().locator('code').first()).toHaveText('<b>code</b>');
    // The bad link is plain words and goes nowhere; the good one is a link that opens in the side browser only.
    await expect(lastText().locator('a')).toHaveCount(1);
    await expect(lastText().locator('a')).toHaveText('good link');
    await expect(lastText()).toContainText('bad link');
    await lastText().getByText('bad link').click();
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
    expect(page.url()).toContain('vibex-app');
    await lastText().locator('a').click();
    await expect.poll(() => page.evaluate(async () => (await (window as any).vibex.browser.state()).url)).toContain(new URL(site.url).host);
  });

  test('tool cards say what Claude acted on; typed text stays out; a screenshot shows', async () => {
    await launch();
    await say('tools');
    await expect(lastText()).toHaveText('All five ran.');
    const tools = items('tool');
    await expect(tools).toHaveCount(5);
    await expect(tools.nth(0).locator('.chat-tool-title')).toHaveText('Read readme.txt');
    await expect(tools.nth(1).locator('.chat-tool-title')).toHaveText('Browser: click “Pay now”');
    await expect(tools.nth(2).locator('.chat-tool-title')).toHaveText('Browser: type');
    await expect(chatOn()).not.toContainText('made-up-password');
    await expect(tools.nth(3)).toHaveClass(/failed/);
    await expect(tools.nth(4).locator('img')).toBeVisible();
    await tools.nth(0).locator('.chat-tool-head').click();
    await expect(tools.nth(0)).toContainText('readme text');
    await tools.nth(0).locator('.chat-tool-head').click();
    await expect(tools.nth(0)).not.toContainText('readme text');
  });

  test('an approval: the card shows the command, a real click allows it, and the tool card waits behind it', async () => {
    await launch();
    await say('bash');
    const card = chatOn().locator('.chat-card');
    await expect(card).toContainText('Claude wants to run');
    await expect(card).toContainText('echo made-up');
    await expect(card).toContainText('description');
    // The tool card waits behind the approval.
    await expect(items('tool')).toBeHidden();
    await card.locator('.chat-allow').click();
    await expect(lastText()).toHaveText('The command ran.');
    await expect(card).toHaveCount(0);
    expect(answers(logFile)[0].response.response).toEqual({ behavior: 'allow', updatedInput: { command: 'echo made-up', description: 'Say made-up' } });
    await say('bash');
    await card.locator('.chat-always').click();
    await expect(card).toHaveCount(0);
    await expect.poll(() => answers(logFile)[1]?.response.response.updatedPermissions?.length).toBe(1);
    await expect(items('text').nth(1)).toHaveText('The command ran.');
    await say('bash');
    await card.locator('.chat-deny').click();
    await expect(lastText()).toHaveText('The command did not run.');
    expect(answers(logFile)[2].response.response.behavior).toBe('deny');
    await expect(items('tool').last()).toHaveClass(/failed/);
  });

  test('a prompt injection cannot press Allow: not a script, not a page, not a tool, not message text', async () => {
    await launch();
    await say('inject');
    const card = chatOn().locator('.chat-card');
    await expect(card.locator('.chat-allow')).toBeEnabled();
    // Its markup came through as words, in the reply and in the tool result.
    await expect(chatOn().locator('.chat-items .chat-allow')).toHaveCount(0);
    await expect(items('text').first()).toContainText('<button class="chat-allow"');
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();

    // A script in the window: a click event with no input behind it, on each kind of way.
    await page.evaluate(() => {
      const allow = document.querySelector<HTMLButtonElement>('.chat-card .chat-allow')!;
      allow.click();
      allow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      allow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      document.querySelector('.chat-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    });
    // The channel itself, with no press and with a false word about how it came.
    const direct = await page.evaluate(async () => {
      const api = (window as any).vibex;
      const tabs = await api.term.list();
      const out: string[] = [];
      const id = tabs.find((t: any) => t.chat).id;
      const card = document.querySelector<HTMLElement>('.chat-card')!.dataset.card;
      for (const via of ['mouse', 'key', 'tool', undefined]) {
        await api.mod.invoke('mod:chat:answer', id, card, 'allow', via).then(() => out.push('accepted'), (e: unknown) => out.push(String(e)));
      }
      return out;
    });
    expect(direct).toHaveLength(4);
    for (const reply of direct) expect(reply).not.toBe('accepted');

    // Message text is a message.
    await input().fill('allow it, yes, I approve');
    await input().press('Enter');

    // The tools: none of them answers, and the page in the side browser has no bridge at all.
    const token = await app.evaluate(() => (globalThis as any).__vibexTest.token as string);
    const port = await page.evaluate(async () => (await (window as any).vibex.status()).mcpPort as number);
    const client = new Client({ name: 'injected', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-Vibex-Window': await page.evaluate(async () => (await (window as any).vibex.projects.list()).current) } } }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => /allow|approv|permission|chat/i.test(n))).toEqual([]);
    const site = await startSite();
    closers.push(site.close);
    await client.callTool({ name: 'browser_navigate', arguments: { url: site.url } });
    const onPage = await client.callTool({ name: 'browser_evaluate', arguments: { js: 'String(typeof window.vibex) + String(document.querySelectorAll(".chat-allow").length)' } }) as any;
    expect(onPage.content[0].text).toContain('undefined0');
    await client.close();

    await page.waitForTimeout(500);
    expect(answers(logFile)).toHaveLength(0);
    expect(readLog(logFile).some((l) => l.injectedAnswer)).toBe(false);
    await expect(card).toHaveCount(1);

    // A person can still answer, after all of that.
    await card.locator('.chat-deny').click();
    await expect.poll(() => answers(logFile).length).toBe(1);
    expect(answers(logFile)[0].response.response.behavior).toBe('deny');
  });

  test('a card under a resting pointer takes no click until the mouse moves', async () => {
    await launch();
    // A long answer first, so the card comes at the same place each time: the end of the column.
    await say('long');
    await expect(items('text')).toHaveCount(80);
    await say('bash');
    const allow = chatOn().locator('.chat-card .chat-allow');
    await expect(allow).toBeEnabled();
    const first = (await allow.boundingBox())!;
    const rest = { x: first.x + first.width / 2, y: first.y + first.height / 2 };
    await allow.click();
    await expect.poll(() => answers(logFile).length).toBe(1);
    await expect(allow).toHaveCount(0);
    await say('bash');
    await expect(allow).toBeEnabled();
    const box = (await allow.boundingBox())!;
    expect(rest.x).toBeGreaterThanOrEqual(box.x);
    expect(rest.x).toBeLessThanOrEqual(box.x + box.width);
    expect(rest.y).toBeGreaterThanOrEqual(box.y);
    expect(rest.y).toBeLessThanOrEqual(box.y + box.height);
    // The same spot, with no move since the card came: the press is real and still does not count.
    await page.mouse.down();
    await page.mouse.up();
    await expect(chatOn().locator('.chat-card-problem')).toContainText('Move the pointer');
    expect(answers(logFile)).toHaveLength(1);
    await page.mouse.move(rest.x + 2, rest.y);
    await allow.click();
    await expect.poll(() => answers(logFile).length).toBe(2);
  });

  test('the keyboard: a real Ctrl+Enter answers, as the Swift shortcut does', async () => {
    await launch();
    await say('bash');
    const card = chatOn().locator('.chat-card');
    await expect(card.locator('.chat-allow')).toBeEnabled();
    await input().focus();
    await realKey('Enter', [shortcutMod]);
    await expect(lastText()).toHaveText('The command ran.');
    expect(answers(logFile)[0].response.response.behavior).toBe('allow');
    // Enter on a button that has the keyboard, for a person with no mouse.
    await say('bash');
    await expect(card.locator('.chat-deny')).toBeEnabled();
    await card.locator('.chat-deny').focus();
    await realKey('Enter');
    await expect.poll(() => answers(logFile).length).toBe(2);
    expect(answers(logFile)[1].response.response.behavior).toBe('deny');
    // The same key with the keyboard in the box sends a message, and answers nothing.
    await say('bash');
    await expect(card.locator('.chat-allow')).toBeEnabled();
    await input().fill('words only');
    await input().focus();
    await realKey('Enter');
    await expect(items('user').last()).toHaveText('words only');
    expect(answers(logFile)).toHaveLength(2);
  });

  test('a question and a plan are their own cards', async () => {
    await launch();
    await say('question');
    const card = chatOn().locator('.chat-card');
    await expect(card).toContainText('Which colour?');
    await expect(card).toContainText('The warm one');
    await card.getByRole('button', { name: /^Blue/ }).click();
    await expect(lastText()).toHaveText('You chose Blue.');
    await expect(items('user').last()).toHaveText('Blue');

    await say('plan');
    await expect(card).toContainText("Claude's plan");
    await expect(card.locator('h3')).toHaveText('The plan');
    await card.locator('.chat-build').click();
    await expect(lastText()).toHaveText('Building now.');
    await expect(chatOn().locator('.chat-mode')).toHaveText('Accept edits');
    await expect.poll(() => sent(logFile).some((s) => s.request?.subtype === 'set_permission_mode' && s.request.mode === 'acceptEdits')).toBe(true);

    await say('plan');
    await card.locator('.chat-keep-planning').click();
    await expect(lastText()).toHaveText('Planning more.');
  });

  test('the mode and the model: a menu, a shortcut, and the names Claude Code gives', async () => {
    await launch();
    const mode = chatOn().locator('.chat-mode');
    await expect(mode).toHaveText('Ask');
    await mode.click();
    const rows = page.locator('.chat-popup .chat-popup-row');
    await expect(rows).toHaveCount(4);
    await expect(page.locator('.chat-popup')).toContainText('Reads and proposes a plan, changes nothing');
    await rows.filter({ hasText: 'Plan' }).click();
    await expect(mode).toHaveText('Plan');
    await input().focus();
    await realKey('Tab', ['shift']);
    await expect(mode).toHaveText('Auto');
    await realKey('Tab', ['shift']);
    await expect(mode).toHaveText('Ask');

    const model = chatOn().locator('.chat-model');
    await expect(model).toHaveText('Fake Sonnet 9');
    await model.click();
    await expect(page.locator('.chat-popup')).toContainText('Opus');
    await expect(page.locator('.chat-popup')).toContainText('Older Versions');
    await page.locator('.chat-popup .chat-popup-row', { hasText: 'Opus' }).click();
    await expect(model).toHaveText('Opus');
    await say('hello');
    await expect(items('done')).toBeVisible();
    expect(starts(logFile).at(-1).argv.join(' ')).toContain('--model opus');
    // The first start asks for the catalog; it sends no message.
    expect(sent(logFile).some((s) => s.request?.subtype === 'initialize')).toBe(true);
  });

  test('the composer: slash commands with descriptions, @ files, Escape, Tab and the history', async () => {
    await launch();
    await input().fill('/');
    const rows = chatOn().locator('.chat-suggest-row');
    await expect(rows.first()).toContainText('/plan');
    await input().fill('/pca');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Write a made-up note');
    await input().press('Tab');
    await expect(input()).toHaveValue('/pca-note ');
    await input().press('Escape');
    await input().fill('look at @rea');
    await expect(rows.first()).toContainText('readme.txt');
    await input().press('Enter');
    await expect(input()).toHaveValue('look at @readme.txt ');
    await input().fill('/co');
    await input().press('Escape');
    await expect(rows).toHaveCount(0);

    await input().fill('files one');
    await input().press('Shift+Enter');
    await expect(input()).toHaveValue('files one\n');
    await input().press('Enter');
    await expect(lastText()).toHaveText('You said: files one');
    await say('files two');
    await expect(lastText()).toHaveText('You said: files two');
    await input().press('ArrowUp');
    await expect(input()).toHaveValue('files two');
    await input().press('ArrowUp');
    await expect(input()).toHaveValue('files one');
    await input().press('ArrowDown');
    await input().press('ArrowDown');
    await expect(input()).toHaveValue('');
  });

  test('attachments: picked, shown on a chip, removed, and sent', async () => {
    await launch();
    const png = path.join(folder, 'made-up.png');
    writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    const notes = path.join(folder, 'readme.txt');
    await app.evaluate((_e, paths) => { (globalThis as any).__vibexTest.chatPick = paths; }, [png, notes]);
    await chatOn().locator('.chat-attach').click();
    const chips = chatOn().locator('.chat-chip');
    await expect(chips).toHaveCount(2);
    await chips.nth(1).locator('button').click();
    await expect(chips).toHaveCount(1);
    await say('images look');
    await expect(lastText()).toHaveText('I got 1 image(s).');
    await expect(chips).toHaveCount(0);
    await expect(items('attachments').locator('img')).toBeVisible();

    await app.evaluate((_e, paths) => { (globalThis as any).__vibexTest.chatPick = paths; }, [notes]);
    await chatOn().locator('.chat-attach').click();
    await say('files see');
    await expect(lastText()).toContainText(`Attached files:`);
    await expect(lastText()).toContainText('readme.txt');
  });

  test('a pasted image and a dropped file become attachments', async () => {
    await launch();
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    await page.evaluate((data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
      document.querySelector('.chat-surface.active .chat-input')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
      const drop = new DataTransfer();
      drop.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
      document.querySelector('.chat-surface.active .chat')!.dispatchEvent(new DragEvent('drop', { dataTransfer: drop, bubbles: true, cancelable: true }));
    }, png);
    await expect(chatOn().locator('.chat-chip img')).toHaveCount(2);
    await say('images both');
    await expect(lastText()).toHaveText('I got 2 image(s).');
  });

  test('Stop ends a turn, and the working line goes', async () => {
    await launch();
    await say('slow');
    const stop = chatOn().locator('.chat-stop');
    await expect(stop).toBeVisible();
    await expect(chatOn().locator('.chat-working')).toBeVisible();
    await stop.click();
    await expect(stop).toBeHidden();
    await expect(chatOn().locator('.chat-working')).toBeHidden();
    expect(sent(logFile).some((s) => s.request?.subtype === 'interrupt')).toBe(true);
  });

  test('the context meter shows from 50 %, and a click compacts', async () => {
    await launch({ env: { FAKE_CONTEXT: '85' } });
    await say('hello');
    const meter = chatOn().locator('.chat-context');
    await expect(meter).toHaveText('85% full');
    await meter.click();
    await expect.poll(() => sent(logFile).some((s) => s.type === 'user' && s.message.content === '/compact')).toBe(true);
  });

  test('the tools: the chat\'s Claude reaches Vibex with the header of its own project', async () => {
    await launch();
    const other = path.join(dir, 'other-project');
    mkdirSync(other);
    const token = await app.evaluate(() => (globalThis as any).__vibexTest.token as string);
    await app.evaluate((_e, t) => { process.env.FAKE_CLAUDE_MCP_TOKEN = t; }, token);
    const here = await page.evaluate(async () => (await (window as any).vibex.projects.list()).current as string);
    await page.evaluate((f) => (window as any).vibex.projects.open(f), other);
    await page.evaluate((id) => (window as any).vibex.projects.select(id), here);
    await expect(chatOn()).toBeVisible();
    await say('mcp');
    await expect(lastText()).toHaveText(`The tool answered for ${here}.`);
    const start = starts(logFile).filter((s) => s.argv.includes('stream-json')).at(-1);
    expect(start.env).toMatchObject({ VIBEX_WINDOW: here, VIBEX_PROJECT: folder });
    expect(start.cwd).toBe(folder);
    const answer = readLog(logFile).find((l) => l.mcp).mcp;
    // The terminal tabs of this project, the chat among them; the * marks this project, not the other one.
    expect(answer.tabs).toContain('made-up-project - mcp');
    expect(answer.projects).toMatch(/\* made-up-project/);
    expect(answer.projects).not.toMatch(/\* other-project/);
  });

  test('a chat that waits shows on its tab, on the rail and in the Inbox, and stops when answered', async () => {
    await launch();
    await say('bash');
    const tab = pane().locator('.tab:visible').first();
    await expect(tab).toHaveClass(/waiting/);
    await expect(page.locator('.tile .rail-badge')).toHaveText('1');
    await page.locator('#activity [data-activity="inbox"]').click();
    await expect(page.locator('.inbox-item[data-kind="permission"]')).toContainText('Allow Bash: echo made-up?');
    await chatOn().locator('.chat-card .chat-allow').click();
    await expect(tab).not.toHaveClass(/waiting/);
    await expect(page.locator('.tile .rail-badge')).toHaveCount(0);
    await expect(page.locator('.inbox-item[data-kind="permission"]')).toHaveCount(0);
  });

  test('Close asks only while a chat works; Reopen Closed Tab resumes and sends nothing', async () => {
    await launch();
    await app.evaluate(({ dialog }) => {
      (globalThis as any).__vibexTest.askOnClose = true;
      (globalThis as any).__asked = [];
      (dialog as any).showMessageBox = async (_w: unknown, o: { message: string; detail: string }) => {
        (globalThis as any).__asked.push(o);
        return { response: 1, checkboxChecked: false };
      };
    });
    const asked = () => app.evaluate(() => (globalThis as any).__asked.length as number);
    const closeOn = async () => page.evaluate(async () => {
      const api = (window as any).vibex;
      const tab = (await api.term.list()).find((t: any) => t.chat);
      api.term.close(tab.id);
    });

    await say('slow');
    await expect(chatOn().locator('.chat-stop')).toBeVisible();
    await closeOn();
    await expect.poll(asked).toBe(1);
    const question = await app.evaluate(() => (globalThis as any).__asked[0]);
    expect(question.message).toContain('made-up-project - slow');
    expect(question.detail).toContain('Reopen Closed Tab brings this conversation back');
    await expect(pane().locator('.tab:visible')).toHaveCount(1);
    await chatOn().locator('.chat-stop').click();
    await expect(chatOn().locator('.chat-stop')).toBeHidden();

    // Idle: no question.
    await say('hello');
    await expect(lastText()).toContainText('Hello from');
    await expect(chatOn().locator('.chat-stop')).toBeHidden();
    const { pid } = starts(logFile).filter((s) => s.argv.includes('--verbose')).at(-1);
    const session = await page.evaluate(() => document.querySelector<HTMLElement>('.chat-surface.active')!.dataset.session!);
    const usersBefore = sent(logFile).filter((m) => m.type === 'user').length;
    await closeOn();
    await expect(pane().locator('.tab:visible')).toHaveCount(0);
    expect(await asked()).toBe(1);
    await expect.poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } }).toBe(true);

    await clickMenu('Reopen Closed Tab');
    await expect(chatOn()).toBeVisible();
    await expect(lastText()).toContainText('Hello from');
    await expect(items('user').last()).toHaveText('hello');
    await expect(pane().locator('.tab:visible .label')).toHaveText('made-up-project - slow');
    await page.waitForTimeout(400);
    expect(sent(logFile).filter((m) => m.type === 'user').length).toBe(usersBefore);

    await say('more words');
    await expect(lastText()).toHaveText('You said: more words');
    expect(starts(logFile).at(-1).argv.join(' ')).toContain(`--resume ${session}`);
  });

  test('an empty chat offers what was asked before, and /resume does too', async () => {
    await launch();
    await say('files old question');
    await expect(lastText()).toContainText('You said');
    await pane().locator('.new-tab').click();
    await expect(pane().locator('.tab:visible')).toHaveCount(2);
    const recent = chatOn().locator('.chat-recent');
    await expect(recent).toHaveCount(1);
    await expect(recent).toContainText('files old question');
    await recent.click();
    // The untouched chat gives way to the conversation.
    await expect(pane().locator('.tab:visible')).toHaveCount(2);
    await expect(lastText()).toContainText('You said');
    await pane().locator('.new-tab').click();
    await input().fill('/resume ');
    await expect(chatOn().locator('.chat-suggest-row').first()).toContainText('files old question');
  });

  test('not signed in: the chat says the next step, and the button opens a terminal Claude tab', async () => {
    await launch();
    await say('login');
    const notice = items('notice').first();
    await expect(notice).toContainText('Claude is not signed in on this computer');
    await expect(notice).toContainText('type /login');
    await notice.locator('button').click();
    await expect(pane().locator('.term.active .xterm')).toBeVisible();
    await expect(pane().locator('.tab:visible')).toHaveCount(2);
  });

  test('Claude Code missing: the chat says so and opens Setup', async () => {
    await launch({ env: { VIBEX_CLAUDE_MISSING: '1' } });
    await say('hello');
    const notice = items('notice').first();
    await expect(notice).toContainText('Claude Code is not installed');
    await notice.locator('button').click();
    await expect(page.locator('body')).toContainText('Install Claude Code');
    expect(starts(logFile)).toHaveLength(0);
  });

  test('a folder not trusted: a card, no process, and Check Again lets it go on', async () => {
    await launch({ trusted: false });
    const card = chatOn().locator('.chat-trust');
    await expect(card).toContainText('Claude Code has not been trusted in this folder');
    await say('hello');
    await expect(items('notice').first()).toContainText('not been trusted');
    await input().fill('');
    await page.waitForTimeout(400);
    expect(starts(logFile)).toHaveLength(0);
    // Windows: the runner's real claude.exe registers the tools at start, and writes this file. Then the trust goes in.
    if (!posix) await expect.poll(async () => (await page.evaluate(() => (window as any).vibex.status())).claude, { timeout: 60_000 }).not.toBe('registering with Claude Code');
    writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ projects: { [folder.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } } }));
    await card.locator('.chat-trust-check').click();
    await expect(card).toBeHidden();
    await say('hello');
    await expect(lastText()).toContainText('Hello from');
    await pane().locator('.new-tab').click();
    await expect(pane().locator('.tab:visible')).toHaveCount(2);
    await expect(chatOn().locator('.chat-trust')).toBeHidden();
  });

  test('a long answer follows the end until the person scrolls up, then offers the way back', async () => {
    await launch();
    await say('long');
    const scroll = chatOn().locator('.chat-scroll');
    await expect(items('text')).toHaveCount(80);
    await expect.poll(() => scroll.evaluate((s) => Math.abs(s.scrollHeight - s.clientHeight - s.scrollTop) < 60)).toBe(true);
    await scroll.evaluate((s) => { s.scrollTop = 0; s.dispatchEvent(new Event('scroll')); });
    const follow = chatOn().locator('.chat-follow');
    await expect(follow).toBeVisible();
    await follow.click();
    await expect.poll(() => scroll.evaluate((s) => Math.abs(s.scrollHeight - s.clientHeight - s.scrollTop) < 60)).toBe(true);
    await expect(follow).toBeHidden();
  });

  test('a process that dies says why; the next message resumes', async () => {
    await launch();
    await say('hello');
    await expect(items('done')).toBeVisible();
    await say('die');
    await expect(items('notice').first()).toContainText('made-up failure text');
    await say('more');
    await expect(lastText()).toHaveText('You said: more');
    expect(starts(logFile).at(-1).argv).toContain('--resume');
  });

  test('a quit ends the process', async () => {
    await launch();
    await say('slow');
    await expect(chatOn().locator('.chat-stop')).toBeVisible();
    const { pid } = starts(logFile).filter((s) => s.argv.includes('--verbose')).at(-1);
    await app.close();
    await expect.poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, { timeout: 15_000 }).toBe(true);
    app = undefined as unknown as ElectronApplication;
  });

  test('screens: dark, light, 900 x 560 and 1093 x 614', async () => {
    await launch();
    const shots = path.join(__dirname, '..', 'screens');
    mkdirSync(shots, { recursive: true });
    const shot = (name: string) => page.screenshot({ path: path.join(shots, `chat-${name}.png`) });
    const size = (w: number, h: number) => app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.w, s.h), { w, h });

    await shot('empty-dark');
    await say('hello');
    await expect(items('done')).toBeVisible();
    await say('tools');
    await expect(items('tool')).toHaveCount(5);
    await say('xss');
    await expect(lastText().locator('table')).toBeVisible();
    await say('bash');
    await expect(chatOn().locator('.chat-card .chat-allow')).toBeEnabled();
    await shot('approval-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await shot('approval-light');
    await page.emulateMedia({ colorScheme: 'dark' });

    for (const [w, h] of [[900, 560], [1093, 614]]) {
      await size(w, h);
      await page.waitForTimeout(300);
      await shot(`approval-${w}x${h}`);
      // Nothing of the composer or the card is cut off at this size.
      const box = await chatOn().locator('.chat-composer').boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(h);
      const room = await pane().boundingBox();
      for (const control of ['.chat-send', '.chat-mode', '.chat-attach']) {
        const b = (await chatOn().locator(control).boundingBox())!;
        expect(b.x + b.width).toBeLessThanOrEqual(room!.x + room!.width);
      }
    }
    await chatOn().locator('.chat-card .chat-allow').click();
    await expect(items('text').last()).toHaveText('The command ran.');
    await input().fill('/');
    await shot('slash-1093x614');
    await page.emulateMedia({ colorScheme: 'light' });
    await shot('slash-light-1093x614');
    await page.emulateMedia({ colorScheme: 'dark' });
    await input().fill('');
    await size(900, 560);
    await pane().locator('.new-tab').click();
    await shot('empty-900x560');
    await size(1440, 900);
    await shot('empty-1440x900');
    await say('question');
    await expect(chatOn().locator('.chat-card')).toBeVisible();
    await shot('question-dark');
  });
});

// A server project keeps its terminal: a chat runs Claude on this computer, as in macOS Vibex.
test('chat in a server project: its Claude tab stays a terminal on the server, and New Claude Chat opens a chat there', async () => {
  const dir = realpathSync.native(tempDir('vibex-chat-server-'));
  const userData = path.join(dir, 'data');
  mkdirSync(userData);
  const ssh = await startSshServer(dir, (sent) => {
    const encoded = /printf %s (\S+) \|/.exec(sent)?.[1];
    const command = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : sent;
    return command.includes('ls -1d') ? 'app-one/\n' : null;
  });
  writeFileSync(path.join(userData, 'servers.json'), JSON.stringify([{
    name: 'test', host: '127.0.0.1', user: 'pca', port: ssh.port, identityFile: ssh.keyFile, allowClaude: true,
    options: { StrictHostKeyChecking: 'accept-new', UserKnownHostsFile: ssh.knownHosts, IdentitiesOnly: 'yes' },
  }]));
  const env = { ...process.env, VIBEX_TEST: '1', VIBEX_CHAT_DEFAULT: '1', VIBEX_USER_DATA: userData, VIBEX_MCP_PORT: '0', CLAUDE_CONFIG_DIR: path.join(dir, 'cfg'), ...(process.platform === 'darwin' ? { VIBEX_TOKEN_STORE: 'memory' } : {}) } as Record<string, string>;
  delete env.VIBEX_AGENT_COMMAND;
  const app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..'), env });
  try {
    const page = await firstWindow(app);
    await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
    await page.evaluate(() => (window as any).vibex.projects.openServer('test', '~/app-one'));
    const pane = page.locator('.terminal-pane[data-pane="agent"]');
    await expect(pane.locator('.tab:visible')).toHaveCount(1, { timeout: 20_000 });
    await expect(pane.locator('.term.active .xterm')).toBeVisible();
    await expect(pane.locator('.chat-surface')).toHaveCount(0);
    await pane.locator('.new-tab').click();
    await expect(pane.locator('.tab:visible')).toHaveCount(2);
    await expect(pane.locator('.chat-surface')).toHaveCount(0);
    // The chat runs Claude on the server now (server-chat-app.spec.ts): no note that it cannot, and the chat opens.
    // With no toast at all there is no #toasts element, so count the words instead.
    await expect(page.getByText('Native chats run on this computer')).toHaveCount(0);
    await pane.locator('.new-chat').click();
    await expect(pane.locator('.tab:visible')).toHaveCount(3);
    await expect(pane.locator('.term.active.chat-surface')).toBeVisible();
  } finally {
    await app.close();
    ssh.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
