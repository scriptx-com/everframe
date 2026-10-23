// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectHelloDevice,
  detectTvPlatform,
  quickCaptureDebug,
} from '../../src/devicelink/tv-platform.js';
import { PKG_VERSION } from '../../src/internal/version.js';

const TIZEN =
  'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36';
const WEBOS =
  'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 WebAppManager';

afterEach(() => {
  vi.useRealTimers();
});

describe('TV platform', () => {
  it('detects Tizen and webOS only', () => {
    expect(detectTvPlatform(TIZEN)).toBe('tizen');
    expect(detectTvPlatform(WEBOS)).toBe('webos');
    expect(detectTvPlatform('Mozilla/5.0 (Linux; webOS.TV-2021) AppleWebKit/537.36')).toBe('webos');
    expect(detectTvPlatform('Mozilla/5.0 (X11; Linux) WebAppManager')).toBe('webos');
    expect(detectTvPlatform('Mozilla/5.0 (Linux; VIDAA 6.0) AppleWebKit/537.36')).toBeNull();
    expect(
      detectTvPlatform(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36',
      ),
    ).toBeNull();
    expect(detectTvPlatform('')).toBeNull();
  });

  it('reads navigator.userAgent by default', () => {
    // jsdom's UA is a desktop UA.
    expect(detectTvPlatform()).toBeNull();
  });

  it('a web TV is debug only when the app says so, even on a loopback host', () => {
    expect(location.hostname).toBe('localhost');
    expect(quickCaptureDebug({})).toBe(false);
    expect(quickCaptureDebug({ debugBuild: false })).toBe(false);
    expect(quickCaptureDebug({ debugBuild: true })).toBe(true);
  });
});

describe('hello device facts', () => {
  it('reads the Tizen model from webapis and falls back to Samsung TV', async () => {
    const win = { webapis: { productinfo: { getRealModel: () => 'QE55Q80B' } } };
    expect(await collectHelloDevice('tizen', '2.3.1', { userAgent: TIZEN, win })).toEqual({
      model: 'QE55Q80B',
      os: 'Tizen',
      osVersion: '6.5',
      appVersion: '2.3.1',
      sdk: `web/${PKG_VERSION}`,
      formFactor: 'tv',
    });
    const viaGetModel = { webapis: { productinfo: { getModel: () => 'UN55' } } };
    expect(
      (await collectHelloDevice('tizen', '1', { userAgent: TIZEN, win: viaGetModel })).model,
    ).toBe('UN55');
    const throwing = {
      webapis: {
        productinfo: {
          getRealModel: () => {
            throw new Error('no privilege');
          },
        },
      },
    };
    expect(
      (await collectHelloDevice('tizen', '1', { userAgent: TIZEN, win: throwing })).model,
    ).toBe('Samsung TV');
    expect((await collectHelloDevice('tizen', '1', { userAgent: TIZEN, win: {} })).model).toBe(
      'Samsung TV',
    );
  });

  it('reads the webOS model and version from deviceInfo', async () => {
    const win = {
      webOS: {
        deviceInfo: (cb: (info: unknown) => void) =>
          cb({ modelName: 'OLED55C1', sdkVersion: '6.3.0' }),
      },
    };
    const d = await collectHelloDevice('webos', '3.0.0', { userAgent: WEBOS, win });
    expect(d).toMatchObject({
      model: 'OLED55C1',
      os: 'webOS',
      osVersion: '6.3.0',
      appVersion: '3.0.0',
    });
  });

  it('waits at most 1000 ms for webOS deviceInfo', async () => {
    vi.useFakeTimers();
    const win = { webOS: { deviceInfo: () => undefined } };
    let settled: unknown = null;
    void collectHelloDevice('webos', '1', { userAgent: WEBOS, win }).then((d) => {
      settled = d;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toMatchObject({ model: 'LG TV', os: 'webOS', osVersion: 'unknown' });
  });

  it('a throwing deviceInfo falls back at once', async () => {
    const win = {
      webOS: {
        deviceInfo: () => {
          throw new Error('nope');
        },
      },
    };
    const d = await collectHelloDevice('webos', '1', {
      userAgent: 'Mozilla/5.0 (Linux; webOS.TV-2021) WebAppManager',
      win,
    });
    expect(d.model).toBe('LG TV');
    expect(d.osVersion).toBe('2021');
  });

  it('fills missing fields with unknown and caps lengths', async () => {
    const win = { webapis: { productinfo: { getRealModel: () => 'M'.repeat(150) } } };
    const d = await collectHelloDevice('tizen', undefined, {
      userAgent: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen)',
      win,
    });
    expect(d.appVersion).toBe('unknown');
    expect(d.osVersion).toBe('unknown');
    expect(d.model).toHaveLength(100);
    const long = await collectHelloDevice('tizen', 'v'.repeat(80), { userAgent: TIZEN, win: {} });
    expect(long.appVersion).toHaveLength(64);
    const blank = await collectHelloDevice('tizen', '   ', { userAgent: TIZEN, win: {} });
    expect(blank.appVersion).toBe('unknown');
  });
});
