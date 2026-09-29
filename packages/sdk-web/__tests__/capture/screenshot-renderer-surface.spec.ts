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

  it('an overlapping capture resets the shared getter but not the earlier result\'s own reason', async () => {
    const releases: Array<() => void> = [];
    vi.doMock('../../src/capture/screenshot.js', async (orig) => ({
      ...(await orig<typeof import('../../src/capture/screenshot.js')>()),
      captureScreenshot: vi.fn(async (o: { __setDegradedReason?: (r: string) => void }) => {
        const first = releases.length === 0;
        await new Promise<void>((resolve) => releases.push(resolve));
        if (first) {
          o.__setDegradedReason?.('screenshot_blank');
          return { blob: new Blob(['x']), width: 1, height: 1, sha256: '0'.repeat(64), degradedReason: 'screenshot_blank' };
        }
        return { blob: new Blob(['y']), width: 1, height: 1, sha256: '1'.repeat(64) };
      }),
    }));
    const { createWebPlatformAdapter } = await import('../../src/adapter.js');
    const adapter = createWebPlatformAdapter({ apiKey: 'pk_test' } as never) as unknown as {
      captureScreenshot(): Promise<{ degradedReason?: string }>;
      __lastDegradedReason?: string;
    };
    const a = adapter.captureScreenshot();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases[0]!(); // A records screenshot_blank ...
    await Promise.resolve();
    const b = adapter.captureScreenshot(); // ... then B starts and resets the shared getter
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(adapter.__lastDegradedReason).toBeUndefined();
    releases[1]!();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.degradedReason).toBe('screenshot_blank');
    expect(rb.degradedReason).toBeUndefined();
  });

  it('hands captureScreenshot a mask-target RESOLVER, so targets are read when the capture runs', async () => {
    let passed: unknown;
    let predicate: unknown;
    vi.doMock('../../src/capture/screenshot.js', async (orig) => ({
      ...(await orig<typeof import('../../src/capture/screenshot.js')>()),
      captureScreenshot: vi.fn(async (o: { maskTargets?: unknown; isSensitive?: unknown }) => {
        passed = o.maskTargets;
        predicate = o.isSensitive;
        return { blob: new Blob(['x']), width: 1, height: 1, sha256: '0'.repeat(64) };
      }),
    }));
    const { createWebPlatformAdapter } = await import('../../src/adapter.js');
    const adapter = createWebPlatformAdapter({ apiKey: 'pk_test' } as never) as unknown as {
      captureScreenshot(): Promise<unknown>;
    };
    await adapter.captureScreenshot();
    expect(typeof passed).toBe('function');
    expect(Array.isArray((passed as () => unknown)())).toBe(true);
    // ...and the registry's live predicate, judged per cloned node at mask time.
    const marked = document.createElement('div');
    marked.setAttribute('data-everframe-sensitive', '');
    expect((predicate as (el: Element) => boolean)(marked)).toBe(true);
    expect((predicate as (el: Element) => boolean)(document.createElement('div'))).toBe(false);
  });
});
