// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { parseStagedBuildPartial } from '@everframe/protocol';
import { deriveBundleName, generateBuildId, identityModuleSource } from '../src/identity.js';

describe('build identity', () => {
  it('generates a distinct uuid each call', () => {
    const a = generateBuildId();
    const b = generateBuildId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('generates ids the staging schema accepts', () => {
    expect(() =>
      parseStagedBuildPartial({
        schema: 1,
        buildId: generateBuildId(),
        platform: 'ios',
        bundleName: deriveBundleName('ios'),
        dev: false,
      }),
    ).not.toThrow();
  });

  it('derives the platform bundle name', () => {
    expect(deriveBundleName('android')).toBe('index.android.bundle');
    expect(deriveBundleName('ios')).toBe('main.jsbundle');
  });

  it('emits a module that assigns a frozen global', () => {
    const source = identityModuleSource({
      schema: 1,
      buildId: '8f3ac21e-0000-4000-8000-000000000001',
      platform: 'android',
      bundleName: 'index.android.bundle',
      dev: false,
    });
    const globalThisStub: Record<string, unknown> = {};
    new Function('globalThis', source)(globalThisStub);
    expect(globalThisStub.__EVERFRAME_BUILD__).toEqual({
      buildId: '8f3ac21e-0000-4000-8000-000000000001',
      bundleName: 'index.android.bundle',
      platform: 'android',
    });
    expect(Object.isFrozen(globalThisStub.__EVERFRAME_BUILD__)).toBe(true);
  });

  // This only ever asserted that a benign, hardcoded name produces parseable
  // JavaScript (the `</script` check was meaningless for a `.js` polyfill
  // that is never inlined into HTML). Named for what it actually verifies;
  // a real injection test would have to feed it a hostile bundleName, which
  // the staging schema rejects upstream anyway.
  it('emits parseable javascript', () => {
    const source = identityModuleSource({
      schema: 1,
      buildId: '8f3ac21e-0000-4000-8000-000000000001',
      platform: 'android',
      bundleName: 'index.android.bundle',
      dev: false,
    });
    expect(() => new Function('globalThis', source)).not.toThrow();
  });
});
