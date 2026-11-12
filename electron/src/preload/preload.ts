import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';

type Listener = (...args: any[]) => void;

// Each subscription returns an unsubscribe function; the raw IPC event never reaches the page.
function listen(channel: string, fn: Listener): () => void {
  const wrapped = (_e: IpcRendererEvent, ...args: unknown[]) => fn(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

function modChannel(channel: string): string {
  if (!String(channel).startsWith('mod:')) throw new Error(`not a module channel: ${channel}`);
  return channel;
}

contextBridge.exposeInMainWorld('vibex', {
  term: {
    list: () => ipcRenderer.invoke('term:list'),
    buffer: (id: number) => ipcRenderer.invoke('term:buffer', id),
    snapshot: (id: number) => ipcRenderer.invoke('term:snapshot', id),
    create: (pane: 'agent' | 'agent-terminal' | 'agent-chat' | 'shell') => ipcRenderer.invoke('term:create', pane),
    input: (id: number, data: string) => ipcRenderer.send('term:input', id, data),
    resize: (id: number, cols: number, rows: number) => ipcRenderer.send('term:resize', id, cols, rows),
    close: (id: number) => ipcRenderer.send('term:close', id),
    reopen: (id: number) => ipcRenderer.invoke('term:reopen', id),
    onCreated: (fn: Listener) => listen('term:created', fn),
    onData: (fn: Listener) => listen('term:data', fn),
    onExit: (fn: Listener) => listen('term:exit', fn),
    onClosed: (fn: Listener) => listen('term:closed', fn),
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    open: (folder?: string) => ipcRenderer.invoke('projects:open', folder),
    openServer: (server: string, folder: string) => ipcRenderer.invoke('projects:openServer', server, folder),
    select: (id: string) => ipcRenderer.invoke('projects:select', id),
    close: (id: string) => ipcRenderer.invoke('projects:close', id),
    reveal: (id: string) => ipcRenderer.send('projects:reveal', id),
    onChanged: (fn: Listener) => listen('projects:changed', fn),
    onRevealPane: (fn: Listener) => listen('pane:reveal', fn),
  },
  servers: {
    list: () => ipcRenderer.invoke('servers:list'),
    connect: (name: string) => ipcRenderer.invoke('servers:connect', name),
    problem: () => ipcRenderer.invoke('servers:problem'),
    folders: (name: string) => ipcRenderer.invoke('servers:folders', name),
  },
  browser: {
    navigate: (url: string) => ipcRenderer.invoke('browser:navigate', url),
    state: () => ipcRenderer.invoke('browser:state'),
    back: () => ipcRenderer.send('browser:back'),
    forward: () => ipcRenderer.send('browser:forward'),
    reload: () => ipcRenderer.send('browser:reload'),
    setArea: (rect: { x: number; y: number; width: number; height: number }, shown: boolean) => ipcRenderer.send('browser:area', rect, shown),
    onState: (fn: Listener) => listen('browser:state', fn),
  },
  // The channels of feature modules (main/modules.ts). A page of this window can reach no other channel through it.
  mod: {
    invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(modChannel(channel), ...args),
    send: (channel: string, ...args: unknown[]) => ipcRenderer.send(modChannel(channel), ...args),
    on: (channel: string, fn: Listener) => listen(modChannel(channel), fn),
  },
  /// Where a dropped or pasted file lives; the chat attaches it by that path.
  filePath: (file: File) => webUtils.getPathForFile(file),
  status: () => ipcRenderer.invoke('app:status'),
  platform: process.platform,
  /// The PCA edition's chat layout (renderer/chatFirst.ts). Main sets it; only a test run can turn it off.
  chatFirst: !process.argv.includes('--vibex-chat-first=0'),
  menu: {
    onCommand: (fn: Listener) => listen('menu:command', fn),
    app: (x: number, y: number) => ipcRenderer.send('menu:app', x, y),
    terminal: (hasSelection: boolean) => ipcRenderer.invoke('menu:terminal', hasSelection),
    project: (id: string) => ipcRenderer.send('menu:project', id),
  },
});
