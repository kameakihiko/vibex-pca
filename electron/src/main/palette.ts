import type { Menu, MenuItem } from 'electron';

// The command palette lists the commands of the menu bar, as macOS Vibex's palette lists its menu commands
// (Palette/CommandCatalog.swift), so the palette, the menu and the keyboard stay one set of commands.

export interface PaletteCommand {
  /// Stable text from the menu path and the label, so the palette can ask for the same item again.
  id: string;
  title: string;
  /// Where it sits in the menu bar: "View".
  path: string;
  shortcut?: string;
}

const clean = (label: string) => label.replace(/&/g, '').replace(/…|\.\.\./g, '');

export function shortcutText(accelerator: string, mac = process.platform === 'darwin'): string {
  return accelerator.replace(/CmdOrCtrl/g, mac ? 'Cmd' : 'Ctrl');
}

function walk(menu: Menu | null | undefined, path: string, out: { command: PaletteCommand; item: MenuItem }[]): void {
  for (const item of menu?.items ?? []) {
    if (item.type === 'separator' || !item.visible) continue;
    const label = clean(item.label);
    if (item.submenu) {
      walk(item.submenu, path ? `${path} › ${label}` : label, out);
      continue;
    }
    // A role (Copy, Quit, Zoom) belongs to the page or the system, not to a palette row. A palette row for the palette
    // itself would only open it again.
    if (item.role || !item.enabled || !label || label === 'Command Palette') continue;
    out.push({
      command: { id: `${path}|${label}`, title: label, path, shortcut: item.accelerator ? shortcutText(String(item.accelerator)) : undefined },
      item,
    });
  }
}

export function menuCommands(menu: Menu | null | undefined): PaletteCommand[] {
  const out: { command: PaletteCommand; item: MenuItem }[] = [];
  walk(menu, '', out);
  return out.map((o) => o.command);
}

/// Runs the menu item the palette row stands for. False when the menu changed and the item is gone.
export function runMenuCommand(menu: Menu | null | undefined, id: string): boolean {
  const out: { command: PaletteCommand; item: MenuItem }[] = [];
  walk(menu, '', out);
  const found = out.find((o) => o.command.id === id);
  if (!found) return false;
  found.item.click();
  return true;
}
