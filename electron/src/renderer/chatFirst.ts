// The chat layout of the PCA edition (chat-first plan, part P3): a new project shows Claude alone, full width. The
// browser and the command terminal start hidden; their buttons stay in the activity bar. A project that had a layout
// before keeps it, and gets one quiet offer of the chat layout. The frame (./frame.ts) owns the per-project record;
// this file is the one place other parts ask (part P4 asks before it shows a hidden pane).

import type { PaneName } from './frame';

/// The panes of the chat layout.
export const CHAT_PANES: Readonly<Record<PaneName, boolean>> = Object.freeze({ agent: true, browser: false, shell: false });

/// Set by main at start (preload `chatFirst`). True in every build a person installs; a test run turns it on only
/// with VIBEX_CHAT_FIRST=1.
export function chatFirstEdition(): boolean {
  return (window as any).vibex?.chatFirst !== false;
}

let probe: (projectId: string) => boolean = () => false;

/// The frame tells this file how to read its record. Called once, by createFrame.
export function setChatFirstProbe(fn: (projectId: string) => boolean): void {
  probe = fn;
}

/// True when this project uses the chat layout: it was new in a chat-first edition, or the person took the offer.
/// A project that kept its older layout is not chat-first, even if the person later hides the same panes by hand.
export function isChatFirst(projectId: string): boolean {
  return chatFirstEdition() && probe(projectId);
}
