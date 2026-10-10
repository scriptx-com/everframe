// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { SDKPlatform } from '../src/envelope.js';

describe('PLAT-04: SDKPlatform enum includes all four TV strings', () => {
  it.each(['web', 'ios', 'android', 'tvos', 'tizen', 'webos', 'androidtv', 'roku', 'vega'] as const)(
    'accepts %s',
    (value) => {
      expect(SDKPlatform.safeParse(value).success).toBe(true);
    }
  );

  it('rejects unknown platform', () => {
    expect(SDKPlatform.safeParse('linux').success).toBe(false);
    // Vega OS reports as 'vega'; React Native's Platform.OS there is 'kepler'.
    expect(SDKPlatform.safeParse('kepler').success).toBe(false);
  });
});
