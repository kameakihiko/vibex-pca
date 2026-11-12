import type { BrowserWindow } from 'electron';
import { PointerTracker, verifyPress, type GoClick, type Rect } from './goDesk';

// The proof of a press, for the Go panel and for the hold questions: the mouse input of the window as main sees it, and
// the button's place as main reads it. A page script cannot make the input, and it no longer tells main where a button is
// (security review L1, L2). What it does not stop: a script that moves the button itself under the pointer of a person
// who holds the mouse down for the whole hold.

/// A JavaScript world of main's own, so a page script that replaces getBoundingClientRect changes nothing here.
const WORLD = 1701;

export class WindowPointer {
  readonly tracker = new PointerTracker();

  constructor(private readonly win: BrowserWindow) {
    win.webContents.on('input-event', (_event, input) => {
      const mouse = input as Electron.MouseInputEvent;
      if (mouse.type === 'mouseDown' || mouse.type === 'mouseUp' || mouse.type === 'mouseMove') {
        this.tracker.feed({ type: mouse.type, x: mouse.x, y: mouse.y, button: mouse.button }, Date.now());
      }
    });
  }

  /// The button in window pixels, or null when it is absent or something covers it. The page measures in zoomed pixels.
  async buttonRect(selector: string): Promise<Rect | null> {
    const code = `(() => {
      const b = document.querySelector(${JSON.stringify(selector)});
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!top || !(top === b || b.contains(top))) return null;
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`;
    const rect = await this.win.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]) as Rect | null;
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
    const zoom = this.win.webContents.getZoomFactor();
    return { x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom };
  }

  /// `holdMs`: the time a hold needs; null for a click. Throws with the reason in plain words.
  async verify(selector: string, holdMs: number | null): Promise<GoClick> {
    const rect = await this.buttonRect(selector);
    return verifyPress(this.tracker.press(), rect, Date.now(), holdMs);
  }
}

/// The hold of a question: a press on its button that began after the arm time, by a mouse that moved after it came on
/// screen. The page's own frames and main's clock differ a little, so each time has 50 ms to spare, as the time check has.
export const holdProofOf = (pointer: WindowPointer) => async ({ shownAt, armMs, holdMs }: { shownAt: number; armMs: number; holdMs: number }): Promise<string | null> => {
  try {
    const click = await pointer.verify('#vxq-hold', holdMs - 50);
    if (click.at - click.heldFor < shownAt + armMs - 50) return 'the press began before the button turned on';
    if (click.movedAt < shownAt) return 'the pointer last moved before this question came';
    return null;
  } catch (error) {
    return String(error).replace(/^(Go)?Error: /, '');
  }
};

const pointers = new WeakMap<BrowserWindow, WindowPointer>();

/// One listener per window, whoever asks.
export function pointerOf(win: BrowserWindow): WindowPointer {
  let pointer = pointers.get(win);
  if (!pointer) pointers.set(win, (pointer = new WindowPointer(win)));
  return pointer;
}
