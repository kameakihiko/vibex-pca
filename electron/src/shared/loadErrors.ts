// Plain words for a page that did not load. Pure code, used by the main process (the failure page in the side browser)
// and by the renderer (the address bar message), so both read one table.

/// Plain words for the load errors people meet most; the Chromium code stays at the end for support.
export const LOAD_ERRORS: [RegExp, string][] = [
  [/ERR_NAME_NOT_RESOLVED/, 'the address was not found. Check the spelling.'],
  [/ERR_CONNECTION_REFUSED/, 'nothing answers at this address. Check that the server is running.'],
  [/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/, 'the server did not answer in time. Try again.'],
  [/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/, 'there is no internet connection.'],
  [/ERR_CERT_/, 'the site\'s security certificate is not valid.'],
  [/ERR_UNSAFE_PORT/, 'the browser blocks this port for safety. Use another port.'],
];

const GENERIC = 'the page did not load.';

export function explainLoadError(raw: string): string {
  const code = /ERR_[A-Z_]+/.exec(raw)?.[0];
  const plain = LOAD_ERRORS.find(([re]) => re.test(raw))?.[1] ?? GENERIC;
  return code ? `${plain} (${code})` : plain;
}

/// The names of the numeric codes that Electron's did-fail-load gives, for the errors in the table above.
const CODE_NAMES: Record<number, string> = {
  [-105]: 'ERR_NAME_NOT_RESOLVED',
  [-102]: 'ERR_CONNECTION_REFUSED',
  [-118]: 'ERR_CONNECTION_TIMED_OUT',
  [-7]: 'ERR_TIMED_OUT',
  [-106]: 'ERR_INTERNET_DISCONNECTED',
  [-21]: 'ERR_NETWORK_CHANGED',
  [-312]: 'ERR_UNSAFE_PORT',
  [-200]: 'ERR_CERT_COMMON_NAME_INVALID',
  [-201]: 'ERR_CERT_DATE_INVALID',
  [-202]: 'ERR_CERT_AUTHORITY_INVALID',
  [-203]: 'ERR_CERT_CONTAINS_ERRORS',
  [-204]: 'ERR_CERT_NO_REVOCATION_MECHANISM',
  [-205]: 'ERR_CERT_UNABLE_TO_CHECK_REVOCATION',
  [-206]: 'ERR_CERT_REVOKED',
  [-207]: 'ERR_CERT_INVALID',
};

/// True when a failed load deserves the failure page: a main-frame web address that really failed. A cancelled load
/// (ERR_ABORTED, -3: a redirect, a new address typed, a download) is not a failure, and a subframe, a file, a data
/// page or about: is not the person's web page.
export function shouldShowFailurePage(load: { errorCode: number; isMainFrame: boolean; url: string }): boolean {
  if (load.errorCode === -3 || !load.isMainFrame) return false;
  return /^https?:\/\//i.test(load.url);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/// The page itself. It holds no script element: the button's handler is an attribute and carries the address as JSON,
/// with "&", "'" and "<" escaped for the attribute. It has no autofocus and no form, so only a click acts.
export function failurePageHtml(url: string, errorCode: number): string {
  const name = CODE_NAMES[errorCode];
  const plain = LOAD_ERRORS.find(([re]) => name !== undefined && re.test(name))?.[1] ?? GENERIC;
  const sentence = plain.charAt(0).toUpperCase() + plain.slice(1);
  const code = name ?? `error ${errorCode}`;
  // A very long address would push the data address past Chromium's size limit. Then the page names neither the address
  // nor a button; the toolbar and Reload still hold the real address.
  const tooLong = url.length > MAX_SHOWN_ADDRESS;
  const target = JSON.stringify(url).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
  const address = tooLong ? 'The address is too long to show.' : escapeHtml(url);
  const button = tooLong ? '' : `<button type="button" onclick='location.href=${target}'>Try Again</button>\n`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Page did not load</title><style>
:root { color-scheme: light dark; }
body { font: 14px system-ui, sans-serif; margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center; }
main { max-width: 460px; padding: 24px; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
p { margin: 0 0 8px; line-height: 1.45; }
code { font: 12px ui-monospace, Menlo, Consolas, monospace; opacity: .75; word-break: break-all; }
button { font: inherit; margin-top: 12px; padding: 6px 14px; border-radius: 6px; border: 0; background: #0a84ff; color: #fff; cursor: pointer; }
</style></head><body><main>
<h1>This page did not load</h1>
<p>${escapeHtml(sentence)} (${escapeHtml(code)})</p>
<p><code>${address}</code></p>
${button}</main></body></html>`;
}

/// The longest address the page shows, and gives to Try Again.
export const MAX_SHOWN_ADDRESS = 2000;

/// The page as a data address. A data page loaded as the top page has an opaque origin: not the failed site's, and no app's.
export function failurePageUrl(url: string, errorCode: number): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(failurePageHtml(url, errorCode))}`;
}

export const FAILURE_PAGE_PREFIX = 'data:text/html;charset=utf-8,';

/// Which history entries to remove when the failure page (or a real page after it) is on show, so the failure leaves no
/// item. `urls` are all entries, `active` is the page on show, `failed` is the failed address, and `failAt` is the index
/// of the page that was on show when the load failed (null if not known). Walking back from the entry before `active`:
/// earlier failure pages go, and at most ONE entry of the failed address goes, only if it is newer than `failAt`, so an
/// earlier real visit of the same address stays. Returns indices, highest first.
export function failureEntriesToDrop(urls: string[], active: number, failed: string | null, failAt: number | null): number[] {
  const drop: number[] = [];
  let usedFailed = false;
  for (let i = active - 1; i >= 0; i--) {
    const url = urls[i] ?? '';
    if (url.startsWith(FAILURE_PAGE_PREFIX)) drop.push(i);
    else if (!usedFailed && failed !== null && url === failed && (failAt === null || i > failAt)) {
      drop.push(i);
      usedFailed = true;
    } else break;
  }
  return drop;
}

/// The address a server project judges for a tab: the failed address while the failure page is on show (null, so
/// refused, when it is not known), else the page's own address.
export function judgedAddress(pageUrl: string, failure: string | null): string | null {
  return pageUrl.startsWith(FAILURE_PAGE_PREFIX) ? failure : pageUrl;
}
