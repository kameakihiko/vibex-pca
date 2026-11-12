import { randomBytes } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import { session } from 'electron';

// A local .html file in the side browser (vibex_preview). It may come from anyone, so it gets one address that serves that
// one file, in a session of its own, with no file and no network (security review N2). Its own scripts and inline styles run.
// A page that needs an image beside it shows without that image: a review page holds its images inside, as data: addresses.

export const PREVIEW_SCHEME = 'vibex-preview';
const PAGE_NAME = 'page.html';
/// A file bigger than this is not a review page, and the whole of it would sit in memory.
const MAX_PAGE = 100 * 1024 * 1024;
/// Port 9 on this computer takes no connection. All that goes to a proxy therefore ends here, also a WebRTC or a DNS prefetch.
const NOWHERE = 'http://127.0.0.1:9';

export const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "connect-src 'none'",
  "worker-src 'none'",
  "webrtc 'block'",
].join('; ');

export const previewUrl = (id: string) => `${PREVIEW_SCHEME}://${id}/${PAGE_NAME}`;

/// The one address the session may ask for, and what a page holds inside itself. Never file:, http, or a second path.
export function previewRequestAllowed(url: string, page: string): boolean {
  if (/^(data|blob):/i.test(url) || url === 'about:blank') return true;
  return url.split('#')[0] === page;
}

export interface PreviewPage {
  url: string;
  partition: string;
  close: () => void;
}

/// Serves `file`, a real path that vibex_preview checked. It reads the file at each load, and refuses if the path has become a link.
export function openPreviewPage(file: string): PreviewPage {
  const id = randomBytes(16).toString('hex');
  const url = previewUrl(id);
  const partition = `vibex-preview-${id}`;
  const ses = session.fromPartition(partition);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !previewRequestAllowed(details.url, url) }));
  void ses.setProxy({ mode: 'fixed_servers', proxyRules: NOWHERE, proxyBypassRules: '<-loopback>' });
  ses.protocol.handle(PREVIEW_SCHEME, async (request) => {
    const refused = new Response('Not found', { status: 404, headers: { 'Content-Security-Policy': PREVIEW_CSP } });
    if (request.method !== 'GET' || request.url.split('#')[0] !== url) return refused;
    try {
      if (realpathSync.native(file) !== file) return refused;
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_PAGE) return refused;
      return new Response(new Uint8Array(await fs.readFile(file)), {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': PREVIEW_CSP,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return refused;
    }
  });
  return {
    url,
    partition,
    close: () => {
      try {
        ses.protocol.unhandle(PREVIEW_SCHEME);
      } catch {
        // Gone already.
      }
      void ses.clearStorageData().catch(() => undefined);
    },
  };
}
