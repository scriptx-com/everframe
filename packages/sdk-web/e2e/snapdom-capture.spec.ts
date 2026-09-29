// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { test, expect, type Page } from '@playwright/test';

type Probe = { renderer?: string; reason?: string; w: number; h: number; samples: Record<string, number[]> };

/** Capture through the real adapter, then sample pixel colours at named viewport points (CSS px). */
async function captureAndSample(page: Page, points: Record<string, [number, number]>): Promise<Probe> {
  return page.evaluate(async (pts) => {
    const w = window as unknown as {
      __everframe: { __adapter: { captureScreenshot(): Promise<{ blob: Blob }>; __lastScreenshotRenderer?: string; __lastDegradedReason?: string } };
    };
    const shot = await w.__everframe.__adapter.captureScreenshot();
    const bmp = await createImageBitmap(shot.blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const scale = bmp.width / window.innerWidth;
    const samples: Record<string, number[]> = {};
    for (const [name, [x, y]] of Object.entries(pts)) {
      samples[name] = Array.from(ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data);
    }
    return {
      renderer: w.__everframe.__adapter.__lastScreenshotRenderer,
      reason: w.__everframe.__adapter.__lastDegradedReason,
      w: bmp.width,
      h: bmp.height,
      samples,
    };
  }, points);
}

const near = (a: number[], b: number[], tol = 40): boolean => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]!) <= tol);

test('sparse page: captured by snapdom, not flagged blank', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html');
  const r = await captureAndSample(page, {});
  expect(r.renderer).toBe('snapdom');
  expect(r.reason).toBeUndefined();
});

test('scrolled page shows the scrolled content, masks the sensitive box, keeps video layout', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html');
  await page.evaluate(() => document.getElementById('dark')!.scrollIntoView());
  const pos = await page.evaluate(() => {
    const c = (id: string): [number, number] => {
      const b = document.getElementById(id)!.getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2];
    };
    return { secret: c('secret'), after: c('after-video'), bg: [800, 600] as [number, number] };
  });
  const r = await captureAndSample(page, pos);
  expect(r.renderer).toBe('snapdom');
  expect(near(r.samples.bg!, [13, 17, 23])).toBe(true);        // dark section, not the white top
  expect(near(r.samples.secret!, [0, 0, 0])).toBe(true);        // masked solid black
  expect(near(r.samples.after!, [0, 200, 0])).toBe(true);       // video box kept, nothing shifted
});

test('nested scroll container shows its scrolled position', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html');
  await page.evaluate(() => {
    const nested = document.getElementById('nested')!;
    nested.scrollIntoView();
    nested.scrollTop = 800;
  });
  const pos = await page.evaluate(() => {
    const b = document.getElementById('nested-marker')!.getBoundingClientRect();
    return { marker: [b.left + 20, b.top + 20] as [number, number] };
  });
  const r = await captureAndSample(page, pos);
  expect(r.renderer).toBe('snapdom');
  expect(near(r.samples.marker!, [255, 0, 255])).toBe(true);
});

test('scroller child with a class-applied transform keeps it and the scroll offset', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html');
  await page.evaluate(() => {
    const el = document.getElementById('classy')!;
    el.scrollIntoView();
    el.scrollTop = 800;
  });
  const pos = await page.evaluate(() => {
    const b = document.getElementById('classy-marker')!.getBoundingClientRect();
    return {
      marker: [b.left + 20, b.top + 20] as [number, number],
      // the un-shifted x position must NOT be coloured
      unshifted: [b.left - 20, b.top + 20] as [number, number],
    };
  });
  const r = await captureAndSample(page, pos);
  expect(r.renderer).toBe('snapdom');
  expect(near(r.samples.marker!, [0, 0, 255])).toBe(true);
  expect(near(r.samples.unshifted!, [255, 255, 255])).toBe(true);
});

test('15k-node page is captured by snapdom and is not blank', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html?bulk=15000');
  const r = await captureAndSample(page, {});
  expect(r.renderer).toBe('snapdom');
  expect(r.reason).toBeUndefined();
});
