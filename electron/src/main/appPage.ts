import { promises as fs } from 'node:fs';
import path from 'node:path';
import { protocol } from 'electron';
import { PREVIEW_SCHEME } from './previewPage';

// The app's own window. Measured in the fence container: with GrantFileProtocolExtraPrivileges off, file:// finds nothing inside the
// asar, so loadFile gives ERR_FILE_NOT_FOUND and a blank window. So the window has its own address, for its own files only.

export const APP_SCHEME = 'vibex-app';
export const APP_URL = `${APP_SCHEME}://app/index.html`;

/// main.js, app.js and preload.js stay out: a page has no use for them. A list and not a folder, so no spelling of a path can leave it.
const TYPES: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'renderer.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'xterm.css': 'text/css; charset=utf-8',
  'icon.png': 'image/png',
  'fonts/GoogleSans.ttf': 'font/ttf',
  'fonts/GoogleSansCode.ttf': 'font/ttf',
};

/// The file for an address, or null.
export function appFileFor(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== `${APP_SCHEME}:` || u.host !== 'app') return null;
    const name = u.pathname.slice(1);
    return Object.hasOwn(TYPES, name) ? name : null;
  } catch {
    return null;
  }
}

/// Before 'ready', and only once in a run: Electron allows one call, so both schemes are here. `secure` keeps the clipboard and
/// storage that the window used on file://. A preview page gets an origin and nothing more.
export function registerAppSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
    { scheme: PREVIEW_SCHEME, privileges: { standard: true } },
  ]);
}

/// On the default session, which only the app window uses: the side browser's pages live in other partitions, where this scheme has no handler.
export function serveAppWindow(folder: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const name = request.method === 'GET' ? appFileFor(request.url) : null;
    if (!name) return new Response('Not found', { status: 404 });
    try {
      return new Response(new Uint8Array(await fs.readFile(path.join(folder, name))), { status: 200, headers: { 'Content-Type': TYPES[name] } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
