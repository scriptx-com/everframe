// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { captureHostScreenshot } from '../../src/capture/host-visual.js';
import { createWebPlatformAdapter } from '../../src/adapter.js';
import { init } from '../../src/init.js';

const png = (width: number, height: number): Blob => {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new Blob([bytes], { type: 'image/png' });
};

describe('host visual screenshot', () => {
  it('returns only provider PNG bytes with measured dimensions and hash', async () => {
    const supplied = png(1280, 720);
    const result = await captureHostScreenshot(async () => supplied);
    expect(result.blob).toBe(supplied);
    expect(result.width).toBe(1280);
    expect(result.height).toBe(720);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects unavailable, invalid, and oversized frames without DOM fallback', async () => {
    await expect(captureHostScreenshot(async () => null)).rejects.toThrow();
    await expect(captureHostScreenshot(async () => new Blob(['secret'], { type: 'image/png' }))).rejects.toThrow();
    await expect(captureHostScreenshot(async () => png(0, 720))).rejects.toThrow();
    await expect(captureHostScreenshot(async () => png(4096, 720))).rejects.toThrow();
  });

  it('the adapter never falls back to DOM capture when a host frame is missing', async () => {
    const adapter = createWebPlatformAdapter({
      apiKey: 'pk_probe',
      appVersion: '0.0.0',
      disabled: true,
      visualCapture: { captureScreenshot: async () => null },
    });
    try {
      await expect(adapter.captureScreenshot()).rejects.toThrow('safe renderer frame is unavailable');
    } finally {
      adapter.__testCleanup();
    }
  });

  it('refuses Flutter attribution without a renderer provider', () => {
    expect(() => init({ apiKey: 'pk_probe', appVersion: '0.0.0', sdkName: 'everframe-flutter' }))
      .toThrow('requires a renderer capture provider and SDK version');
  });
});
