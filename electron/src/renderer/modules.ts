import { filesGitModule } from './filesGit';
import { agentsGoModule } from './agentsGo';
import { notesModule } from './notes';
import type { createFrame, ProjectInfo } from './frame';
import { pcaToolsRenderer } from './pcaTools';
import { serversRenderer } from './servers';
import { pcaEditionRenderer } from './pcaEdition';
import { updaterRenderer } from './updater';

// The renderer side of one feature. A module fills a sidebar section, adds an activity button, or opens a document
// tab in the middle column (docs.ts). It adds one line to RENDERER_MODULES.

export interface Section {
  /// An id of the frame (files, git, agents, skills, mcp) replaces that section's content; a new id adds a button.
  id: string;
  title: string;
  icon: string;
  label: string;
  help: string;
  /// Fills the sidebar body. Called each time the section or the project changes; the body is empty at the call.
  /// A slow render checks `live()` after each await, because the person may have moved on.
  render: (body: HTMLElement, project: ProjectInfo, live: () => boolean) => void | Promise<void>;
}

export interface RendererModule {
  name: string;
  sections?: Section[];
  /// Runs once after the frame exists. `app.frame` is the frame's own handle (panes, sections, layout).
  start?: (app: { frame: ReturnType<typeof createFrame> }) => void;
}

export const RENDERER_MODULES: RendererModule[] = [
  filesGitModule,
  notesModule,
  agentsGoModule,
  pcaToolsRenderer,
  serversRenderer,
  pcaEditionRenderer,
  updaterRenderer,
];
