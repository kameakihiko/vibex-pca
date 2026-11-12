import { agentsSection } from './agents';
import { setRailBadge } from './frame';
import { onGo, startGo } from './go';
import { inboxSection, onInbox, startInbox, type InboxState } from './inbox';
import type { RendererModule } from './modules';

// Agents, the Go gate and the Inbox (macOS Vibex: Agents/, Go/, Inbox/). The rail tile of a project counts what its
// Claude waits for: questions from the hooks, and requests for a go.

let waiting = new Map<string, number>();
let asking = new Map<string, number>();
const shown = new Set<string>();

function badges(): void {
  const ids = new Set([...waiting.keys(), ...asking.keys(), ...shown]);
  shown.clear();
  for (const id of ids) {
    const n = (waiting.get(id) ?? 0) + (asking.get(id) ?? 0);
    setRailBadge(id, n);
    if (n) shown.add(id);
  }
}

export const agentsGoModule: RendererModule = {
  name: 'agents-go',
  sections: [agentsSection, inboxSection],
  start() {
    onInbox((s: InboxState) => {
      waiting = new Map();
      for (const w of s.waiting) waiting.set(w.projectId, (waiting.get(w.projectId) ?? 0) + 1);
      badges();
    });
    onGo((pending) => {
      asking = pending;
      badges();
    });
    startInbox();
    startGo();
  },
};
