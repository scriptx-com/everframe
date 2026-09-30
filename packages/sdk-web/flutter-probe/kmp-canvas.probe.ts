// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { expect, test } from '@playwright/test';
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

test('KMP canvas provider submits masked screenshot and image replay', async ({ page, request }) => {
  await page.goto('/kmp-canvas.html');
  await page.waitForFunction(() => Boolean((window as unknown as { kmpProbe?: unknown }).kmpProbe));
  await page.waitForTimeout(650);
  await page.evaluate(() => (window as unknown as { changeKmpFrame(): void }).changeKmpFrame());
  await page.waitForTimeout(650);
  await page.evaluate(() => { void (window as unknown as { kmpProbe: { open(): Promise<unknown> } }).kmpProbe.open(); });
  await page.getByTestId('report-title').fill('KMP canvas image replay');
  await page.getByTestId('submit-report').click();
  await expect.poll(async () => {
    const response = await request.get('/probe/last-report');
    if (!response.ok()) return '';
    const envelope = part(await response.body(), response.headers()['content-type'] ?? '', 'envelope');
    return envelope ? JSON.parse(envelope.toString()).reporter?.title ?? '' : '';
  }).toBe('KMP canvas image replay');
  const response = await request.get('/probe/last-report');
  const body = await response.body();
  const type = response.headers()['content-type'] ?? '';
  const envelope = ReportEnvelope.parse(JSON.parse(part(body, type, 'envelope')!.toString()));
  const screenshot = part(body, type, 'screenshot');
  const replayBytes = part(body, type, 'session-replay');
  expect(envelope.sdk.name).toBe('everframe-kmp');
  expect(envelope.sdk.platform).toBe('web');
  expect(screenshot).not.toBeNull();
  expect(replayBytes).not.toBeNull();
  const replay = vtree.VTreeTimeline.parse(JSON.parse(replayBytes!.toString()));
  expect(replay.frames.length).toBeGreaterThanOrEqual(2);
  expect(Object.keys(replay.assets ?? {}).length).toBeGreaterThanOrEqual(2);
  for (const encoded of [screenshot!.toString('base64'), ...Object.values(replay.assets ?? {}).map((asset) => asset.b64)]) {
    const pixel = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      return Array.from(ctx.getImageData(40, 30, 1, 1).data).slice(0, 3);
    }, encoded);
    expect(pixel).toEqual([0, 0, 0]);
  }
});
