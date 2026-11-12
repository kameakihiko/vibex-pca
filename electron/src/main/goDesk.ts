import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The owner's "go" for a merge, a deploy or another ship step (macOS Vibex: Go/GoDesk.swift, MCP/Tools/GoTools.swift).
// Claude files a request; the Go panel shows it; only a person holding the Go button with the mouse answers it.
// No tool can answer: the answer comes from the window's own mouse input (PointerTracker), never from a call.
// Pure logic and files only, so it is tested without a window.

export class GoError extends Error {}

export type Decision = 'go' | 'declined';

export interface GoAsk { title: string; items: string[]; reviewUrl: string | null; prUrl: string | null; device?: string | null }

export interface GoAnswer { decision: Decision; note: string | null; at: number }

export interface GoRequest {
  id: string;
  title: string;
  items: string[];
  /// SHA-256 of the items alone.
  itemsHash: string;
  /// SHA-256 of everything the owner is asked about: title, items, review page and PR.
  requestHash: string;
  reviewUrl: string | null;
  prUrl: string | null;
  /// The project that asked; its Go panel shows the request.
  projectId: string;
  project: string;
  projectPath: string;
  createdAt: number;
  answer?: GoAnswer;
}

export const MAX_WAIT_SECONDS = 600;
const MAX_TITLE = 200;
const MAX_ITEM = 300;

const REFUSED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}\p{Cn}\p{Mn}\p{Me}\p{Default_Ignorable_Code_Point}\p{Variation_Selector}]/u;
/// Code points that draw nothing or join the one before, beyond the categories above: the combining grapheme
/// joiner, Khmer and Mongolian invisible vowels and selectors, the Hangul fillers and the blank Braille pattern.
const INVISIBLE = new Set([0x034f, 0x17b4, 0x17b5, 0x180b, 0x180c, 0x180d, 0x180e, 0x180f, 0x3164, 0x115f, 0x1160, 0xffa0, 0x2800]);

/// Text the owner reads as one line, exactly as it is logged: at most `limit` code points, and none that is a line
/// break, a control or format character (bidi overrides, zero-width), a combining mark, a variation selector or
/// another invisible one.
export function checkLine(raw: string, name: string, limit: number): string {
  const text = raw.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, '');
  if (!text) throw new GoError(`${name} is empty`);
  const points = [...text];
  if (points.length > limit) throw new GoError(`${name} is longer than ${limit} code points`);
  for (const ch of points) {
    if (REFUSED.test(ch) || INVISIBLE.has(ch.codePointAt(0)!)) {
      throw new GoError(`${name} holds a line break, control, combining or invisible character (U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`);
    }
  }
  return text;
}

function isWeb(address: string): boolean {
  try {
    const url = new URL(address);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname;
  } catch {
    return false;
  }
}

