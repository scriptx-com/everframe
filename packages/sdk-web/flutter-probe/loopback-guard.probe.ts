// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { expect, test } from '@playwright/test';

test('rejects a non-loopback SDK bundle before initialization or network requests', async ({ page }) => {
  const remoteRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('https://everframe.dev/')) remoteRequests.push(request.url());
  });
  await page.route('https://everframe.dev/**', async (route) => route.abort());
  await page.route('**/sdk/index.js', async (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `window.__probeModuleLoaded = true;
      export const INGEST_URL = 'https://everframe.dev';
      export function init() {
        window.__probeInitCalls = (window.__probeInitCalls || 0) + 1;
        void fetch('https://everframe.dev/api/config');
        return {};
      }`,
  }));

  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as { __probeModuleLoaded?: boolean }).__probeModuleLoaded));
  expect(await page.evaluate(() => (window as unknown as { __probeInitCalls?: number }).__probeInitCalls ?? 0)).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __everframeProbe?: unknown }).__everframeProbe)).toBeUndefined();
  expect(remoteRequests).toEqual([]);
});
