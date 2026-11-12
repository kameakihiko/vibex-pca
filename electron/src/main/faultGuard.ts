import { appendFileSync, renameSync, statSync } from 'node:fs';

// With no listener, a promise that fails in the main process becomes the box "A JavaScript error occurred in the main
// process", with a stack, and at Exit it holds the quit until someone answers. Here it goes to a log, and the person reads
// one plain line, once.

/// A quit while the app starts makes the start fail: loadURL rejects when the window goes before its page has loaded. That is
/// no failure to tell anyone, and the error box would hold the quit for good, because a modal box stops the app's loop.
export function startEndedByQuit(s: { quitting: boolean; windowMade: boolean; windowGone: boolean }): boolean {
  return s.quitting || (s.windowMade && s.windowGone);
}

const PLAIN = 'Something went wrong in the background. Your work is safe, and you can keep working. If a tab stops responding, close Vibex PCA and open it again.';
const LOG_LIMIT = 256 * 1024;
const TEXT_LIMIT = 2000;

/// node-pty asks for the list of a console's processes with fork, which the off runAsNode fuse refuses. The tree ended by taskkill before this, so nothing is lost.
export const isForkRefusal = (reason: unknown) => /child_process\.fork\(\) is not supported/.test(String((reason as Error)?.message ?? reason));

function faultText(kind: string, reason: unknown): string {
  const text = (reason as Error)?.stack ?? String(reason);
  return `${new Date().toISOString()} ${kind}: ${text.replace(/Bearer\s+\S+/gi, 'Bearer [hidden]').slice(0, TEXT_LIMIT)}`;
}

export function installFaultGuard(proc: NodeJS.EventEmitter, out: { log: (text: string) => void; show: (text: string) => void }): void {
  let shown = false;
  const fault = (kind: string) => (reason: unknown) => {
    out.log(faultText(kind, reason));
    if (shown || isForkRefusal(reason)) return;
    shown = true;
    out.show(PLAIN);
  };
  proc.on('unhandledRejection', fault('unhandled rejection'));
  proc.on('uncaughtException', fault('uncaught exception'));
}

/// One line per fault in a file with a limit; the last full file stays as `<file>.old`. A log that cannot be written must not raise a new fault.
export function boundedLog(file: string, limit = LOG_LIMIT): (text: string) => void {
  return (text) => {
    try {
      const line = `${text.slice(0, limit - 1)}\n`;
      let size = 0;
      try {
        size = statSync(file).size;
      } catch { /* the first line */ }
      if (size + Buffer.byteLength(line) > limit) renameSync(file, `${file}.old`);
      appendFileSync(file, line);
    } catch { /* nothing more can be done from here */ }
  };
}
