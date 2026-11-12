import { mcpSection } from './mcpServers';
import type { RendererModule } from './modules';
import { openPalette } from './palette';
import { api } from './pcaUi';
import { startRun } from './run';
import { openSetup } from './setup';
import { skillsSection } from './skills';
import { openUsage } from './usage';
import { startWorkspace } from './workspace';

// Skills, MCP servers, Run, the command palette, Setup and Usage. Main side: ../main/pcaTools.ts.
// Skills and MCP fill the sidebar sections of the same names; Setup and Usage open as tabs in the middle column,
// so the activity bar keeps the buttons it has.

export const pcaToolsRenderer: RendererModule = {
  name: 'pca-tools',
  sections: [skillsSection, mcpSection],
  start: ({ frame }) => {
    startRun();
    startWorkspace(frame);
    api().menu.onCommand((name: string) => {
      const project = frame.current()?.id ?? null;
      if (name === 'palette') void openPalette(project);
      else if (name === 'setup') openSetup(project);
      else if (name === 'usage' && project) openUsage(project);
    });
  },
};
