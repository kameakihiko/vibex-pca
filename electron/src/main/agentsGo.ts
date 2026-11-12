import { AgentsService } from './agents';
import { GoService } from './go';
import { InboxService } from './inbox';
import type { VibexModule } from './modules';

// Agents (worktrees), the Go gate and the Inbox (macOS Vibex: Agents/, Go/, Inbox/). One module; each part has its own file.
const inbox = new InboxService();
export const agentsInbox = () => inbox;
const agents = new AgentsService();
const go = new GoService();

export const agentsGoModule: VibexModule = {
  name: 'agents-go',
  start(host) {
    inbox.start(host);
    agents.start(host, inbox);
    go.start(host, inbox);
  },
  tools(server, ctx) {
    inbox.tools(server, ctx);
    go.tools(server, ctx);
  },
};
