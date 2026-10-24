// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// TV quick capture in real Chromium (TV webviews are Chromium): a Tizen UA, a
// `tizen.tvinputdevice` stub, and mocked /api/config, /api/device-link/* and
// /api/ingest. Remote keys go through the browser's own input path (CDP
// Input.dispatchKeyEvent with the TV keyCode), so this proves the real DOM
// path: the capture-phase listener, the lazy runtime chunk, the overlay. The
// mocks record header presence and booleans only, never values.
import { test, expect, type CDPSession, type Page, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';

const TIZEN =
  'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36';
const SDK_KEY = 'pk_e2e';
// The built dist's ingest origin (tsup's default).
const INGEST = process.env.EVERFRAME_INGEST_URL ?? 'https://everframe.dev';
const TOKEN = `evf_dev_${'S'.repeat(32)}`;
const ATTEMPT = '0b7c2c3e-8f2a-4c1d-9e1b-3f6a5d4c2b1a';
const OWNER = { kind: 'user', name: 'Smoke Tester' };
const PLAY_PAUSE = 10252;

test.skip(({ browserName }) => browserName !== 'chromium', 'smart-TV webviews are Chromium');
test.use({ userAgent: TIZEN, viewport: { width: 1280, height: 720 } });

interface Seen {
  method: string;
  path: string;
  token: boolean;
  nonce: boolean;
}

/** The store key and record the SDK uses for this ingest origin + SDK key. */
function storedLink(): { key: string; value: string } {
  const url = new URL(INGEST);
  const scheme = url.protocol.replace(/:$/, '');
  const port = url.port || (scheme === 'https' ? '443' : '80');
  const scope = createHash('sha256')
    .update(`${scheme}://${url.hostname}:${port}\n${SDK_KEY}`)
    .digest('hex');
  return {
    key: `everframe.deviceLink.v1.${scope.slice(0, 32)}`,
    value: JSON.stringify({ v: 1, s: scope, t: TOKEN, o: OWNER }),
  };
}

async function setup(page: Page, opts: { linked: boolean }) {
  const seen: Seen[] = [];
  const consoleText: string[] = [];
  page.on('console', (m) => consoleText.push(m.text()));
  page.on('pageerror', (e) => consoleText.push(String(e)));

  await page.addInitScript(
    ({ link }) => {
      const supported = [
        { name: 'MediaPlayPause', code: 10252 },
        { name: 'MediaPlay', code: 415 },
        { name: 'MediaPause', code: 19 },
        { name: 'ColorF0Red', code: 403 },
      ];
      const registered: string[] = [];
      (window as unknown as { __registered: string[] }).__registered = registered;
      (window as unknown as { tizen: unknown }).tizen = {
        tvinputdevice: {
          getSupportedKeys: () => supported,
          getKey: (n: string) => supported.find((k) => k.name === n) ?? null,
          registerKey: (n: string) => registered.push(n),
          registerKeyBatch: (names: string[], ok?: () => void) => {
            registered.push(...names);
            if (ok) ok();
          },
        },
      };
      if (link) localStorage.setItem(link.key, link.value);
    },
    { link: opts.linked ? storedLink() : null },
  );

  let checks = 0;
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': req.headers()['access-control-request-headers'] ?? '*',
    };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const headers = req.headers();
    const token = typeof headers['x-everframe-capture-token'] === 'string';
    seen.push({
      method: req.method(),
      path,
      token,
      nonce: typeof headers['x-everframe-link-nonce'] === 'string',
    });
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    if (path === '/api/config') {
      return json({
        replayEnabled: false,
        replayDurationSec: 30,
        samplingRate: 0,
        captureHotkey: { enabled: true, binding: 'Shift+B', replay: false },
        deviceLinking: token
          ? { enabled: true, link: { status: 'linked', owner: OWNER } }
          : { enabled: true },
        captureGesture: { tv: { kind: 'longPress', keys: ['MEDIA_PLAY_PAUSE'], holdMs: 1500 } },
      });
    }
    if (path === '/api/device-link/hello') {
      return json({ status: 'pending', attemptId: ATTEMPT, number: 47 });
    }
    if (path === `/api/device-link/attempts/${ATTEMPT}/check`) {
      checks += 1;
      return json(
        checks < 2 ? { status: 'pending' } : { status: 'linked', token: TOKEN, owner: OWNER },
      );
    }
    if (path === '/api/ingest') return json({ id: 'r_1' });
    return json({});
  });

  await page.goto('/e2e/fixtures/tv-quick-capture.html');
  const cdp = await page.context().newCDPSession(page);
  return { seen, consoleText, cdp };
}

