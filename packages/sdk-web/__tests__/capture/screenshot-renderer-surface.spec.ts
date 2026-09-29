// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/capture/screenshot.js');
});

describe('adapter.__lastScreenshotRenderer', () => {
  it('reports the renderer the last capture used and stays non-enumerable', async () => {
    vi.doMock('../../src/capture/screenshot.js', async (orig) => ({
      ...(await orig<typeof import('../../src/capture/screenshot.js')>()),
      captureScreenshot: vi.fn(async (o: { __setRenderer?: (r: string) => void }) => {
        o.__setRenderer?.('snapdom');
        return { blob: new Blob(['x']), width: 1, height: 1, sha256: '0'.repeat(64) };
      }),
    }));
    const { createWebPlatformAdapter } = await import('../../src/adapter.js');
    const adapter = createWebPlatformAdapter({ apiKey: 'pk_test' } as never) as unknown as {
      captureScreenshot(): Promise<unknown>;
      __lastScreenshotRenderer?: string;
    };
    expect(adapter.__lastScreenshotRenderer).toBeUndefined();
    await adapter.captureScreenshot();
    expect(adapter.__lastScreenshotRenderer).toBe('snapdom');
    expect(Object.keys(adapter)).not.toContain('__lastScreenshotRenderer');
  });

  it('resets the degraded reason and renderer at the start of each capture', async () => {
    let call = 0;
    vi.doMock('../../src/capture/screenshot.js', async (orig) => ({
      ...(await orig<typeof import('../../src/capture/screenshot.js')>()),
      captureScreenshot: vi.fn(
        async (o: { __setDegradedReason?: (r: string) => void; __setRenderer?: (r: string) => void }) => {
          call += 1;
          if (call === 1) {
            o.__setDegradedReason?.('screenshot_blank');
            o.__setRenderer?.('snapdom');
          }
          return { blob: new Blob(['x']), width: 1, height: 1, sha256: '0'.repeat(64) };
        },
      ),
    }));
    const { createWebPlatformAdapter } = await import('../../src/adapter.js');
    const adapter = createWebPlatformAdapter({ apiKey: 'pk_test' } as never) as unknown as {
      captureScreenshot(): Promise<unknown>;
      __lastDegradedReason?: string;
      __lastScreenshotRenderer?: string;
    };
    await adapter.captureScreenshot();
    expect(adapter.__lastDegradedReason).toBe('screenshot_blank');
    expect(adapter.__lastScreenshotRenderer).toBe('snapdom');
    await adapter.captureScreenshot();
    expect(adapter.__lastDegradedReason).toBeUndefined();
    expect(adapter.__lastScreenshotRenderer).toBeUndefined();
  });
});
