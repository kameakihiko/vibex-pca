import { rank } from './fuzzy';

// The words of the chat: tool cards, modes and the menu above the composer. Ported from Vibex/Claude/ClaudeChatView.swift
// (ClaudeToolSummary) and ClaudeCatalog.swift (ClaudeCompleter). No DOM and no Electron, so main and the tests use it too.

export type ChatMode = 'default' | 'acceptEdits' | 'plan' | 'auto';

export const MODES: { value: ChatMode; title: string; summary: string; icon: string }[] = [
  { value: 'default', title: 'Ask', summary: 'Asks before edits and commands', icon: 'lock' },
  { value: 'acceptEdits', title: 'Accept edits', summary: 'Edits files freely, asks before commands', icon: 'fileCode' },
  { value: 'plan', title: 'Plan', summary: 'Reads and proposes a plan, changes nothing', icon: 'book' },
  { value: 'auto', title: 'Auto', summary: 'Works on its own, stops only for risky actions', icon: 'zap' },
];
export const modeOf = (value: string) => MODES.find((m) => m.value === value) ?? MODES[0];
export const nextMode = (value: string): ChatMode => MODES[(MODES.findIndex((m) => m.value === value) + 1) % MODES.length].value;

export interface ToolLike { name: string; input: Record<string, string> }
export interface ToolSummary { icon: string; title: string; path?: string; isCode: boolean }

const baseName = (file: string) => file.split(/[\\/]/).pop() ?? file;
const capital = (word: string) => (word ? word[0].toUpperCase() + word.slice(1) : word);

