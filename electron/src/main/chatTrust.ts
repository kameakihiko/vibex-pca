import { unsafeCharacters } from './serverQuestions';
import type path from 'node:path';

// What `claude -p` skips (its trust dialog), and what an approval card shows. Vibex/Claude/ClaudeTrust.swift. No Electron here.

export interface TrustLookup { paths: typeof path.posix; exists: (file: string) => boolean }

/// As Claude Code itself decides: the walk up ends at the repository's root, so trust in a folder that holds cloned repos
/// never reaches them. A file that is missing or unreadable means not trusted. Claude Code writes a Windows path with forward
/// slashes, so both spellings count.
export function isTrustedIn(folder: string, configText: string | null, { paths, exists }: TrustLookup): boolean {
  if (configText === null) return false;
  let projects: unknown;
  try {
    projects = JSON.parse(configText)?.projects;
  } catch {
    return false;
  }
  if (!projects || typeof projects !== 'object') return false;
  const table = projects as Record<string, { hasTrustDialogAccepted?: unknown } | undefined>;
  let at = paths.resolve(folder);
  for (;;) {
    const forward = at.replaceAll('\\', '/');
    for (const key of new Set([at, at.normalize('NFC'), forward, forward.normalize('NFC')])) {
      if (table[key]?.hasTrustDialogAccepted === true) return true;
    }
    if (exists(paths.join(at, '.git'))) return false;
    const parent = paths.dirname(at);
    if (parent === at) return false;
    at = parent;
  }
}

/// What the card shows above the rows: the command, else the path, and an edit's two sides when both exist.
export function shownAbove(input: Record<string, string>): Set<string> {
  const shown = new Set(input.command !== undefined ? ['command'] : ['file_path']);
  if (input.old_string !== undefined && input.new_string !== undefined) {
    shown.add('old_string');
    shown.add('new_string');
  }
  return shown;
}

const CLIP_LIMIT = 20_000;

/// A very large value would stall the card's text; the card says when it shows only the start.
export function clipped(text: string, limit = CLIP_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… ${text.length - limit} more characters not shown`;
}

/// Every other input of the call: what is approved must be readable before the click.
export function permissionRows(rawInput: unknown, above: Set<string>, limit = CLIP_LIMIT): { key: string; value: string }[] {
  if (!rawInput || typeof rawInput !== 'object') return [];
  return Object.keys(rawInput).filter((k) => !above.has(k)).sort().map((key) => {
    const value = (rawInput as Record<string, unknown>)[key];
    return { key, value: clipped(typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value), limit) };
  });
}

/// The most a card shows on asking. Beyond this, Allow stays off.
export const WHOLE_LIMIT = 2_000_000;
/// Text for a file or for the person, where a Windows line end, an emoji's joiner or a no-break space are normal. It is marked and can
/// be allowed. Everything else is what runs: the same rule as the server confirmation (./serverQuestions.ts), so Allow turns off.
const PLAIN_TEXT = new Set(['content', 'old_string', 'new_string', 'description']);

const markUnsafe = (text: string) => [...text].map((char) => (unsafeCharacters(char) ? `<U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>` : char)).join('');

export interface CardView {
  input: Record<string, string>;
  rows: { key: string; value: string }[];
  /// Only the start of some value is here, and all of it comes on asking.
  cut: boolean;
  /// A value is beyond WHOLE_LIMIT, so no person can read it here.
  tooLong: boolean;
  /// Why Allow is off for good, or null.
  refuse: string | null;
  /// What the person should know about the marks in a file's text, or null.
  note: string | null;
}

/// What an approval card shows: invisible characters as U+ codes, and the start of a very long value. The raw input never changes:
/// this is only for the eyes. Allow depends on it (allowRefusal).
export function cardView(tool: { input: Record<string, string> }, rawInput: unknown, whole = false): CardView {
  let refuse: string | null = null;
  let note: string | null = null;
  let cut = false;
  let tooLong = false;
  const look = (key: string, value: string): string => {
    const plain = PLAIN_TEXT.has(key);
    const text = plain ? value.replace(/\r\n/g, '\n') : value;
    if (value.length > WHOLE_LIMIT) tooLong = true;
    else if (value.length > CLIP_LIMIT && !whole) cut = true;
    const shortened = clipped(text, whole ? WHOLE_LIMIT : CLIP_LIMIT);
    // Over the limit no person can read it, and the scan would take seconds.
    const unsafe = value.length > WHOLE_LIMIT ? null : unsafeCharacters(text, key === 'file_path' ? 'the file path' : key === 'command' ? 'the command' : `the input "${markUnsafe(key)}"`);
    if (!unsafe) return shortened;
    if (plain) note = 'This text holds characters that do not show. Each one is marked here as <U+code>.';
    else refuse ??= `This cannot be allowed here: ${unsafe}. Each such character is marked as <U+code>. Click "Don't Allow".`;
    return markUnsafe(shortened);
  };
  const input = Object.fromEntries(Object.entries(tool.input).map(([k, v]) => [k, look(k, v)]));
  const rows = permissionRows(rawInput, shownAbove(tool.input), Infinity).map(({ key, value }) => ({ key: markUnsafe(key), value: look(key, value) }));
  return { input, rows, cut, tooLong, refuse, note };
}

/// Why Allow does not count yet, or null. `seen`: the person reached the end of the card's box.
export function allowRefusal(view: Pick<CardView, 'cut' | 'tooLong' | 'refuse'>, seen: boolean): string | null {
  if (view.tooLong) return 'This is too long to show in full, so it cannot be allowed here. Click "Don\'t Allow", and ask Claude for a shorter step.';
  if (view.refuse) return view.refuse;
  if (view.cut) return 'Only the start of this shows. Click Show All, and read to the end. Then Allow turns on.';
  if (!seen) return 'Scroll this box and read to the end. Then Allow turns on.';
  return null;
}

/// Names the rules "Always Allow" adds.
export function alwaysAllowHelp(suggestions: unknown): string {
  return suggestions ? `Adds to Claude Code's permissions: ${JSON.stringify(suggestions)}` : 'Also allow this from now on';
}

/// What "Always Allow" sends back: the rules alone. Claude Code also suggests a mode change and more folders, and a setMode
/// there lets the next write and command run with no card while the button still says Ask (seen on real 2.1.316).
export function onlyRules(suggestions: unknown): unknown[] | null {
  if (!Array.isArray(suggestions)) return null;
  const rules = suggestions.filter((s) => (s as { type?: unknown } | null)?.type === 'addRules');
  return rules.length ? rules : null;
}

/// What an image is by its first bytes. A file name proves nothing, and Claude's API refuses a wrong media type.
export function imageTypeOf(data: Uint8Array): string | null {
  const at = (offset: number, ...bytes: number[]) => bytes.every((b, i) => data[offset + i] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}
