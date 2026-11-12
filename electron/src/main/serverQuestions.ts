import type { ServerProfile } from './servers';

// The owner's answer before a command from Claude runs on a server with "confirmCommands", and every other question an
// ssh of the app asks (fork: Servers/CommandConfirmation.swift, AskpassSheet.swift). The answer comes from the app's own
// window only: no MCP tool can reach it. A hold counts only with a press of at least HOLD_MS on the button, after ARM_MS,
// as main saw it (windowPointer.ts); no key press and no script counts. What this does not prove: the fork reads the WindowServer to tell hardware from a program, and
// Electron has no such fact here, so a program that drives this window's own input passes as a person.

/// With no answer in this time a question counts as refused.
export const QUESTION_MS = 120_000;
export const ARM_MS = 1_000;
export const HOLD_MS = 1_000;

/// A server's entry in the file now.
export type Saved = { kind: 'found'; profile: ServerProfile } | { kind: 'missing' } | { kind: 'unreadable'; reason: string };

/// By name in any letter case; two such entries: the app does not guess.
export function lookUp(loaded: ServerProfile, profiles: { ok: ServerProfile[] } | { error: string }): Saved {
  if ('error' in profiles) return { kind: 'unreadable', reason: profiles.error };
  const named = profiles.ok.filter((p) => p.name.toLowerCase() === loaded.name.toLowerCase());
  return named.length === 1 ? { kind: 'found', profile: named[0] } : { kind: 'missing' };
}

/// The profile as the project opened it, or as the file says now: either one turns the question on.
export function needsQuestion(loaded: ServerProfile | null, saved: Saved): boolean {
  if (!loaded) return false;
  if (saved.kind === 'found' && saved.profile.confirmCommands) return true;
  return !!loaded.confirmCommands;
}

/// Why a terminal_run is refused outright, for a project opened without "confirmCommands": the file turned it on since,
/// and that project's Claude still runs without the permission options; or the file no longer says, so the app cannot
/// know that it is still off.
export function liveToggleRefusal(loaded: ServerProfile | null, saved: Saved): string | null {
  if (!loaded || loaded.confirmCommands) return null;
  if (saved.kind === 'found') return saved.profile.confirmCommands ? "refused: reopen this project to apply 'ask before each change'" : null;
  if (saved.kind === 'missing') return `refused: servers.json has no server named "${loaded.name}" any more, so the app cannot check 'ask before each change'; fix the entry, then reopen this project`;
  return `refused: ${saved.reason} The app cannot check 'ask before each change'`;
}

/// Bidi controls, zero-width characters, control characters other than newline and tab, and each space other than
/// U+0020 can make a sheet show one command while the shell runs another. Such a command has no question.
export function unsafeCharacters(text: string, what = 'the command'): string | null {
  for (const char of text) {
    const value = char.codePointAt(0)!;
    if (char === '\n' || char === '\t' || char === ' ') continue;
    const code = `U+${value.toString(16).toUpperCase().padStart(4, '0')}`;
    if (value < 0x20 || value === 0x7f || (value >= 0x80 && value <= 0x9f)) return `${what} holds the control character ${code}, which the confirmation cannot show`;
    if ([0x061c, 0x200e, 0x200f].includes(value) || (value >= 0x202a && value <= 0x202e) || (value >= 0x2066 && value <= 0x2069)) return `${what} holds the bidirectional control ${code}, which can make the text read differently`;
    if (/[\p{Zs}\p{Zl}\p{Zp}]/u.test(char)) return `${what} holds the space or separator ${code}, which looks like a plain space or line break but is not one to the shell`;
    if (/\p{Default_Ignorable_Code_Point}/u.test(char)) return `${what} holds the invisible character ${code}`;
  }
  return null;
}

/// The command as the sheet shows it: each tab and line end marked, so nothing is hidden.
export const visible = (text: string) => text.replace(/\t/g, '⇥\t').replace(/\n/g, '↵\n');

export function size(text: string): string {
  const lines = text.split('\n').length;
  const characters = [...text].length;
  return `${lines} line${lines === 1 ? '' : 's'}, ${characters} character${characters === 1 ? '' : 's'}`;
}

/// A prompt as a sheet shows it: control and invisible characters as U+ codes, line ends kept.
export function shown(prompt: string, limit = 1000): string {
  return [...prompt.trim()].slice(0, limit).map((char) => (char !== '\n' && unsafeCharacters(char) ? `<U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>` : char)).join('');
}

