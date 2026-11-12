import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { agentsGoModule } from './agentsGo';
import type { MenuItemConstructorOptions } from 'electron';
import { pcaToolsModule } from './pcaTools';
import type { BrowserPane } from './browser';
import { browserModule } from './browserTools';
import { serversModule } from './serverHub';
import { pcaEditionModule } from './pcaEdition';
import { updaterModule } from './updater';
import type { ProjectInfo, Projects } from './projects';
import { notesModule } from './notes';
import type { Terminals } from './terminals';
import { filesGit } from './filesGit';
import { chatModule } from './chat';
import type { InboxService } from './inbox';

// One feature, one file: a feature adds one line to MODULES and keeps its IPC, tools and state in its own file.
// IPC channels of a module start with "mod:"; the preload refuses any other channel for the renderer's mod bridge.

export interface ModuleHost {
  handle: (channel: `mod:${string}`, fn: (...args: any[]) => unknown) => void;
  on: (channel: `mod:${string}`, fn: (...args: any[]) => void) => void;
  send: (channel: `mod:${string}`, ...args: unknown[]) => void;
  projects: Projects;
  terminals: Terminals;
  browserFor: (project: ProjectInfo) => BrowserPane;
  reveal: (project: ProjectInfo, pane: 'agent' | 'browser' | 'shell') => void;
  userData: string;
  /// Asks as Quit does, when tabs run. True means the next close goes through.
  agreeToQuit: () => Promise<boolean>;
  /// The quit did not happen after all: the next close asks again.
  cancelQuit: () => void;
  /// The Inbox of the app, for a module with something that waits for the person.
  inbox: () => InboxService;
}

export interface ToolContext {
  /// Which project this call is for; throws when that cannot be told, so nothing acts.
  project: (projectPath?: string) => ProjectInfo;
  /// A text result that names the project when several are open.
  said: (result: string, target: ProjectInfo) => { content: { type: 'text'; text: string }[] };
  /// The optional project_path input of a tool that acts on a project.
  scope: Record<string, any>;
}

export interface VibexModule {
  name: string;
  /// Runs once at app start, after the window exists.
  start?: (host: ModuleHost) => void;
  /// Adds MCP tools. Runs once per MCP request, so it holds no state of its own.
  tools?: (server: McpServer, ctx: ToolContext) => void;
  /// Items for the menu bar: `menu` is the top-level menu's label without the & ("View", "Run"). A menu that no module
  /// fills is not made, except the ones the app has.
  menu?: (command: (name: string, arg?: string) => () => void) => { menu: string; items: MenuItemConstructorOptions[] }[];
}

/// The items that modules add to one top-level menu.
export function moduleMenu(menu: string, command: (name: string, arg?: string) => () => void): MenuItemConstructorOptions[] {
  return MODULES.flatMap((m) => m.menu?.(command) ?? []).filter((m) => m.menu === menu).flatMap((m) => m.items);
}

export const MODULES: VibexModule[] = [
  browserModule,
  filesGit,
  notesModule,
  agentsGoModule,
  pcaToolsModule,
  serversModule,
  pcaEditionModule,
  updaterModule,
  chatModule,
];