async function key(cdp: CDPSession, type: 'rawKeyDown' | 'keyUp', code: number) {
  await cdp.send('Input.dispatchKeyEvent', {
    type,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
    key: 'MediaPlayPause',
  });
}

/** A held Play/Pause on a remote without autorepeat: keydown, 1.6 s, keyup. */
async function longPress(page: Page, cdp: CDPSession) {
  await key(cdp, 'rawKeyDown', PLAY_PAUSE);
  await page.waitForTimeout(1_600);
  await key(cdp, 'keyUp', PLAY_PAUSE);
}

const overlay = (page: Page) => page.locator('#everframe-quick-capture');

/** The quick-capture runtime chunk is loaded once its key listener is armed. */
async function waitForArmed(page: Page, seen: Seen[]) {
  await expect.poll(() => seen.some((s) => s.path === '/api/config')).toBe(true);
  // The config is applied and the chunk loaded asynchronously; give it a beat.
  await page.waitForFunction(() =>
    performance.getEntriesByType('resource').some((e) => /quick-capture-runtime/.test(e.name)),
  );
  await page.waitForTimeout(200);
}

test('unlinked release: a long press sends a hello, shows the banner, and after approval toasts Linked to Smoke Tester', async ({
  page,
}) => {
  const { seen, consoleText, cdp } = await setup(page, { linked: false });
  await waitForArmed(page, seen);
  await longPress(page, cdp);

  await expect(overlay(page)).toContainText('Linking to Everframe · 47');
  const hello = seen.find((s) => s.path === '/api/device-link/hello');
  expect(hello).toMatchObject({ method: 'POST', token: false });
  // The first press reached the app, and so did its keyup: unlinked TVs never swallow.
  expect(
    await page.evaluate(() => (window as unknown as { __appKeys: unknown }).__appKeys),
  ).toEqual({ downs: 1, ups: 1 });
  // An unlinked release TV never registers a key.
  expect(
    await page.evaluate(() => (window as unknown as { __registered: string[] }).__registered),
  ).toEqual([]);

  await expect(overlay(page)).toContainText('Linked to Smoke Tester', { timeout: 10_000 });
  expect(seen.some((s) => s.path === '/api/ingest')).toBe(false);
  // The next config fetch carries the new token, and the binding's key is registered.
  await expect.poll(() => seen.some((s) => s.path === '/api/config' && s.token)).toBe(true);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __registered: string[] }).__registered))
    .toEqual(['MediaPlayPause']);
  expect(consoleText.filter((t) => t.includes('evf_dev_'))).toEqual([]);
});

test('linked: a long press uploads a quick capture with the token header and toasts Captured · Smoke Tester', async ({
  page,
}) => {
  const { seen, consoleText, cdp } = await setup(page, { linked: true });
  await waitForArmed(page, seen);
  expect(seen.find((s) => s.path === '/api/config')).toMatchObject({ token: true });
  expect(
    await page.evaluate(() => (window as unknown as { __registered: string[] }).__registered),
  ).toEqual(['MediaPlayPause']);

  await longPress(page, cdp);
  await expect(overlay(page)).toContainText('Captured · Smoke Tester', { timeout: 15_000 });
  await expect
    .poll(() => seen.some((s) => s.path === '/api/ingest'), { timeout: 15_000 })
    .toBe(true);
  const ingest = seen.filter((s) => s.path === '/api/ingest');
  expect(ingest).toHaveLength(1);
  expect(ingest[0]).toMatchObject({ method: 'POST', token: true, nonce: true });
  expect(seen.some((s) => s.path === '/api/device-link/hello')).toBe(false);
  // The first keydown reached the app; with no autorepeat there was nothing to swallow.
  expect(
    await page.evaluate(() => (window as unknown as { __appKeys: unknown }).__appKeys),
  ).toEqual({ downs: 1, ups: 1 });
  expect(consoleText.filter((t) => t.includes('evf_dev_'))).toEqual([]);
});

test('no console message ever contains evf_dev_', async ({ page }) => {
  const { seen, consoleText, cdp } = await setup(page, { linked: false });
  await waitForArmed(page, seen);
  await longPress(page, cdp);
  await expect(overlay(page)).toContainText('Linked to Smoke Tester', { timeout: 10_000 });
  await page.waitForTimeout(500);
  await longPress(page, cdp);
  await expect(overlay(page)).toContainText('Captured · Smoke Tester', { timeout: 15_000 });
  expect(consoleText.filter((t) => t.includes('evf_dev_'))).toEqual([]);
  expect(await page.content()).not.toContain('evf_dev_');
});
