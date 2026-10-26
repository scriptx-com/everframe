// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { getAppIdentifier, getDeviceMetadata } from '../../src/capture/metadata.js';
import { inferFormFactor } from '../../src/transport/draft-to-envelope.js';

describe('getDeviceMetadata', () => {
  const origUA = navigator.userAgent;
  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: origUA });
  });

  it('parses macOS UA', () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2_1) AppleWebKit',
    });
    const m = getDeviceMetadata();
    expect(m.os).toBe('macOS');
    expect(m.osVersion).toBe('14.2.1');
  });

  it('parses Windows UA', () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit',
    });
    const m = getDeviceMetadata();
    expect(m.os).toBe('Windows');
    expect(m.osVersion).toBe('10.0');
  });

  it('falls back to "unknown" os for empty UA', () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: '' });
    const m = getDeviceMetadata();
    expect(m.os).toBe('unknown');
  });

  it('populates locale + timezone via Intl', () => {
    const m = getDeviceMetadata();
    expect(typeof m.locale).toBe('string');
    expect(typeof m.timezone).toBe('string');
    expect(m.timezone.length).toBeGreaterThan(0);
  });

  it('omits network when navigator.connection is absent (jsdom default)', () => {
    const m = getDeviceMetadata();
    if (!('connection' in navigator)) {
      expect(m.network).toBeUndefined();
    }
  });

  it('populates screenSize + pixelRatio from window/screen primitives', () => {
    const m = getDeviceMetadata();
    expect(typeof m.screenSize.width).toBe('number');
    expect(typeof m.screenSize.height).toBe('number');
    expect(typeof m.pixelRatio).toBe('number');
  });
});

describe('getDeviceMetadata on a TV', () => {
  const origUA = navigator.userAgent;
  const scope = globalThis as Record<string, unknown>;
  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: origUA });
    delete scope['tizen'];
    delete scope['webapis'];
    delete scope['PalmSystem'];
  });
  const setUA = (value: string): void => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value });
  };

  it('reads a Tizen TV from its user agent and its own APIs', () => {
    setUA(
      'Mozilla/5.0 (SMART-TV; LINUX; Tizen 9.0) AppleWebKit/537.36 (KHTML, like Gecko) 120.0.6099.5/9.0 TV Safari/537.36',
    );
    scope['webapis'] = { productinfo: { getRealModel: () => 'QE55Q80DAT' } };
    scope['tizen'] = {
      systeminfo: {
        getCapability: (key: string) =>
          key === 'http://tizen.org/feature/platform.version' ? '9.0.1' : undefined,
        getTotalMemory: () => 2_147_483_648,
      },
      application: { getCurrentApplication: () => ({ appInfo: { id: 'Ab12Cd34.SandboxTV' } }) },
    };
    expect(getDeviceMetadata()).toMatchObject({
      os: 'Tizen',
      osVersion: '9.0.1',
      manufacturer: 'Samsung',
      model: 'QE55Q80DAT',
      totalMemory: 2_147_483_648,
      runtimeVersions: { chrome: '120.0.6099.5' },
    });
    expect(getAppIdentifier()).toBe('Ab12Cd34.SandboxTV');
  });

  it('falls back to the user agent when the Tizen APIs throw', () => {
    setUA('Mozilla/5.0 (SMART-TV; LINUX; Tizen 8.0) AppleWebKit/537.36');
    scope['tizen'] = {
      systeminfo: {
        getCapability: () => {
          throw new Error('SecurityError');
        },
      },
      application: {
        getCurrentApplication: () => {
          throw new Error('SecurityError');
        },
      },
    };
    const m = getDeviceMetadata();
    expect(m).toMatchObject({ os: 'Tizen', osVersion: '8.0', manufacturer: 'Samsung' });
    expect(m.model).toBeUndefined();
    expect(getAppIdentifier()).toBeUndefined();
  });

  it('reads an LG webOS TV from PalmSystem', () => {
    setUA(
      'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.5359.211 Safari/537.36 WebAppManager',
    );
    scope['PalmSystem'] = {
      deviceInfo: JSON.stringify({ modelName: 'OLED55C4', platformVersion: '9.2.0' }),
      identifier: 'com.mwaretv.app 1234',
    };
    expect(getDeviceMetadata()).toMatchObject({
      os: 'webOS',
      osVersion: '24',
      manufacturer: 'LG',
      model: 'OLED55C4',
      runtimeVersions: { chrome: '108.0.5359.211', webosPlatform: '9.2.0' },
    });
    expect(getAppIdentifier()).toBe('com.mwaretv.app');
  });

  it('omits the app ID when its getters throw', () => {
    setUA(
      'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/79.0.3945.79 WebAppManager',
    );
    const palm = {};
    Object.defineProperty(palm, 'identifier', {
      get() {
        throw new Error('denied');
      },
    });
    scope['PalmSystem'] = palm;
    expect(getAppIdentifier()).toBeUndefined();
    expect(getDeviceMetadata().os).toBe('webOS');

    setUA('Mozilla/5.0 (SMART-TV; LINUX; Tizen 8.0) AppleWebKit/537.36');
    const appInfo = {};
    Object.defineProperty(appInfo, 'id', {
      get() {
        throw new Error('denied');
      },
    });
    scope['tizen'] = { application: { getCurrentApplication: () => ({ appInfo }) } };
    expect(getAppIdentifier()).toBeUndefined();
  });

  it('keeps a desktop browser free of TV fields', () => {
    setUA(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
    );
    const m = getDeviceMetadata();
    expect(m.os).toBe('macOS');
    expect(m.manufacturer).toBeUndefined();
    expect(m.model).toBeUndefined();
    expect(getAppIdentifier()).toBeUndefined();
  });
});

describe('inferFormFactor', () => {
  it('calls every TV runtime a TV', () => {
    for (const userAgent of [
      'Mozilla/5.0 (SMART-TV; LINUX; Tizen 9.0) AppleWebKit/537.36',
      'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 WebAppManager',
      'Mozilla/5.0 (Linux; Kepler 2.0; AFTCA002 user/515; wv) AppleWebKit/537.36',
    ]) {
      expect(inferFormFactor({ ...getDeviceMetadata(), os: 'Linux', userAgent })).toBe('tv');
    }
  });
});
