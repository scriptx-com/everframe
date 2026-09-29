// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { test, expect, type Page } from '@playwright/test';

/**
 * stall.html holds a same-origin iframe whose web font request never
 * completes (held below), so snapDOM's clone awaits it: about 3s on
 * chromium/firefox before snapDOM gives up on the font, and past the 6s
 * primary budget on webkit, where the capture abandons the run and falls
 * back. Everything here is asserted WHILE that clone is pending.
 */
async function openStalled(page: Page): Promise<() => void> {
  const held: Array<() => Promise<void>> = [];
  await page.route('**/stall-font.woff2', (route) => {
    held.push(() => route.fulfill({ status: 404 }).catch(() => undefined));
  });
  // The load event waits for the held font; the SDK is up at DOMContentLoaded.
  await page.goto('/e2e/fixtures/stall.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as unknown as { __everframe?: unknown }).__everframe);
  return () => held.forEach((release) => void release());
}

type Adapter = {
  captureScreenshot(): Promise<{ blob: Blob }>;
  __lastScreenshotRenderer?: string;
};

test('snapDOM never holds its ellipsis rewrite of live text across the stalled clone', async ({ page }) => {
  test.setTimeout(60_000);
  const release = await openStalled(page);
  const r = await page.evaluate(async () => {
    const a = (window as unknown as { __everframe: { __adapter: Adapter } }).__everframe.__adapter;
    const label = document.getElementById('label')!;
    const [amount, suffix] = Array.from(label.childNodes) as Text[];
    const intact = (): boolean => amount!.data === '$1,234,567.00' && suffix!.data === ' / month';
    let samples = 0;
    let broken = 0;
    // Sampled every few ms - i.e. at every point the page's own code could run.
    const iv = setInterval(() => {
      samples++;
      if (!intact()) broken++;
    }, 4);
    const started = performance.now();
    await a.captureScreenshot();
    const ms = performance.now() - started;
    clearInterval(iv);
    return { samples, broken, intactNow: intact(), ms };
  });
  release();
  expect(r.ms).toBeGreaterThan(1_000); // the clone really was stalled
  expect(r.samples).toBeGreaterThan(100);
  expect(r.broken).toBe(0);
  expect(r.intactNow).toBe(true);
});

test('an element the app replaces while a capture waits behind a stalled one is masked', async ({ page }) => {
  test.setTimeout(60_000);
  const release = await openStalled(page);
  const r = await page.evaluate(async () => {
    const w = window as unknown as { __everframe: { __adapter: Adapter } };
    const a = w.__everframe.__adapter;
    const first = a.captureScreenshot(); // stalls on the iframe font
    await new Promise((res) => setTimeout(res, 300));
    const second = a.captureScreenshot(); // queued behind it
    await new Promise((res) => setTimeout(res, 300));
    // The app re-renders the sensitive element while B waits.
    const holder = document.getElementById('holder')!;
    const replacement = document.createElement('div');
    replacement.className = 'secret';
    replacement.setAttribute('data-everframe-sensitive', '');
    replacement.textContent = '5500 0000 0000 0004';
    holder.replaceChildren(replacement);
    await first;
    const shot = await second;
    const bmp = await createImageBitmap(shot.blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const scale = bmp.width / window.innerWidth;
    const b = replacement.getBoundingClientRect();
    const px = (x: number, y: number): number[] =>
      Array.from(ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data);
    return {
      renderer: a.__lastScreenshotRenderer,
      samples: [px(b.left + 8, b.top + b.height / 2), px(b.left + b.width / 2, b.top + b.height / 2), px(b.right - 8, b.top + b.height / 2)],
    };
  });
  release();
  expect(['snapdom', 'modern-screenshot']).toContain(r.renderer);
  for (const s of r.samples) expect(s.slice(0, 3).every((v) => v <= 40), JSON.stringify(s)).toBe(true);
});

test('an element the app replaces DURING a stalled snapDOM clone is masked in that same capture', async ({ page }) => {
  test.setTimeout(60_000);
  const release = await openStalled(page);
  const r = await page.evaluate(async () => {
    const w = window as unknown as { __everframe: { __adapter: Adapter } };
    const a = w.__everframe.__adapter;
    const capture = a.captureScreenshot(); // its clone stalls on the iframe, before the holder
    await new Promise((res) => setTimeout(res, 300));
    const holder = document.getElementById('holder')!;
    const replacement = document.createElement('div');
    replacement.className = 'secret';
    replacement.setAttribute('data-everframe-sensitive', '');
    replacement.textContent = '5500 0000 0000 0004';
    holder.replaceChildren(replacement);
    const shot = await capture;
    const bmp = await createImageBitmap(shot.blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const scale = bmp.width / window.innerWidth;
    const b = replacement.getBoundingClientRect();
    const px = (x: number, y: number): number[] =>
      Array.from(ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data);
    return {
      renderer: a.__lastScreenshotRenderer,
      samples: [px(b.left + 8, b.top + b.height / 2), px(b.left + b.width / 2, b.top + b.height / 2), px(b.right - 8, b.top + b.height / 2)],
    };
  });
  release();
  expect(['snapdom', 'modern-screenshot']).toContain(r.renderer);
  for (const s of r.samples) expect(s.slice(0, 3).every((v) => v <= 40), JSON.stringify(s)).toBe(true);
});
