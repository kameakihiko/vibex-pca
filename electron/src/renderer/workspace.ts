import { showPage } from './docs';
import type { createFrame } from './frame';
import { api } from './pcaUi';

// What the tools vibex_view, vibex_layout and vibex_focus ask of the window. Main sends the project the tool acted
// on; only the project on screen gets the keyboard, so a tool never moves the person's typing.

export function startWorkspace(frame: ReturnType<typeof createFrame>): void {
  api().mod.on('mod:workspace:do', (id: string, action: string, arg?: string) => {
    const onScreen = frame.current()?.id === id;
    if (action === 'layout' && (arg === 'build' || arg === 'watch' || arg === 'balanced')) frame.layout(id, arg);
    else if (action === 'view-browser' && onScreen) showPage();
    else if (action === 'focus' && (arg === 'agent' || arg === 'shell')) {
      if (onScreen) frame.focusPane(arg);
      else frame.revealPane(id, arg);
    }
  });
}
