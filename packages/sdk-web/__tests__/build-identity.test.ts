// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppBuild } from '../src/build-identity.js';

const g = globalThis as { __EVERFRAME_BUILD__?: unknown };
afterEach(() => {
  delete g.__EVERFRAME_BUILD__;
});

describe('resolveAppBuild', () => {
  it('prefers the configured build', () => {
    g.__EVERFRAME_BUILD__ = { buildId: 'injected' };
    expect(resolveAppBuild('configured')).toBe('configured');
  });

  it('falls back to the injected build id', () => {
    g.__EVERFRAME_BUILD__ = { buildId: 'injected' };
    expect(resolveAppBuild(undefined)).toBe('injected');
  });

  it('reads the global at call time, not import time', () => {
    expect(resolveAppBuild(undefined)).toBeUndefined();
    g.__EVERFRAME_BUILD__ = { buildId: 'late' };
    expect(resolveAppBuild(undefined)).toBe('late');
  });

  it.each([null, 'b', {}, { buildId: '' }, { buildId: ' \t' }, { buildId: 7 }, { buildId: 'a'.repeat(201) }, { buildId: 'a\u0000b' }, { buildId: 'a\ud800' }])(
    'ignores an invalid injected value %j',
    (value) => {
      g.__EVERFRAME_BUILD__ = value;
      expect(resolveAppBuild(undefined)).toBeUndefined();
    },
  );
});
