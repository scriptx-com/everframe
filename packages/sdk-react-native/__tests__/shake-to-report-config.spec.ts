// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { __extractBridgeConfigForTesting as extract } from '../src/runtime.js';

describe('shake-to-report config flattening', () => {
  it('flattens explicit true and false values', () => {
    expect(extract({ sdkKey: 'k', shakeToReport: { enabled: true } }).shakeToReportEnabled)
      .toBe(true);
    expect(extract({ sdkKey: 'k', shakeToReport: { enabled: false } }).shakeToReportEnabled)
      .toBe(false);
  });

  it('omits the bridge field when the host keeps the native default', () => {
    expect('shakeToReportEnabled' in extract({ sdkKey: 'k' })).toBe(false);
    expect('shakeToReportEnabled' in extract({ sdkKey: 'k', shakeToReport: {} })).toBe(false);
  });
});
