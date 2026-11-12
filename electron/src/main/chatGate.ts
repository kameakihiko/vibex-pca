import type { GoClick } from './goDesk';

// Who may answer an approval card. The app window's own input, as main sees it (Electron's `input-event` and
// `before-input-event`), and nothing else: a script in the window, a page in the side browser, a tool or the text of a
// message makes no such input. What it does not stop is a program that injects OS-level input (see main/go.ts).

/// How long a card is on screen before it takes a press, so a click meant for something else does not land on it.
export const ARM_MS = 500;
/// How old a real key may be when the page's answer about it arrives.
const KEY_MS = 1000;

export interface ApprovalProof {
  /// When the card came on screen, by main's clock; null when the window never said so.
  shownAt: number | null;
  now: number;
  /// A click main read off the window's own mouse input (windowPointer.ts).
  click?: Pick<GoClick, 'at' | 'movedAt' | 'heldFor'>;
  /// When main last saw a real key that answers a card.
  keyAt?: number;
}

/// Why this answer does not count, in plain words, or null when it does.
export function approvalRefusal({ shownAt, now, click, keyAt }: ApprovalProof): string | null {
  if (shownAt === null) return 'This card is not on screen.';
  const armed = shownAt + ARM_MS;
  if (keyAt !== undefined && now - keyAt <= KEY_MS) return keyAt < armed ? 'That was too soon after the card came. Press the key again.' : null;
  if (!click) return 'An answer needs a click or a key in this window.';
  if (click.at < armed) return 'That was too soon after the card came. Click again.';
  if (click.movedAt < shownAt) return 'Move the pointer onto the button, then click. It last moved before this card came.';
  return null;
}
