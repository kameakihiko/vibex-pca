/// A menu shortcut as a key press. Electron gives a menu shortcut only the keys that the page did not use, and a
/// terminal uses nearly all of them: Ctrl+3 goes to the shell as an escape and Ctrl+PageDown as an escape sequence. So
/// the app reads its own shortcuts before the page does. By the physical key, so they work on a Cyrillic layout too.
export interface KeyInput {
  code: string;
  control: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

const NAMED: Record<string, string> = { Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown' };

function codeOf(key: string): string {
  if (/^[A-Z]$/.test(key)) return `Key${key}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return NAMED[key] ?? key;
}

export function matchesAccelerator(accelerator: string, input: KeyInput, mac = process.platform === 'darwin'): boolean {
  const wanted = { control: false, shift: false, alt: false, meta: false };
  let key = '';
  for (const part of accelerator.split('+')) {
    if (part === 'CmdOrCtrl') wanted[mac ? 'meta' : 'control'] = true;
    else if (part === 'Cmd') wanted.meta = true;
    else if (part === 'Ctrl') wanted.control = true;
    else if (part === 'Alt') wanted.alt = true;
    else if (part === 'Shift') wanted.shift = true;
    else key = part;
  }
  return !!key && input.code === codeOf(key) && input.control === wanted.control && input.shift === wanted.shift && input.alt === wanted.alt && input.meta === wanted.meta;
}
