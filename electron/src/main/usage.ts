import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// How often each feature is used, per local day, so the owner can see which features earn their place
// (macOS Vibex: Support/Usage.swift). Counts only: a key is a fixed feature name from the code (`mcp.browser_click`,
// `ui.run.button`), never a URL, an argument, a path, a command, typed text or a project name. Kept on this computer in
// `<userData>/usage.json` for 180 days. Nothing is sent anywhere.

export const RETENTION_DAYS = 180;
const SAVE_DELAY_MS = 10_000;

export interface UsageRow { feature: string; last7: number; last30: number }

/// Letters, digits and `._:-` only, at most 80 characters: a key can never carry a path or a sentence.
export function sanitized(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 80);
  return cleaned || 'other';
}

/// The key for one tool call: only the tool's name, plus the view of vibex_view when it is one of the listed values.
export function toolKey(name: string, args: Record<string, unknown> = {}): string {
  let key = `mcp.${name}`;
  if (name === 'vibex_view') key += `.${['browser', 'both', 'simulator', 'notes'].includes(String(args.view)) ? args.view : 'other'}`;
  return key;
}

export function dayKey(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/// `count` local days ending at `date`, that day first.
export function dayKeys(date: Date, count: number): string[] {
  return Array.from({ length: count }, (_, i) => dayKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() - i)));
}

export class UsageCounter {
  days: Record<string, Record<string, number>> = {};
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  /// `file` is null in tests that count in memory only.
  constructor(private file: string | null, private now: () => Date = () => new Date()) {
    if (file) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed && typeof parsed.days === 'object') this.days = parsed.days;
      } catch {
        // No file yet, or one that does not read: counting starts again. A bad file is kept aside at the first write.
        if (existsSync(file)) this.keepAside = true;
      }
    }
    this.prune();
  }
  private keepAside = false;

  count(key: string): void {
    const day = dayKey(this.now());
    const counts = (this.days[day] ??= {});
    const k = sanitized(key);
    counts[k] = (counts[k] ?? 0) + 1;
    this.dirty = true;
    if (this.file && !this.timer) {
      this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
      this.timer.unref();
    }
  }

  /// Every counted feature with its last-7 and last-30-day totals (today included), most used first.
  rows(): UsageRow[] {
    const week = new Set(dayKeys(this.now(), 7));
    const month = new Set(dayKeys(this.now(), 30));
    const seven: Record<string, number> = {};
    const thirty: Record<string, number> = {};
    for (const [day, counts] of Object.entries(this.days)) {
      for (const [feature, n] of Object.entries(counts)) {
        if (week.has(day)) seven[feature] = (seven[feature] ?? 0) + n;
        if (month.has(day)) thirty[feature] = (thirty[feature] ?? 0) + n;
      }
    }
    return Object.keys(thirty)
      .map((feature) => ({ feature, last7: seven[feature] ?? 0, last30: thirty[feature] }))
      .sort((a, b) => b.last30 - a.last30 || b.last7 - a.last7 || (a.feature < b.feature ? -1 : 1));
  }

  /// The same table as plain text, for the vibex_usage tool.
  table(): string {
    const rows = this.rows();
    if (!rows.length) return 'No usage counted yet.';
    const width = Math.max(...rows.map((r) => r.feature.length), 'feature'.length);
    const line = (a: string, b: string, c: string) => `${a.padEnd(width)}  ${b.padStart(7)}  ${c.padStart(8)}`;
    return [`Vibex usage on this computer, counts per feature (today is ${dayKey(this.now())}, local days):`, '', line('feature', '7 days', '30 days'), ...rows.map((r) => line(r.feature, String(r.last7), String(r.last30)))].join('\n');
  }

  /// Drops days older than the retention. A day with a key of another shape is dropped too.
  prune(): void {
    const oldest = dayKeys(this.now(), RETENTION_DAYS).at(-1)!;
    for (const day of Object.keys(this.days)) if (day.length !== 10 || day < oldest) delete this.days[day];
  }

  /// Writes now (app quit, tests). A temporary file replaces usage.json, so a half-written file is never seen.
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.prune();
    if (!this.file || !this.dirty) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      if (this.keepAside) {
        rmSync(`${this.file}.bad`, { force: true });
        renameSync(this.file, `${this.file}.bad`);
        this.keepAside = false;
      }
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, days: this.days }, null, 1), { mode: 0o600 });
      try {
        chmodSync(temp, 0o600);
      } catch {
        // Windows has no mode bits; the file sits in the person's own profile.
      }
      renameSync(temp, this.file);
      this.dirty = false;
    } catch {
      // Counting must never break the app; the counts stay in memory and the next flush tries again.
    }
  }
}

/// The counter of the running app. Set at start; a count before that is dropped.
let shared: UsageCounter | null = null;
export const setUsage = (counter: UsageCounter): void => { shared = counter; };
export const usage = (): UsageCounter | null => shared;
export const countUsage = (key: string): void => shared?.count(key);

/// Makes every tool the server registers from now on count itself by name. Called once per MCP request, before the
/// tools are added, so no tool needs to know about the counter.
export function countTools(server: { registerTool: (...args: any[]) => any }): void {
  const register = server.registerTool.bind(server);
  server.registerTool = (name: string, config: unknown, cb: (...args: any[]) => unknown) =>
    register(name, config, (...args: any[]) => {
      countUsage(toolKey(name, args.length > 1 ? args[0] : {}));
      return cb(...args);
    });
}
