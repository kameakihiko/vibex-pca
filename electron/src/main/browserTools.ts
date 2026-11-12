import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { app } from 'electron';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { flushTabStore, hasSavedTabs, setTabStore } from './browser';
import type { ModuleHost, ToolContext, VibexModule } from './modules';
import { asServerCaller } from './serverGuard';

// The browser's page tabs and its tools, as in macOS Vibex (MCP/Tools/BrowserTools.swift, vibex_preview in WorkspaceTools.swift).

let host: ModuleHost | null = null;

const tabArg = { tab: z.number().int().optional().describe('Tab number from browser_tabs; defaults to the selected tab') };

/// vibex_preview: an http(s) address, or the absolute path of a local .html file. Returns the address to open, or the real
/// path of the file, and which of the two it is.
export function previewTarget(input: string): { url: string; file: boolean } {
  const text = input.trim();
  if (/^https?:\/\//i.test(text)) return { url: text, file: false };
  if (path.isAbsolute(text) && /\.html?$/i.test(text)) {
    let real: string;
    try {
      real = realpathSync.native(text);
      if (!statSync(real).isFile()) throw new Error('not a file');
    } catch {
      throw new Error(`there is no file at ${text}`);
    }
    // The real path must still be a .html file: a link named review.html must not lead to another kind of file.
    if (!/\.html?$/i.test(real)) throw new Error(`${text} leads to a file that is not .html`);
    return { url: real, file: true };
  }
  throw new Error('vibex_preview opens an http or https address, or the absolute path of a local .html file');
}

function registerTools(server: McpServer, ctx: ToolContext): void {
  const paneOf = (projectPath?: string) => {
    if (!host) throw new Error('the browser is not ready yet');
    return host.browserFor(ctx.project(projectPath));
  };
  /// Brings the browser column forward for the project, so the person sees what is driven.
  const show = (projectPath?: string) => host!.reveal(ctx.project(projectPath), 'browser');
  const said = async (result: Promise<string>, projectPath?: string) => ctx.said(await result, ctx.project(projectPath));
  /// ctx.scope is the shared project_path input; the cast gives it its type back.
  const scope = ctx.scope as { project_path: z.ZodOptional<z.ZodString> };

  server.registerTool('browser_tabs', {
    description: "List the side browser's tabs with their numbers, titles and URLs. The selected tab is marked with *.",
    inputSchema: { ...scope },
  }, ({ project_path }) => said(paneOf(project_path).describeTabs(), project_path));

  server.registerTool('browser_new_tab', {
    description: "Open a new tab (and select it). Use this instead of navigating the user's tab, which may be playing video.",
    inputSchema: { url: z.string().optional().describe('URL to load; omit for an empty tab'), ...scope },
  }, async ({ url, project_path }) => {
    const { number, status } = await paneOf(project_path).newTab(url);
    show(project_path);
    return ctx.said(`Opened tab #${number}: ${status}`, ctx.project(project_path));
  });

  server.registerTool('browser_close_tab', {
    description: 'Close a tab.',
    inputSchema: { tab: z.number().int().describe('Tab number'), ...scope },
  }, async ({ tab, project_path }) => {
    paneOf(project_path).close(tab);
    return ctx.said('Closed.', ctx.project(project_path));
  });

  server.registerTool('browser_select_tab', {
    description: 'Bring a tab to the front.',
    inputSchema: { tab: z.number().int().describe('Tab number'), ...scope },
  }, async ({ tab, project_path }) => {
    paneOf(project_path).select(tab);
    show(project_path);
    return ctx.said('Selected.', ctx.project(project_path));
  });

  server.registerTool('browser_navigate', {
    description: 'Load a URL (or search text) in a tab and wait for it to finish loading.',
    inputSchema: { url: z.string().describe('URL or search query'), ...tabArg, ...scope },
  }, async ({ url, tab, project_path }) => {
    const result = await paneOf(project_path).navigate(url, tab);
    show(project_path);
    return ctx.said(result, ctx.project(project_path));
  });

  server.registerTool('browser_back', {
    description: "Go back in a tab's history.",
    inputSchema: { ...tabArg, ...scope },
  }, ({ tab, project_path }) => said(paneOf(project_path).backAndWait(tab), project_path));

  server.registerTool('browser_forward', {
    description: "Go forward in a tab's history.",
    inputSchema: { ...tabArg, ...scope },
  }, ({ tab, project_path }) => said(paneOf(project_path).forwardAndWait(tab), project_path));

  server.registerTool('browser_reload', {
    description: 'Reload a tab.',
    inputSchema: { ...tabArg, ...scope },
  }, ({ tab, project_path }) => said(paneOf(project_path).reloadAndWait(tab), project_path));

  server.registerTool('browser_snapshot', {
    description: 'Compact accessibility-style tree of the page: roles, names, states and element refs like [ref=e12]. Call it before clicking or typing, and again after the page changes; refs are invalidated by each snapshot.',
    inputSchema: { ...tabArg, ...scope },
  }, ({ tab, project_path }) => said(paneOf(project_path).snapshot(tab), project_path));

  server.registerTool('browser_click', {
    description: 'Click an element by ref from browser_snapshot.',
    inputSchema: { ref: z.string().describe('Element ref, e.g. e12'), ...tabArg, ...scope },
  }, ({ ref, tab, project_path }) => said(paneOf(project_path).click(ref, tab), project_path));

  server.registerTool('browser_type', {
    description: 'Type into a text field or editable element by ref. Replaces the current value. Set submit to press Enter afterwards.',
    inputSchema: {
      ref: z.string().describe('Element ref'),
      text: z.string().describe('Text to enter'),
      submit: z.boolean().optional().describe('Press Enter after typing'),
      ...tabArg,
      ...scope,
    },
  }, ({ ref, text, submit, tab, project_path }) => said(paneOf(project_path).type(ref, text, submit ?? false, tab), project_path));

  server.registerTool('browser_press', {
    description: 'Press a key on the focused element: Enter, Escape, Tab, Backspace, ArrowDown… or a single character.',
    inputSchema: { key: z.string().describe('Key name'), ...tabArg, ...scope },
  }, ({ key, tab, project_path }) => said(paneOf(project_path).press(key, tab), project_path));

  server.registerTool('browser_scroll', {
    description: 'Scroll the page (or a scrollable element by ref) by dx, dy pixels.',
    inputSchema: {
      ref: z.string().optional().describe('Optional element ref'),
      dx: z.number().optional().describe('Horizontal pixels'),
      dy: z.number().optional().describe('Vertical pixels, positive = down'),
      ...tabArg,
      ...scope,
    },
  }, ({ ref, dx, dy, tab, project_path }) => said(paneOf(project_path).scroll(ref, dx ?? 0, dy ?? 600, tab), project_path));

  server.registerTool('browser_text', {
    description: "The page's visible text (innerText), for reading articles or results without a snapshot.",
    inputSchema: { ...tabArg, ...scope },
  }, ({ tab, project_path }) => said(paneOf(project_path).text(tab), project_path));

  server.registerTool('browser_screenshot', {
    description: 'JPEG screenshot of a tab, downscaled. Use when layout or images matter; prefer browser_snapshot for structure.',
    inputSchema: { maxWidth: z.number().int().positive().optional().describe('Max image width in pixels (default 1024)'), ...tabArg, ...scope },
  }, async ({ maxWidth, tab, project_path }) => {
    const jpeg = await paneOf(project_path).screenshot(maxWidth ?? 1024, tab);
    return { content: [{ type: 'image' as const, data: jpeg.toString('base64'), mimeType: 'image/jpeg' }] };
  });

  server.registerTool('browser_evaluate', {
    description: 'Run JavaScript in the page and return the result as JSON. Promises are awaited. Powerful; prefer the ref-based tools for normal interaction.',
    inputSchema: { js: z.string().describe('JavaScript expression or statements'), ...tabArg, ...scope },
  }, ({ js, tab, project_path }) => said(paneOf(project_path).run(js, tab), project_path));

  server.registerTool('browser_console', {
    description: 'Console messages and uncaught errors the tab logged (newest last).',
    inputSchema: {
      clear: z.boolean().optional().describe('Clear the buffer after reading'),
      level: z.string().optional().describe('Only this level: log, info, warn, error'),
      ...tabArg,
      ...scope,
    },
  }, ({ clear, level, tab, project_path }) => said(paneOf(project_path).consoleLines(tab, level, clear === true), project_path));

  server.registerTool('browser_requests', {
    description: 'Recent fetch/XHR requests the page made: method, URL, status, duration.',
    inputSchema: {
      clear: z.boolean().optional().describe('Clear the buffer after reading'),
      failedOnly: z.boolean().optional().describe('Only non-2xx or failed requests'),
      ...tabArg,
      ...scope,
    },
  }, ({ clear, failedOnly, tab, project_path }) => said(paneOf(project_path).requestLines(tab, failedOnly === true, clear === true), project_path));

  server.registerTool('browser_wait', {
    description: 'Wait for milliseconds, for a CSS selector to appear, or for text to appear on the page.',
    inputSchema: {
      ms: z.number().int().optional().describe('Milliseconds to wait'),
      selector: z.string().optional().describe('CSS selector to wait for'),
      text: z.string().optional().describe('Text to wait for'),
      timeout: z.number().optional().describe('Seconds before giving up (default 15)'),
      ...tabArg,
      ...scope,
    },
  }, ({ ms, selector, text, timeout, tab, project_path }) => said(paneOf(project_path).wait({ ms, selector, text, timeout: timeout ?? 15 }, tab), project_path));

  server.registerTool('vibex_preview', {
    description: 'Show the user something to look at, in this project\'s window, without asking them to open it: a demo or dev server, a PR page, a before/after review page (URL or absolute file path). A local file shows alone, with no other file and no network, so keep its images and styles inside it. desktop opens a browser tab. phone and tablet need the iOS Simulator, which Vibex PCA does not have; they answer with a refusal. Use this whenever a demo, preview or review page is ready.',
    inputSchema: {
      url: z.string().describe('http(s) URL, or an absolute path to a local .html file (desktop only)'),
      device: z.enum(['desktop', 'phone', 'tablet']).optional().describe('desktop (browser, default); phone and tablet are not available here'),
      ...scope,
    },
  }, async ({ url, device, project_path }) => {
    if (device === 'phone' || device === 'tablet') {
      throw new Error(`device ${device} is not available in Vibex PCA: there is no Simulator. Use device desktop to open the page in a browser tab.`);
    }
    const target = previewTarget(url);
    const { number, status } = await paneOf(project_path).newTab(target.file ? undefined : target.url, target.file ? target.url : undefined);
    show(project_path);
    return ctx.said(`Opened ${target.file ? 'the local file' : 'the page'} in tab #${number}: ${status}`, ctx.project(project_path));
  });
}

/// The page-tab commands of the tab strip in the window. They act on the project on screen.
function registerIpc(h: ModuleHost): void {
  const current = () => {
    const project = h.projects.current();
    if (!project) throw new Error('no project is open');
    return project;
  };
  const number = (value: unknown): number => {
    if (!Number.isInteger(value)) throw new Error('bad tab number');
    return value as number;
  };
  // The tabs saved from the last run. A project with none has no browser yet, and asking must not make one.
  h.handle('mod:browser:tabs', () => {
    const project = h.projects.current();
    return project && hasSavedTabs(project.id) ? h.browserFor(project).state() : null;
  });
  h.handle('mod:browser:new', () => {
    void h.browserFor(current()).newTab();
  });
  h.handle('mod:browser:select', (n: unknown) => h.browserFor(current()).select(number(n)));
  h.handle('mod:browser:close', (n: unknown) => h.browserFor(current()).close(number(n)));
  // A link in a terminal. In a server project the server printed that text, so it has the server's rights and not the
  // person's: it cannot open a page of this computer or the LAN (security review N11). The answer says how it went.
  h.handle('mod:browser:terminal-link', async (url: unknown): Promise<{ opened: boolean; message?: string }> => {
    if (typeof url !== 'string') throw new Error('bad link');
    const project = current();
    const pane = h.browserFor(project);
    try {
      await (project.server ? asServerCaller(() => pane.navigate(url)) : pane.navigate(url));
      return { opened: true };
    } catch (error) {
      return { opened: false, message: String(error).replace(/^Error: /, '') };
    }
  });
}

export const browserModule: VibexModule = {
  name: 'browser',
  start(h) {
    host = h;
    setTabStore(path.join(h.userData, 'browser-tabs.json'));
    app.on('will-quit', flushTabStore);
    registerIpc(h);
  },
  tools: registerTools,
};
