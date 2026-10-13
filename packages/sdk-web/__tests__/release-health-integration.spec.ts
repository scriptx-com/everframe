// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { init, type Everframe } from '../src/init.js';
const handles: Everframe[] = [];
let records: any[] = [];
beforeEach(() => {
  records = [];
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    if (String(url).endsWith('/api/ingest/release-health'))
      records.push(JSON.parse(String(options?.body)));
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
});
afterEach(() => {
  handles.forEach((h) => h.destroy());
  handles.length = 0;
  localStorage.clear();
  vi.unstubAllGlobals();
});
const settle = () => new Promise((r) => setTimeout(r, 30));
it('reports start and one global failure even with reporter disabled; handled errors do not fail it', async () => {
  const h = init({
    sdkKey: 'key-' + crypto.randomUUID(),
    appVersion: '12.3.5-12-web',
    debugBuild: false,
    reporter: { disabled: true },
  });
  handles.push(h);
  await settle();
  expect(records.map((r) => r.phase)).toEqual(['start']);
  h.captureException(new Error('handled'));
  console.error('ordinary console');
  await settle();
  expect(records).toHaveLength(1);
  window.onerror?.('uncaught', 'app.js', 1, 1, new Error('uncaught'));
  window.onerror?.('again', 'app.js', 2, 1, new Error('again'));
  await settle();
  expect(records.map((r) => r.phase)).toEqual(['start', 'failure']);
  expect(records[1].mechanism).toBe('onerror');
});
it('counts non-Error unhandled rejections and preserves webOS attribution', async () => {
  vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla Web0S Linux', language: 'en' });
  handles.push(
    init({
      sdkKey: 'key-' + crypto.randomUUID(),
      appVersion: '12.3.5-12-webos',
      debugBuild: false,
    }),
  );
  const e = new Event('unhandledrejection');
  Object.defineProperty(e, 'reason', { value: 'rejected string' });
  window.dispatchEvent(e);
  await settle();
  expect(records.map((r) => r.phase)).toEqual(['start', 'failure']);
  expect(records[1]).toMatchObject({
    mechanism: 'unhandledrejection',
    exposure: { platform: 'webos', app: { version: '12.3.5-12-webos' } },
  });
});
it.each([
  { debugBuild: true },
  { disabled: true },
  { crashReporting: { disabled: true } },
  { releaseHealth: { enabled: false } },
  { appVersion: undefined },
])('honors collection veto %j', async (patch) => {
  handles.push(
    init({
      sdkKey: 'key-' + crypto.randomUUID(),
      appVersion: '1.2.3',
      debugBuild: false,
      ...patch,
    } as any),
  );
  await settle();
  expect(records).toEqual([]);
});
it('does not treat resource error events or invalid versions as health failures', async () => {
  handles.push(
    init({ sdkKey: 'key-' + crypto.randomUUID(), appVersion: '12.3.5', debugBuild: false }),
  );
  await settle();
  window.onerror?.(new Event('error'));
  await settle();
  expect(records.map((r) => r.phase)).toEqual(['start']);
  handles.push(
    init({ sdkKey: 'key-' + crypto.randomUUID(), appVersion: '   ', debugBuild: false }),
  );
  await settle();
  expect(records).toHaveLength(1);
});

it.each(['everframe-flutter', 'everframe-kmp'] as const)(
  'collects page health for renderer host %s',
  async (sdkName) => {
    handles.push(
      init({
        sdkKey: 'key-' + crypto.randomUUID(),
        appVersion: '1.2.3',
        debugBuild: false,
        sdkName,
        sdkVersion: '1.2.2',
        visualCapture: { captureScreenshot: async () => null },
      }),
    );
    await settle();
    expect(records.map((r) => r.phase)).toEqual(['start']);
    expect(records[0].exposure).toMatchObject({
      platform: 'web',
      app: { version: '1.2.3', debug: false },
    });
    window.onerror?.('uncaught', 'app.js', 1, 1, new Error('uncaught'));
    await settle();
    expect(records.map((r) => r.phase)).toEqual(['start', 'failure']);
  },
);

it('revokes prior page health when a new owner explicitly opts out', async () => {
  const config = { sdkKey: 'key-' + crypto.randomUUID(), appVersion: '1.2.3', debugBuild: false };
  const first = init(config);
  handles.push(first);
  await settle();
  first.destroy();
  handles.push(init({ ...config, releaseHealth: { enabled: false } }));
  window.onerror?.('uncaught', 'app.js', 1, 1, new Error('uncaught'));
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
  await settle();
  expect(records.map((r) => r.phase)).toEqual(['start']);
});