export type QuestionForm =
  | { kind: 'hold'; title: string; info: string; textLabel: string; text: string; holdTitle: string; refuseTitle: string; verb: string }
  | { kind: 'typed'; title: string; note: string; prompt: string; savable: boolean; saveUnavailable?: string };

/// Why the press does not prove the hold, or null when it does. `since` is when the question came on screen.
export type HoldProof = (since: { shownAt: number; armMs: number; holdMs: number }) => Promise<string | null>;

export type Answer = { run: true } | { typed: string; save: boolean } | { refused: string };

interface Open {
  id: string;
  form: QuestionForm;
  group?: string;
  resolve: (answer: Answer) => void;
  beforeShow?: () => Answer | null;
  shownAt: number;
  timer?: NodeJS.Timeout;
}

/// One question on screen at a time, in order. `group`: at most one question of this group waits or shows; another is
/// refused at once, so a loop of calls cannot queue questions.
export class Questions {
  private queue: Open[] = [];
  private current: Open | null = null;
  private next = 1;
  timeoutMs = QUESTION_MS;
  /// Set when the window is there. With none, no hold counts.
  holdProof: HoldProof = async () => 'the window is not there';

  constructor(private readonly show: (q: { id: string; form: QuestionForm } | null) => void, private readonly now: () => number = Date.now) {}

  busy(group: string): boolean {
    return this.current?.group === group || this.queue.some((q) => q.group === group);
  }

  /// `signal`: the ssh that asked is gone, so the question goes away, also from the screen.
  ask(form: QuestionForm, options: { group?: string; beforeShow?: () => Answer | null; signal?: AbortSignal } = {}): Promise<Answer> {
    if (options.group && this.busy(options.group)) return Promise.resolve({ refused: 'refused: another question is open in this project; ask again after it is answered' });
    if (options.signal?.aborted) return Promise.resolve({ refused: 'refused: the connection ended' });
    return new Promise((resolve) => {
      const q: Open = { id: `q${this.next++}`, form, group: options.group, resolve, beforeShow: options.beforeShow, shownAt: 0 };
      options.signal?.addEventListener('abort', () => this.withdraw(q), { once: true });
      this.queue.push(q);
      this.advance();
    });
  }

  private withdraw(q: Open): void {
    const refused: Answer = { refused: 'refused: the connection ended' };
    if (this.current === q) return this.finish(q, refused);
    const at = this.queue.indexOf(q);
    if (at < 0) return;
    this.queue.splice(at, 1);
    q.resolve(refused);
  }

  /// What the window says for a question. A hold that came too early counts as a refusal, so a script cannot skip it.
  answer(id: string, value: unknown): void {
    const q = this.current;
    if (!q || q.id !== id || !value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    if (q.form.kind === 'hold' && v.run === true) {
      if (this.now() - q.shownAt < ARM_MS + HOLD_MS - 50) return this.finish(q, { refused: 'refused: Run was not held' });
      void this.holdProof({ shownAt: q.shownAt, armMs: ARM_MS, holdMs: HOLD_MS }).then(
        (why) => why,
        () => 'the press could not be checked',
      ).then((why) => {
        if (this.current === q) this.finish(q, why ? { refused: `refused: ${why}` } : { run: true });
      });
    } else if (q.form.kind === 'typed' && typeof v.typed === 'string') {
      this.finish(q, { typed: v.typed, save: v.save === true && q.form.savable });
    } else {
      this.finish(q, { refused: 'refused by the user' });
    }
  }

  /// A project closed or the app quits: its questions end as refused.
  cancel(group: string): void {
    for (const q of this.queue.filter((x) => x.group === group)) {
      this.queue.splice(this.queue.indexOf(q), 1);
      q.resolve({ refused: 'refused: the project closed' });
    }
    if (this.current?.group === group) this.finish(this.current, { refused: 'refused: the project closed' });
  }

  /// For a window that loaded after the question came.
  showCurrent(): void {
    this.show(this.current ? { id: this.current.id, form: this.current.form } : null);
  }

  private finish(q: Open, answer: Answer): void {
    if (q.timer) clearTimeout(q.timer);
    this.current = null;
    q.resolve(answer);
    this.advance();
  }

  private advance(): void {
    if (this.current) return;
    while (this.queue.length) {
      const q = this.queue.shift()!;
      const early = q.beforeShow?.();
      if (early) {
        q.resolve(early);
        continue;
      }
      this.current = q;
      q.shownAt = this.now();
      q.timer = setTimeout(() => this.finish(q, { refused: 'refused by the user: no answer in 2 minutes' }), this.timeoutMs);
      this.show({ id: q.id, form: q.form });
      return;
    }
    this.show(null);
  }
}