/// Checks the arguments of vibex_request_go.
export function parseAsk(args: Record<string, unknown>, fileExists: (file: string) => boolean = (f) => existsSync(f) && statSync(f).isFile()): GoAsk {
  const title = checkLine(typeof args.title === 'string' ? args.title : '', 'title', MAX_TITLE);
  const raw = args.items;
  if (!Array.isArray(raw) || !raw.length) throw new GoError('items must list what will ship or run, one string each');
  if (raw.length > 50) throw new GoError('at most 50 items');
  const items = raw.map((value, i) => {
    if (typeof value !== 'string') throw new GoError(`item ${i + 1} is not a string`);
    return checkLine(value, `item ${i + 1}`, MAX_ITEM);
  });
  const optional = (name: string) => (typeof args[name] === 'string' && args[name] !== '' ? checkLine(args[name] as string, name, 2000) : null);
  const reviewUrl = optional('review_url');
  if (reviewUrl && !isWeb(reviewUrl)) {
    if (!path.isAbsolute(reviewUrl) || !/\.html?$/i.test(reviewUrl)) throw new GoError('review_url must be an http(s) URL or an absolute path to an .html file');
    if (!fileExists(reviewUrl)) throw new GoError(`no file at ${reviewUrl}`);
  }
  const prUrl = optional('pr_url');
  if (prUrl && !isWeb(prUrl)) throw new GoError('pr_url must be an http(s) URL');
  const device = typeof args.device === 'string' ? args.device : null;
  if (device && !['desktop', 'phone', 'tablet'].includes(device)) throw new GoError('device must be desktop, phone or tablet');
  return { title, items, reviewUrl, prUrl, device };
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/// SHA-256 of the items as a JSON array, in order, so the same text always gives the same hash.
export const itemsHash = (items: string[]) => sha256(JSON.stringify(items));

/// SHA-256 of the title, items and links as one JSON object with sorted keys.
export const requestHash = (title: string, items: string[], reviewUrl: string | null, prUrl: string | null) =>
  sha256(JSON.stringify({ items, pr_url: prUrl, review_url: reviewUrl, title }));

// ------------------------------------------------------------------ the proof that a mouse pressed the button

export interface Rect { x: number; y: number; width: number; height: number }
interface Pointer { x: number; y: number; at: number }
export interface Press { move: Pointer | null; down: Pointer; up: Pointer | null; current: Pointer; moves: number }

export interface GoClick {
  at: number;
  /// When the pointer last moved, by the mouse, to the spot of the press.
  movedAt: number;
  /// How long the button was held before it acted; 0 for a click.
  heldFor: number;
  /// What the log keeps of the press: where, for how long, and how many mouse moves came before it.
  press?: PressRecord;
}

export interface PressRecord { x: number; y: number; heldMs: number; moves: number }

export interface InputFacts { type: string; x: number; y: number; button?: string }

/// Remembers the window's own mouse input (Electron's `input-event`, seen in the main process before the page
/// gets it). A script in the page that dispatches events, or calls element.click(), makes none of this.
export class PointerTracker {
  private lastMove: Pointer | null = null;
  private moveBeforeDown: Pointer | null = null;
  private down: Pointer | null = null;
  private up: Pointer | null = null;
  private current: Pointer | null = null;
  private moves = 0;
  private movesBeforeDown = 0;

  feed(input: InputFacts, at: number): void {
    const here = { x: input.x, y: input.y, at };
    if (input.type === 'mouseMove') {
      this.lastMove = here;
      this.current = here;
      this.moves++;
    } else if (input.type === 'mouseDown' && input.button === 'left') {
      this.moveBeforeDown = this.lastMove;
      this.movesBeforeDown = this.moves;
      this.moves = 0;
      this.down = here;
      this.up = null;
      this.current = here;
    } else if (input.type === 'mouseUp' && input.button === 'left' && this.down) {
      this.up = here;
      this.current = here;
    }
  }

  press(): Press | null {
    if (!this.down || !this.current) return null;
    return { move: this.moveBeforeDown, down: this.down, up: this.up, current: this.current, moves: this.movesBeforeDown };
  }
}

const inside = (p: { x: number; y: number }, r: Rect) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
const seconds = (ms: number) => String(Math.round(ms / 100) / 10);

/// Checks a press against the button on screen. `holdMs` is the time a hold needs (Go); null for a click (Not now).
export function verifyPress(press: Press | null, rect: Rect | null, now: number, holdMs: number | null): GoClick {
  if (!press) throw new GoError('no mouse press reached the button (keyboard, a script, or a click the window did not see)');
  if (!rect) throw new GoError('the button is not on screen');
  let heldFor = 0;
  if (holdMs !== null) {
    if (press.up) throw new GoError('Go was released before the hold was over');
  } else if (!press.up) {
    throw new GoError('only a left mouse click on the button counts (no mouse-up)');
  }
  if (!press.move) throw new GoError('move the pointer onto the button with the mouse first (no mouse move was seen in this window)');
  // A pointer set onto the button by a program makes no move event, so the press would not be where it last moved.
  if (Math.hypot(press.move.x - press.down.x, press.move.y - press.down.y) > 1) {
    throw new GoError('the pointer jumped onto the button without a mouse move; move it with the mouse, then press');
  }
  if (!inside(press.down, rect)) throw new GoError('the press was not on the button');
  if (holdMs !== null) {
    if (!inside(press.current, rect)) throw new GoError('the pointer left Go during the hold');
    heldFor = now - press.down.at;
    if (heldFor < holdMs) throw new GoError(`Go was held for ${seconds(heldFor)} s; hold it for ${seconds(holdMs)} s`);
    if (heldFor >= holdMs + 5000) throw new GoError('the hold is too old; press Go again');
  } else {
    const up = press.up!;
    if (!inside(up, rect)) throw new GoError('the click ended outside the button');
    if (up.at < press.down.at || now - up.at >= 5000) throw new GoError('the click is too old or out of order');
  }
  const heldMs = holdMs !== null ? heldFor : press.up!.at - press.down.at;
  return { at: now, movedAt: press.move.at, heldFor, press: { x: press.down.x, y: press.down.y, heldMs, moves: press.moves } };
}

// ------------------------------------------------------------------ the log

export interface LogEntry {
  id: string;
  title: string;
  items: string[];
  itemsHash: string;
  requestHash: string;
  answer: Decision;
  note: string | null;
  at: string;
  project: string;
  projectPath: string;
  reviewUrl: string | null;
  prUrl: string | null;
  press?: PressRecord;
  mac?: string;
}

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => (value as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((value as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

/// `go-log.json`: every answer, readable only by this user (0600), each entry signed with HMAC-SHA256 under a key the
/// app keeps in the system store, so an entry written or changed by anything else shows as tampered.
export class GoLog {
  constructor(readonly file: string, private key: () => Buffer) {}

  signature(entry: LogEntry): string {
    const { mac: _mac, ...unsigned } = entry;
    return createHmac('sha256', this.key()).update(stable(unsigned)).digest('hex');
  }

  /// A missing or wrong signature, or no key to check it with, is not valid.
  isValid(entry: LogEntry): boolean {
    try {
      const want = Buffer.from(this.signature(entry));
      const have = Buffer.from(entry.mac ?? '');
      return want.length === have.length && timingSafeEqual(want, have);
    } catch {
      return false;
    }
  }

  /// No file is an empty log; a file that cannot be read or decoded is an error, never an empty log.
  entries(): LogEntry[] {
    if (!existsSync(this.file)) return [];
    const text = readFileSync(this.file, 'utf8');
    if (!text.trim()) return [];
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('the go log is not a list');
    return parsed;
  }

  /// Adds one signed entry. The file is written to a temporary file made 0600, then renamed over the old one.
  append(entry: LogEntry): void {
    let signed: LogEntry;
    try {
      signed = { ...entry, mac: this.signature(entry) };
    } catch (error) {
      throw new GoError(`could not sign the go log (${String(error).replace(/^Error: /, '')}); no answer is recorded`);
    }
    let all: LogEntry[];
    try {
      all = this.entries();
    } catch {
      // A file that cannot be read is kept aside, never overwritten, and a new log starts. If it cannot be moved, the answer is refused.
      try {
        renameSync(this.file, path.join(path.dirname(this.file), `go-log.unreadable-${Date.now()}-${randomBytes(4).toString('hex')}.json`));
      } catch {
        throw new GoError(`${this.file} cannot be read and cannot be moved aside; no answer is recorded`);
      }
      all = [];
    }
    all.push(signed);
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = path.join(path.dirname(this.file), `.go-log.${randomBytes(6).toString('hex')}.tmp`);
      writeFileSync(temporary, JSON.stringify(all, null, 2), { mode: 0o600 });
      // Windows has no file modes; its profile folder is private to the account.
      if (process.platform !== 'win32') chmodSync(temporary, 0o600);
      renameSync(temporary, this.file);
    } catch (error) {
      throw new GoError(`could not write the go log (${String(error).replace(/^Error: /, '')}); no answer is recorded`);
    }
  }
}

// ------------------------------------------------------------------ the desk

interface Shown { id: string; armedFrom: number | null; shownAt: number }
export interface Logged { entry: LogEntry; signatureValid: boolean }

export class GoDesk {
  private requests: GoRequest[] = [];
  private shown = new Map<string, Shown>();
  private front = false;
  private fits = true;
  private seenAll = new Set<string>();
  /// Called after every change.
  onChange: () => void = () => {};

  /// `armMs`: how long a request is on screen, in the window in front, before Go takes a press. `holdMs`: how long Go
  /// must be held down. An accidental click on a panel that just appeared is short; a hold is a decision.
  constructor(readonly log: GoLog, readonly options: { armMs: number; holdMs: number }) {}

  pending(projectId?: string): GoRequest[] {
    return this.requests.filter((r) => !r.answer && (projectId === undefined || r.projectId === projectId));
  }

  all(projectId: string): GoRequest[] {
    return this.requests.filter((r) => r.projectId === projectId);
  }

  request(id: string): GoRequest | undefined {
    return this.requests.find((r) => r.id === id);
  }

  /// Files a request. The same project asking again for the same title, items and links while the first is still
  /// pending gets that first request back; any change makes a new request, listed beside it.
  submit(ask: Pick<GoAsk, 'title' | 'items' | 'reviewUrl' | 'prUrl'>, projectId: string, project: string, projectPath: string, now = Date.now()): GoRequest {
    const hash = requestHash(ask.title, ask.items, ask.reviewUrl, ask.prUrl);
    const same = this.requests.find((r) => !r.answer && r.projectId === projectId && r.requestHash === hash);
    if (same) return same;
    const request: GoRequest = {
      id: `go-${randomBytes(6).toString('hex')}`,
      title: ask.title,
      items: ask.items,
      itemsHash: itemsHash(ask.items),
      requestHash: hash,
      reviewUrl: ask.reviewUrl,
      prUrl: ask.prUrl,
      projectId,
      project,
      projectPath,
      createdAt: now,
    };
    this.requests.push(request);
    // Answered requests stay readable for a while; the log keeps them for good.
    const answered = this.requests.filter((r) => r.answer);
    if (answered.length > 100) {
      const drop = new Set(answered.slice(0, answered.length - 100).map((r) => r.id));
      this.requests = this.requests.filter((r) => !drop.has(r.id));
    }
    this.onChange();
    return request;
  }

  private get canArm(): boolean {
    return this.front && this.fits;
  }

  /// The panel shows this request now (or none). Showing the same one again keeps its time.
  noteShown(projectId: string, id: string | null, now = Date.now()): void {
    if (id === null) {
      this.shown.delete(projectId);
      return;
    }
    if (this.shown.get(projectId)?.id === id) return;
    this.shown.set(projectId, { id, armedFrom: this.canArm ? now : null, shownAt: now });
  }

  /// The window came to the front, left it, was covered, or minimised.
  setFront(front: boolean, now = Date.now()): void {
    if (front === this.front) return;
    this.front = front;
    this.rearm(now);
  }

  /// The whole panel fits inside the window, or does not.
  setFits(fits: boolean, now = Date.now()): void {
    if (fits === this.fits) return;
    this.fits = fits;
    this.rearm(now);
  }

  private rearm(now: number): void {
    for (const s of this.shown.values()) s.armedFrom = this.canArm ? now : null;
  }

  /// The panel moved: the arm delay starts over, so a press meant for something else does not count.
  restartArm(now = Date.now()): void {
    this.rearm(now);
  }

  /// The owner has had every item and link on screen (the list fits, or it was scrolled to the end).
  noteReadToEnd(id: string): void {
    if (this.request(id) && !this.request(id)!.answer) this.seenAll.add(id);
  }

  /// Why Go is off for `id` at `now`, or null when it takes a press.
  goBlocker(id: string, projectId: string, now = Date.now()): string | null {
    const current = this.shown.get(projectId);
    if (!current || current.id !== id) return 'Only the request on screen can be answered.';
    if (!this.fits) return 'The panel does not fit: make the window taller.';
    if (!this.front) return 'Bring this window to the front to give a go.';
    if (!this.seenAll.has(id)) return 'Scroll to the end of the list to enable Go.';
    if (current.armedFrom === null || now - current.armedFrom < this.options.armMs) {
      return `Go turns on ${seconds(this.options.armMs)} seconds after the request is in front.`;
    }
    return null;
  }

  /// Records the owner's answer. `click` proves it came from the mouse (verifyPress).
  answer(id: string, decision: Decision, note: string | null, click: GoClick, now = click.at): GoRequest {
    const request = this.request(id);
    if (!request) throw new GoError(`no request ${id}`);
    if (request.answer) throw new GoError(`request ${id} is already answered`);
    const shown = this.shown.get(request.projectId);
    if (shown?.id !== id) throw new GoError('only the request on screen can be answered');
    if (decision === 'go') {
      const blocker = this.goBlocker(id, request.projectId, now);
      if (blocker) throw new GoError(blocker);
      // The press must start after Go turned on, and the move must be for this request: after a hold approved the
      // request before it, the next one takes its place under the still pointer, and only a new move may approve it.
      if (shown.armedFrom === null || click.at - click.heldFor < shown.armedFrom + this.options.armMs) throw new GoError('press Go after it turns on, then hold it');
      if (click.movedAt < shown.shownAt) throw new GoError('move the pointer onto Go again; it last moved before this request was shown');
      if (click.heldFor < this.options.holdMs) {
        throw new GoError(`Go was held for ${seconds(click.heldFor)} s; hold it for ${seconds(this.options.holdMs)} s, until the bar is full`);
      }
    }
    const trimmed = note?.trim();
    const answer: GoAnswer = { decision, note: trimmed ? trimmed : null, at: click.at };
    // Written and signed before it counts: an answer that is not in the log is not given.
    this.log.append({
      id: request.id,
      title: request.title,
      items: request.items,
      itemsHash: request.itemsHash,
      requestHash: request.requestHash,
      answer: decision,
      note: answer.note,
      at: new Date(answer.at).toISOString(),
      project: request.project,
      projectPath: request.projectPath,
      reviewUrl: request.reviewUrl,
      prUrl: request.prUrl,
      press: click.press,
    });
    request.answer = answer;
    this.shown.delete(request.projectId);
    this.seenAll.delete(id);
    this.onChange();
    return request;
  }

  /// The request's state in this run, or the logged answer for one from before (never a go).
  status(id: string, projectId: string, projectPath?: string): { request?: GoRequest; logged?: Logged } {
    const request = this.request(id);
    if (request) {
      if (request.projectId !== projectId) throw new GoError(`request ${id} belongs to another project`);
      return { request };
    }
    let entry: LogEntry | undefined;
    try {
      entry = this.log.entries().reverse().find((e) => e.id === id);
    } catch {
      entry = undefined;
    }
    if (!entry) throw new GoError(`no request ${id}; requests that were not answered do not survive a restart, so ask again`);
    if (projectPath !== undefined && entry.projectPath !== projectPath) throw new GoError(`request ${id} belongs to another project`);
    return { logged: { entry, signatureValid: this.log.isValid(entry) } };
  }

  /// Waits until the request is answered or `seconds` pass.
  async wait(id: string, secondsToWait: number): Promise<GoRequest | undefined> {
    const deadline = Date.now() + secondsToWait * 1000;
    while (this.request(id) && !this.request(id)!.answer && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    return this.request(id);
  }
}

/// The reply of vibex_go_status: the status alone on the first line, then the details as one line of JSON, so no
/// title or note can pose as a status line.
export function reply(status: string, details: Record<string, unknown>): string {
  const object: Record<string, unknown> = { status };
  for (const [key, value] of Object.entries(details)) if (value !== undefined && value !== null) object[key] = value;
  return `status: ${status}\n${JSON.stringify(Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : 1))))}`;
}

export function describeRequest(request: GoRequest): string {
  return reply(request.answer?.decision ?? 'pending', {
    id: request.id,
    title: request.title,
    items_hash: request.itemsHash,
    request_hash: request.requestHash,
    answered_at: request.answer ? new Date(request.answer.at).toISOString() : undefined,
    note: request.answer?.note,
  });
}

/// An answer found only in the log, from before this run: never a go. The log is a record for audit; anything that
/// can write the file could add a line to it.
export function describeLogged(logged: Logged): string {
  const e = logged.entry;
  return reply('unverified', {
    logged_answer: e.answer,
    log_signature: logged.signatureValid ? 'valid' : 'tampered',
    meaning: 'Answered before this run of Vibex. Not a go: ask again with vibex_request_go.',
    id: e.id,
    title: e.title,
    items_hash: e.itemsHash,
    request_hash: e.requestHash,
    answered_at: e.at,
    note: e.note,
  });
}
