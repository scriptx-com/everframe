// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const OUT = new URL('../test-results/flutter-probe/', import.meta.url);

interface FrameMetrics {
  width: number;
  height: number;
  greenFraction: number;
  blueFraction: number;
  blackFraction: number;
  orangeFraction: number;
  magentaPixels: number;
  background: [number, number, number, number];
}

async function inspectFrame(page: Page, base64: string): Promise<FrameMetrics> {
  return page.evaluate(async (encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const pixels = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const fraction = (top: number, rgb: [number, number, number]): number => {
      let matches = 0;
      let total = 0;
      for (let y = top + 8; y < top + 72 && y < bmp.height; y++) {
        for (let x = 48; x < 192 && x < bmp.width; x++) {
          const i = (y * bmp.width + x) * 4;
          if (Math.abs(pixels[i]! - rgb[0]) <= 16
            && Math.abs(pixels[i + 1]! - rgb[1]) <= 16
            && Math.abs(pixels[i + 2]! - rgb[2]) <= 16) matches++;
          total++;
        }
      }
      return total === 0 ? 0 : matches / total;
    };
    let magentaPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i]! >= 239 && pixels[i + 1]! <= 16 && pixels[i + 2]! >= 239) magentaPixels++;
    }
    const backgroundOffset = (300 * bmp.width + 250) * 4;
    return {
      width: bmp.width,
      height: bmp.height,
      greenFraction: fraction(40, [0, 204, 0]),
      blueFraction: fraction(40, [0, 102, 255]),
      blackFraction: fraction(140, [0, 0, 0]),
      orangeFraction: fraction(240, [255, 136, 0]),
      magentaPixels,
      background: Array.from(pixels.slice(backgroundOffset, backgroundOffset + 4)) as [number, number, number, number],
    };
  }, base64);
}

async function captureSafeFrame(page: Page): Promise<string> {
  await page.evaluate(() => { (window as unknown as { everframeFlutterProbeFrame?: string }).everframeFlutterProbeFrame = undefined; });
  await page.mouse.click(380, 185);
  await expect.poll(async () => page.evaluate(() => Boolean((window as unknown as { everframeFlutterProbeFrame?: string }).everframeFlutterProbeFrame)), { timeout: 3_000 }).toBe(true);
  return page.evaluate(() => (window as unknown as { everframeFlutterProbeFrame: string }).everframeFlutterProbeFrame);
}

test('measures renderer-owned masked A and B frames, including HTML platform view', async ({ page }) => {
  page.on('pageerror', (error) => console.error('[flutter-probe-page]', error.message));
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as { __everframeProbe?: unknown }).__everframeProbe));
  await expect.poll(async () => {
    const png = await page.screenshot();
    const metrics = await inspectFrame(page, png.toString('base64'));
    return metrics.greenFraction;
  }).toBeGreaterThan(0.8);
  const a = await captureSafeFrame(page);
  await page.mouse.click(350, 120);
  await expect.poll(async () => {
    const png = await page.screenshot();
    const metrics = await inspectFrame(page, png.toString('base64'));
    return metrics.blueFraction;
  }).toBeGreaterThan(0.8);
  const b = await captureSafeFrame(page);
  const first = await inspectFrame(page, a);
  const second = await inspectFrame(page, b);

  const capabilities = {
    screenshot: first.width >= 640 && first.height >= 360 && first.greenFraction >= 0.8 && second.blueFraction >= 0.8 && first.background.every((value) => value === 255) && second.background.every((value) => value === 255) && a !== b ? 'PASS' : 'BLOCKED',
    masking: first.blackFraction >= 0.95 && second.blackFraction >= 0.95 && first.magentaPixels === 0 && second.magentaPixels === 0 ? 'PASS' : 'BLOCKED',
    platformView: first.orangeFraction >= 0.8 && second.orangeFraction >= 0.8 ? 'PASS' : 'BLOCKED',
  };
  expect(capabilities.screenshot, 'both renderer-owned frames must show their respective screens').toBe('PASS');
  await mkdir(OUT, { recursive: true });
  await writeFile(new URL('renderer-evidence.json', OUT), JSON.stringify({ first, second, distinctFrames: a !== b, capabilities }, null, 2));
  if (capabilities.masking === 'PASS') {
    await writeFile(new URL('renderer-a.png', OUT), Buffer.from(a, 'base64'));
    await writeFile(new URL('renderer-b.png', OUT), Buffer.from(b, 'base64'));
  }
});
