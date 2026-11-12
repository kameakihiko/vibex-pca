import { expect, test } from '@playwright/test';
import { explainLoadError, failureEntriesToDrop, failurePageHtml, failurePageUrl, judgedAddress, shouldShowFailurePage } from '../src/shared/loadErrors';

// Pure functions, no app window (Swift #49 sub-change A3: a plain-words page when a web page cannot load).

test('the address is escaped: a script address stays text', () => {
  const html = failurePageHtml('https://x.test/"><script>alert(1)</script>\'', -105);
  expect(html).not.toContain('<script>alert(1)');
  expect(html).not.toContain('"><script');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).toContain('&quot;');
  expect(html).toContain('&#39;');
  // No script element at all: the button's handler is an attribute, and its address is JSON with no raw angle bracket.
  expect(html.match(/<script/gi) ?? []).toHaveLength(0);
});

test('a known code gets its plain sentence, an unknown code a generic one', () => {
  expect(failurePageHtml('https://x.test/', -105)).toContain('The address was not found. Check the spelling.');
  expect(failurePageHtml('https://x.test/', -102)).toContain('Nothing answers at this address.');
  const unknown = failurePageHtml('https://x.test/', -999999);
  expect(unknown).toContain('The page did not load.');
  expect(unknown).not.toContain('Check the spelling');
});

test('Try Again acts on a click only: no autofocus, no form', () => {
  const html = failurePageHtml('https://x.test/', -102);
  expect(html).toContain('Try Again');
  expect(html).not.toMatch(/autofocus/i);
  expect(html).not.toMatch(/<form/i);
  expect(html).not.toMatch(/type=["']?submit/i);
  expect(html).toMatch(/<button type="button"/);
});

test('the page is a data address, so it has no origin', () => {
  expect(failurePageUrl('https://x.test/', -105)).toMatch(/^data:text\/html;charset=utf-8,/);
});

test('the shared table still explains a raw Chromium error', () => {
  expect(explainLoadError('Error: ERR_CONNECTION_REFUSED (-102) loading x')).toBe('nothing answers at this address. Check that the server is running. (ERR_CONNECTION_REFUSED)');
  expect(explainLoadError('boom')).toBe('the page did not load.');
});

test('when the page is shown', () => {
  const main = { isMainFrame: true, url: 'https://x.test/' };
  expect(shouldShowFailurePage({ errorCode: -105, ...main })).toBe(true);
  expect(shouldShowFailurePage({ errorCode: -102, ...main, url: 'http://localhost:3000/' })).toBe(true);
  expect(shouldShowFailurePage({ errorCode: -3, ...main })).toBe(false);
  expect(shouldShowFailurePage({ errorCode: -105, isMainFrame: false, url: 'https://x.test/' })).toBe(false);
  for (const url of ['file:///etc/hosts', 'data:text/html,hi', 'about:blank', 'chrome-error://chromewebdata/', '']) {
    expect(shouldShowFailurePage({ errorCode: -105, isMainFrame: true, url })).toBe(false);
  }
});

// ---- fix round: NB-2 (which history entries go), NB-4 (a long address), NB-3 (what a server project judges) ----

const F = 'https://x.test/form';
const D = 'data:text/html;charset=utf-8,%3Chtml%3E';

test('NB-2: an earlier real visit of the same address is kept', () => {
  // [F_ok, F_err, D]: the page was on show at index 0 when the post failed; the failing entry is index 1.
  expect(failureEntriesToDrop([F, F, D], 2, F, 0)).toEqual([1]);
});

test('NB-2: no entry for the failure means nothing real is removed', () => {
  expect(failureEntriesToDrop([F, D], 1, F, 0)).toEqual([]);
  expect(failureEntriesToDrop(['https://a.test/', F, D], 2, F, 1)).toEqual([]);
});

test('NB-2: older failure pages go with the failing entry, newest first', () => {
  const pages = ['https://p.test/', D, F, D + 'x'];
  expect(failureEntriesToDrop(pages, 3, F, 1)).toEqual([2, 1]);
  // After a real page loads: the failure page before it goes, the page before that stays.
  expect(failureEntriesToDrop(['https://p.test/', D, F], 2, F, 0)).toEqual([1]);
});

test('NB-4: a very long address is not put in the page, and Try Again is left out', () => {
  const long = 'https://x.test/' + 'a'.repeat(100_000);
  const html = failurePageHtml(long, -105);
  expect(html.length).toBeLessThan(20_000);
  expect(html).toContain('The address is too long to show.');
  expect(html).not.toContain('Try Again');
  expect(failurePageUrl(long, -105).length).toBeLessThan(100_000);
  const edge = 'https://x.test/' + 'a'.repeat(1_900);
  expect(failurePageHtml(edge, -105)).toContain('Try Again');
  expect(failurePageHtml(edge, -105)).not.toContain('too long');
});

test('NB-3: a server project judges the failed address, not the data page', () => {
  expect(judgedAddress(D, 'https://public.test/')).toBe('https://public.test/');
  expect(judgedAddress(D, null)).toBeNull();
  expect(judgedAddress('https://real.test/', 'https://old.test/')).toBe('https://real.test/');
  expect(judgedAddress('', null)).toBe('');
});
