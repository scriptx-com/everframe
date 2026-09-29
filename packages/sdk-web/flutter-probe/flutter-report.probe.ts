// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { ReportEnvelope, vtree } from '@everframe/protocol';

function part(body: Buffer, contentType: string, name: string): Buffer | null {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1]
    ?? contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  if (!boundary) return null;
  const start = body.indexOf(`name="${name}"`);
  if (start < 0) return null;
  const from = body.indexOf('\r\n\r\n', start) + 4;
  const to = body.indexOf(`\r\n--${boundary}`, from);
  return from < 4 || to < 0 ? null : body.subarray(from, to);
}

test('submits masked Flutter screenshot and image replay through the web reporter', async ({ page, request }) => {
  const origins = new Set<string>();
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith('/api/')) origins.add(url.origin);
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as { __everframeProbe?: unknown }).__everframeProbe));
  await page.waitForFunction(() => Boolean((window as unknown as { everframeFlutterProbeFrame?: string }).everframeFlutterProbeFrame));
  const firstFrame = await page.evaluate(() => (window as unknown as { everframeFlutterProbeFrame: string }).everframeFlutterProbeFrame);
  await page.mouse.click(350, 120);
  await page.waitForFunction((first) => {
    const frame = (window as unknown as { everframeFlutterProbeFrame?: string }).everframeFlutterProbeFrame;
    return Boolean(frame) && frame !== first;
  }, firstFrame);
  await page.evaluate(() => {
    const sdk = (window as unknown as { __everframeProbe: { open(): Promise<unknown> } }).__everframeProbe;
    void sdk.open();
  });
  await page.getByTestId('report-title').fill('Flutter web image replay');
  await page.getByTestId('submit-report').click();
  await expect.poll(async () => (await request.get('/probe/last-report')).status()).toBe(200);

  const response = await request.get('/probe/last-report');
  const body = await response.body();
  const type = response.headers()['content-type'] ?? '';
  const envelopeBytes = part(body, type, 'envelope');
  const screenshot = part(body, type, 'screenshot');
  const replayBytes = part(body, type, 'session-replay');
  expect(envelopeBytes).not.toBeNull();
  expect(screenshot).not.toBeNull();
  expect(replayBytes).not.toBeNull();
  const envelope = ReportEnvelope.parse(JSON.parse(envelopeBytes!.toString()));
  const replay = vtree.VTreeTimeline.parse(JSON.parse(replayBytes!.toString()));
  expect(envelope.sdk.name).toBe('everframe-flutter');
  expect(envelope.sdk.version).toBe('0.0.0+1');
  expect(envelope.attachments.find((entry) => entry.kind === 'session-replay')?.format).toBe('everframe-vtree-v1');
  expect(replay.version).toBe('everframe-vtree-v1');
  expect(replay.frames.length).toBeGreaterThanOrEqual(2);
  expect(Object.keys(replay.assets).length).toBeGreaterThanOrEqual(2);
  for (const [kind, bytes] of [['screenshot', screenshot], ['session-replay', replayBytes]] as const) {
    const ref = envelope.attachments.find((entry) => entry.kind === kind);
    expect(ref?.byteLength).toBe(bytes!.length);
    expect(ref?.sha256).toBe(createHash('sha256').update(bytes!).digest('hex'));
  }
  expect([...origins]).toEqual(['http://127.0.0.1:8938']);
  const images = [screenshot!.toString('base64'), ...Object.values(replay.assets).map((asset) => asset.b64)];
  const publicColors = new Set<string>();
  for (const image of images) {
    const pixels = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const all = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let magenta = 0;
      for (let i = 0; i < all.length; i += 4) {
        if (all[i]! >= 239 && all[i + 1]! <= 16 && all[i + 2]! >= 239) magenta++;
      }
      const blackFraction = (top: number) => {
        let black = 0;
        let total = 0;
        for (let y = top + 8; y < top + 72; y++) {
          for (let x = 48; x < 192; x++) {
            const p = ctx.getImageData(x, y, 1, 1).data;
            if (p[0] === 0 && p[1] === 0 && p[2] === 0) black++;
            total++;
          }
        }
        return black / total;
      };
      return {
        sensitiveBlack: blackFraction(140),
        platformBlack: blackFraction(240),
        magenta,
        publicColor: Array.from(ctx.getImageData(80, 80, 1, 1).data).slice(0, 3).join(','),
      };
    }, image);
    expect(pixels.sensitiveBlack).toBeGreaterThan(0.99);
    expect(pixels.platformBlack).toBeGreaterThan(0.99);
    expect(pixels.magenta).toBe(0);
    publicColors.add(pixels.publicColor);
  }
  expect(publicColors).toContain('0,204,0');
  expect(publicColors).toContain('0,102,255');
});

test('retries the exact masked report after a temporary ingest failure', async ({ page, request }) => {
  let attempted: Buffer | null = null;
  let attemptedType = '';
  await page.route('**/api/ingest', async (route) => {
    attempted = route.request().postDataBuffer();
    attemptedType = route.request().headers()['content-type'] ?? '';
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as { __everframeProbe?: unknown }).__everframeProbe));
  await page.waitForFunction(() => Boolean((window as unknown as { everframeFlutterProbeFrame?: string }).everframeFlutterProbeFrame));
  await page.evaluate(() => {
    const sdk = (window as unknown as { __everframeProbe: { open(): Promise<unknown> } }).__everframeProbe;
    void sdk.open();
  });
  await page.getByTestId('report-title').fill('Flutter web queued visual report');
  await page.getByTestId('submit-report').click();
  await expect.poll(() => attempted !== null).toBe(true);
  const queuedEnvelope = ReportEnvelope.parse(JSON.parse(part(attempted!, attemptedType, 'envelope')!.toString()));
  expect(queuedEnvelope.attachments.some((entry) => entry.kind === 'session-replay')).toBe(true);
  await page.unroute('**/api/ingest');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => {
    const response = await request.get('/probe/last-report');
    if (!response.ok()) return '';
    const envelope = part(await response.body(), response.headers()['content-type'] ?? '', 'envelope');
    return envelope ? JSON.parse(envelope.toString()).reporter?.title ?? '' : '';
  }).toBe('Flutter web queued visual report');
  const delivered = await request.get('/probe/last-report');
  const deliveredBody = await delivered.body();
  const deliveredType = delivered.headers()['content-type'] ?? '';
  const deliveredEnvelope = ReportEnvelope.parse(JSON.parse(part(deliveredBody, deliveredType, 'envelope')!.toString()));
  expect(deliveredEnvelope.reportId).toBe(queuedEnvelope.reportId);
  expect(deliveredEnvelope.attachments).toEqual(queuedEnvelope.attachments);
  for (const name of ['screenshot', 'session-replay']) {
    expect(part(deliveredBody, deliveredType, name)).toEqual(part(attempted!, attemptedType, name));
  }
});
