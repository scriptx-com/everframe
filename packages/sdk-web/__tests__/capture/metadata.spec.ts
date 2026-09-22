// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { getDeviceMetadata } from '../../src/capture/metadata.js';

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