/// Claude writes these words and they need not match what the tool does (a `ref` wins over a `label`), so only the collapsed
/// card shows them, as one short line. Typed text can be a password, so it never shows.
function targetOf(tool: ToolLike, action: string): string | null {
  if (action.startsWith('type') || tool.input.ref !== undefined) return null;
  const raw = tool.input.label ?? tool.input.text ?? tool.input.url ?? tool.input.name;
  if (raw === undefined) return null;
  const line = raw.split(/[\r\n]+/).join(' ');
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/// `withTarget` false: the approval card's headline, which shows only what the tool is.
export function toolSummary(tool: ToolLike, withTarget = true): ToolSummary {
  const { name, input } = tool;
  const file = input.file_path ?? input.notebook_path;
  const fileName = file ? baseName(file) : '';
  const plain = (icon: string, title: string, extra: Partial<ToolSummary> = {}): ToolSummary => ({ icon, title, isCode: false, ...extra });
  switch (name) {
    case 'Read': return plain('file', `Read ${fileName}`, { path: file });
    case 'Write': return plain('fileCode', `Write ${fileName}`, { path: file });
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return plain('fileCode', `Edit ${fileName}`, { path: file });
    case 'Bash': return plain('terminal', input.command ?? 'Ran a command', { isCode: true });
    case 'Grep': return plain('search', `Search for ${input.pattern ?? 'text'}`);
    case 'Glob': return plain('search', `Find files matching ${input.pattern ?? 'a pattern'}`);
    case 'WebFetch': return plain('globe', `Read ${input.url ?? 'a page'}`);
    case 'WebSearch': return plain('globe', `Search the web for ${input.query ?? 'something'}`);
    case 'Task': case 'Agent': return plain('users', withTarget ? input.description ?? 'Ran a subagent' : name);
    case 'TodoWrite': return plain('checkCircle', 'Update the plan');
    case 'Skill': return plain('skills', `Use the ${input.skill ?? ''} skill`);
    case 'ToolSearch': return plain('search', 'Look up tools');
    default:
  }
  if (!name.startsWith('mcp__')) return plain('zap', name);
  const parts = name.split('_').filter(Boolean);
  const server = parts[1] ?? 'mcp';
  const action = parts.slice(2).join(' ');
  if (server !== 'vibex') return plain('server', `${server}: ${action}`);
  const [area = '', ...restWords] = action.split(' ');
  const rest = restWords.join(' ');
  const icon = area === 'browser' ? 'globe' : area === 'terminal' ? 'terminal' : 'zap';
  const target = withTarget ? targetOf(tool, rest) : null;
  return plain(icon, `${capital(area)}: ${rest}${target ? ` “${target}”` : ''}`);
}

export function verbFor(tool: string): string {
  switch (tool) {
    case 'Bash': return 'run';
    case 'Write': return 'create';
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return 'edit';
    case 'WebFetch': case 'WebSearch': return 'go online';
    default: return 'use a tool';
  }
}

/// The file a tool call is about, from JSON that is still arriving: {"file_path":"/a/b.json","con
export const filePathInPartial = (text: string): string | null => /"file_path"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null;

/// "/resume isn't available in this environment." gives "resume". Command names only.
export function terminalOnlyCommand(text: string): string | null {
  if (!text.startsWith('/') || !text.endsWith("isn't available in this environment.")) return null;
  const word = text.slice(1).split(' ')[0];
  return /^[A-Za-z0-9_-]+$/.test(word) ? word : null;
}

// ------------------------------------------------------------------ the menu above the composer

export interface CommandLike { name: string; summary: string; argumentHint: string }
export interface ModelLike { value: string; title: string; summary: string; effortLevels: string[] }
export interface SessionLike { id: string; title: string; date: number }

export interface Suggestion {
  id: string;
  title: string;
  detail: string;
  isCode: boolean;
  /// What Return does: finish the text and keep typing, or send this now.
  action: { insert: string } | { run: string };
  /// What Tab does: always finishes the text, never sends.
  completion: string;
}

/// What the app does itself, because a terminal-less Claude Code cannot.
export const LOCAL_COMMANDS: CommandLike[] = [
  { name: 'plan', summary: 'Plan mode: Claude proposes before changing anything', argumentHint: '[task]' },
  { name: 'auto', summary: 'Auto mode: Claude only stops for risky actions', argumentHint: '[task]' },
  { name: 'ask', summary: 'Ask mode: Claude asks before edits and commands', argumentHint: '' },
  { name: 'accept-edits', summary: 'Accept edits: file changes go ahead, commands ask', argumentHint: '' },
  { name: 'new', summary: 'Start a new chat', argumentHint: '' },
  { name: 'agent', summary: 'Start a parallel agent on its own branch', argumentHint: '<task>' },
  { name: 'resume', summary: 'Pick up an earlier conversation', argumentHint: '<conversation>' },
  { name: 'skills', summary: 'Open the Skills panel', argumentHint: '' },
  { name: 'mcp', summary: 'Open the MCP Servers panel', argumentHint: '' },
  { name: 'help', summary: 'How commands work here', argumentHint: '' },
];

/// Shown first when nothing is typed yet: what people reach for most.
const COMMON = ['plan', 'auto', 'agent', 'model', 'compact', 'clear', 'context', 'usage', 'resume', 'effort', 'init'];
const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
/// Commands whose argument has its own menu, so picking the command opens that.
const OPENS_MENU = new Set(['model', 'effort', 'resume']);

const row = (command: string, title: string, detail = ''): Suggestion => ({ id: command, title, detail, isCode: true, action: { run: command }, completion: command });

function commandRows(query: string, commands: CommandLike[]): Suggestion[] {
  const local = new Set(LOCAL_COMMANDS.map((c) => c.name));
  const all = [...LOCAL_COMMANDS, ...commands.filter((c) => !local.has(c.name))];
  const q = query.toLowerCase();
  const place = (name: string) => (COMMON.includes(name) ? COMMON.indexOf(name) : COMMON.length);
  let ranked: CommandLike[];
  if (!q) {
    const first = COMMON.flatMap((name) => all.filter((c) => c.name === name));
    ranked = [...first, ...all.filter((c) => !COMMON.includes(c.name)).sort((a, b) => a.name.localeCompare(b.name))];
  } else {
    // What people reach for most beats alphabetical luck: /co means /compact before /color.
    const starts = all.filter((c) => c.name.toLowerCase().startsWith(q)).sort((a, b) => place(a.name) - place(b.name) || a.name.length - b.name.length);
    const inName = all.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
    const inSummary = q.length < 3 ? [] : all.filter((c) => !c.name.toLowerCase().includes(q) && c.summary.toLowerCase().includes(q));
    ranked = [...starts, ...inName, ...inSummary];
  }
  return ranked.map((c) => {
    // An optional argument can still run bare; a required one, or its own menu, cannot.
    const mustContinue = OPENS_MENU.has(c.name) || c.argumentHint.startsWith('<');
    return {
      id: c.name,
      title: `/${c.name}`,
      // Some hints list every value; those are too long to help in one row.
      detail: [c.argumentHint.length <= 16 ? c.argumentHint : '', c.summary].filter(Boolean).join('  '),
      isCode: true,
      action: mustContinue ? { insert: `/${c.name} ` } : { run: `/${c.name}` },
      completion: `/${c.name} `,
    };
  });
}

const when = (ms: number) => (ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

/// What the menu offers for what is typed so far.
export function suggestions(text: string, o: { commands: CommandLike[]; models: ModelLike[]; sessions: SessionLike[]; files: string[] }): Suggestion[] {
  if (text.startsWith('/')) {
    const space = text.indexOf(' ');
    if (space < 0) return commandRows(text.slice(1), o.commands);
    const command = text.slice(1, space);
    const query = text.slice(space + 1).toLowerCase();
    switch (command) {
      case 'model':
        return o.models.filter((m) => !query || m.value.toLowerCase().includes(query) || m.title.toLowerCase().includes(query)).map((m) => row(`/model ${m.value}`, m.title, m.summary));
      case 'effort':
        return EFFORT.filter((level) => !query || level.startsWith(query)).map((level) => row(`/effort ${level}`, level));
      case 'resume':
        return o.sessions.filter((s) => !query || s.title.toLowerCase().includes(query)).map((s) => ({ ...row(`/resume ${s.id}`, s.title, when(s.date)), isCode: false }));
      default:
        return [];
    }
  }
  // A file: the word being typed starts with @.
  const last = text.split(/[ \n]/).pop() ?? '';
  if (!last.startsWith('@')) return [];
  const head = text.slice(0, text.length - last.length);
  return rank(o.files, last.slice(1), (f) => f).slice(0, 30).map(({ item }) => ({
    id: `@${item}`,
    title: item,
    detail: '',
    isCode: true,
    action: { insert: `${head}@${item} ` },
    completion: `${head}@${item} `,
  }));
}

/// May this button of a card take a press? Allow and Always Allow also wait for the end of the box, and a clean card; the rest only for the arm time.
export function answerOn(choice: string | undefined, armed: boolean, read: boolean, noAllow: boolean): boolean {
  if (!armed) return false;
  return choice === 'allow' || choice === 'always' ? read && !noAllow : true;
}

/// The end of a box that scrolls. At 150 % the numbers have fractions, so a small rest counts as the end.
export const reachedEnd = (top: number, height: number, scrollHeight: number) => top + height >= scrollHeight - 2;
