// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';

import { classifyStockEvidence } from './evidence-classifier.js';

const OUT = new URL('../test-results/flutter-probe/', import.meta.url);

function multipartPart(body: Buffer, contentType: string, name: string): Buffer | null {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1]
    ?? contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  if (!boundary) return null;
  const header = `name="${name}"`;
  const start = body.indexOf(header);
  if (start < 0) return null;
  const contentStart = body.indexOf('\r\n\r\n', start);
  if (contentStart < 0) return null;
  const from = contentStart + 4;
  const to = body.indexOf(`\r\n--${boundary}`, from);
  return to < 0 ? null : body.subarray(from, to);
}

async function pageTileFraction(page: Page, png: Buffer, rgb: [number, number, number], top: number): Promise<number> {
  return page.evaluate(async ({ base64, expected, y }) => {
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    let match = 0;
    let total = 0;
    for (let py = y + 8; py < y + 72 && py < bmp.height; py++) {
      for (let px = 48; px < 192 && px < bmp.width; px++) {
        const p = ctx.getImageData(px, py, 1, 1).data;
        if (Math.abs(p[0]! - expected[0]) <= 16
          && Math.abs(p[1]! - expected[1]) <= 16
          && Math.abs(p[2]! - expected[2]) <= 16) match++;
        total++;
      }
    }
    return total === 0 ? 0 : match / total;
  }, { base64: png.toString('base64'), expected: rgb, y: top });
}

async function magentaPixelCount(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const pixels = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i]! >= 239 && pixels[i + 1]! <= 16 && pixels[i + 2]! >= 239) count++;
    }
    return count;
  }, png.toString('base64'));
}

test('measures the current SDK without persisting or submitting unmasked pixels', async ({ page, request }) => {
  const apiOrigins = new Set<string>();
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith('/api/')) apiOrigins.add(url.origin);
  });

  const firstConfig = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/config');
  await page.goto('/');
  await firstConfig;
  await page.waitForFunction(() => Boolean((window as unknown as { __everframeProbe?: unknown }).__everframeProbe));
  await expect.poll(async () => pageTileFraction(page, await page.screenshot(), [0, 204, 0], 40)).toBeGreaterThan(0.8);

  // The unmasked sample is measured in memory only. It is never submitted or written to disk.
  await page.mouse.click(350, 120);
  await expect.poll(async () => pageTileFraction(page, await page.screenshot(), [0, 102, 255], 40)).toBeGreaterThan(0.8);
  const stock = await page.evaluate(async () => {
    const handle = (window as unknown as {
      __everframeProbe: { __adapter: { captureScreenshot(): Promise<{ blob: Blob }> } };
    }).__everframeProbe;
    const { blob } = await handle.__adapter.captureScreenshot();
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const fraction = (y: number, color: [number, number, number]): number => {
      let match = 0;
      let total = 0;
      for (let py = y + 8; py < y + 72 && py < bmp.height; py++) {
        for (let px = 48; px < 192 && px < bmp.width; px++) {
          const p = ctx.getImageData(px, py, 1, 1).data;
          if (Math.abs(p[0]! - color[0]) <= 16
            && Math.abs(p[1]! - color[1]) <= 16
            && Math.abs(p[2]! - color[2]) <= 16) match++;
          total++;
        }
      }
      return total === 0 ? 0 : match / total;
    };
    const fractions = {
      publicColorFraction: fraction(40, [0, 102, 255]),
      sensitiveMagentaFraction: fraction(140, [255, 0, 255]),
      sensitiveBlackFraction: fraction(140, [0, 0, 0]),
    };
    const pixels = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let minX = bmp.width;
    let minY = bmp.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < bmp.height; y++) {
      for (let x = 0; x < bmp.width; x++) {
        const i = (y * bmp.width + x) * 4;
        if (pixels[i]! >= 239 && pixels[i + 1]! <= 16 && pixels[i + 2]! >= 239) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    const sensitiveBounds = maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
    return { width: bmp.width, height: bmp.height, sensitiveBounds, ...fractions };
  });

  // Reload a separate scene that is black from its first frame before invoking reporter/ingest.
  const safeConfig = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/config');
  await page.goto('/?safe=1');
  await safeConfig;
  await expect.poll(async () => pageTileFraction(page, await page.screenshot(), [0, 0, 0], 140)).toBeGreaterThan(0.95);
  const safeScene = await page.screenshot();
  expect(await magentaPixelCount(page, safeScene), 'safe submit scene still contains secret-colored pixels').toBe(0);
  await page.mouse.click(350, 120);
  await expect.poll(async () => pageTileFraction(page, await page.screenshot(), [0, 102, 255], 40)).toBeGreaterThan(0.8);
  await page.evaluate(() => {
    const handle = (window as unknown as { __everframeProbe: { open(): Promise<unknown> } }).__everframeProbe;
    void handle.open().catch(() => {});
  });
  await page.getByTestId('report-title').fill('Flutter web probe safe submission');
  await page.getByTestId('submit-report').click();
  await expect.poll(async () => (await request.get('/probe/last-report')).status()).toBe(200);

  const report = await request.get('/probe/last-report');
  const body = await report.body();
  const replayPart = multipartPart(body, report.headers()['content-type'] ?? '', 'session-replay');
  const replayBytes = replayPart && replayPart[0] === 0x1f && replayPart[1] === 0x8b
    ? gunzipSync(replayPart)
    : replayPart;
  const events: unknown[] = replayBytes ? JSON.parse(replayBytes.toString('utf8')) : [];
  const canvasFrameHashes = events.flatMap((event) => {
    const frame = event as { type?: number; data?: { source?: number } };
    return frame.type === 3 && frame.data?.source === 9
      ? [createHash('sha256').update(JSON.stringify(frame.data)).digest('hex')]
      : [];
  });
  const classified = classifyStockEvidence({
    ...stock,
    canvasFrameHashes,
    apiOrigins: [...apiOrigins],
  });
  expect([...apiOrigins]).toEqual(['http://127.0.0.1:8937']);
  await mkdir(OUT, { recursive: true });
  await writeFile(new URL('safe-submit.png', OUT), safeScene);
  await writeFile(new URL('stock-evidence.json', OUT), JSON.stringify({
    screenshot: { width: stock.width, height: stock.height, publicColorFraction: stock.publicColorFraction, sensitiveMagentaFraction: stock.sensitiveMagentaFraction, sensitiveBlackFraction: stock.sensitiveBlackFraction, sensitiveBounds: stock.sensitiveBounds },
    replay: { attachmentPresent: replayPart !== null, eventCount: events.length, canvasFrameCount: canvasFrameHashes.length, distinctCanvasFrames: new Set(canvasFrameHashes).size },
    apiOrigins: [...apiOrigins],
    capabilities: {
      screenshot: classified.screenshotVisible ? 'PASS' : 'BLOCKED',
      masking: classified.maskSafe ? 'PASS' : 'BLOCKED',
      visualReplay: classified.visualReplay ? 'PASS' : 'BLOCKED',
    },
    reasons: classified.reasons,
  }, null, 2));
});
