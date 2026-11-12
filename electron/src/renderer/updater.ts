import type { RendererModule } from './modules';
import { api, button, el, plain } from './pcaUi';
import { setupExtras } from './setup';

// Auto-update on screen: one button in the title bar when an update waits, and one row under the Setup checks.
// Main side: ../main/updater.ts.

type State = { kind: string; version?: string; percent?: number; reason?: string; message?: string };

const invoke = (channel: string) => api().mod.invoke(`mod:update:${channel}`);

function restart(): void {
  invoke('restart').catch((error: unknown) => console.error(plain(error)));
}

function paintTitleBar(state: State): void {
  document.getElementById('update-now')?.remove();
  if (state.kind !== 'ready') return;
  const b = button('Restart to Update', restart, 'side-button');
  b.id = 'update-now';
  b.title = `Version ${state.version} is ready. Running tabs stop, so Vibex PCA asks first.`;
  document.getElementById('title-actions')?.prepend(b);
}

async function setupRow(): Promise<HTMLElement[]> {
  const row = el('div', 'tool-row setup-extra');
  row.dataset.setupExtra = 'updates';
  const text = el('span', 'row-sub');
  text.setAttribute('role', 'status');
  const { state, text: first } = await invoke('state');
  text.textContent = first;
  const paint = () => invoke('state').then((now: { text: string }) => { text.textContent = now.text; }).catch(() => undefined);
  const stop = api().mod.on('mod:update:state', () => {
    if (!text.isConnected) stop?.();
    else void paint();
  });
  row.append(el('span', 'row-name', 'Updates'), text);
  if (state.kind !== 'off') {
    row.append(button('Check for Updates', () => {
      invoke('check').then(paint).catch((error: unknown) => { text.textContent = plain(error); });
    }, 'side-button'));
  }
  return [row];
}

function start(): void {
  setupExtras.push(setupRow);
  api().mod.on('mod:update:state', (state: State) => paintTitleBar(state));
  invoke('state').then(({ state }: { state: State }) => paintTitleBar(state)).catch(() => undefined);
}

export const updaterRenderer: RendererModule = { name: 'updater', start };
