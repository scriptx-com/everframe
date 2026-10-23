// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { __extractBridgeConfigForTesting as extract } from '../src/runtime.js';

describe('quick capture config flattening', () => {
  it('maps quickCapture.enabled=false to bridge.quickCaptureEnabled=false', () => {
    expect(extract({ sdkKey: 'k', quickCapture: { enabled: false } }).quickCaptureEnabled).toBe(
      false,
    );
    expect(extract({ sdkKey: 'k', quickCapture: { enabled: true } }).quickCaptureEnabled).toBe(
      true,
    );
  });

  it('omits quickCaptureEnabled when quickCapture is absent', () => {
    expect('quickCaptureEnabled' in extract({ sdkKey: 'k' })).toBe(false);
    expect('quickCaptureEnabled' in extract({ sdkKey: 'k', quickCapture: {} })).toBe(false);
  });
});
