// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// attachPinUi config passthrough (spec 2026-08-19) — the host-facing
// `RuntimeConfig.attachPinUi` union reaching the bridge's flat
// `ConfigOpts.attachPinUi?: string` unchanged.
import { describe, expect, it } from 'vitest';
import { __extractBridgeConfigForTesting as extract } from '../src/runtime.js';

describe('attachPinUi config passthrough', () => {
  it('passes "custom" through unchanged', () => {
    expect(extract({ sdkKey: 'k', attachPinUi: 'custom' }).attachPinUi).toBe('custom');
  });

  it('passes "off" through unchanged', () => {
    expect(extract({ sdkKey: 'k', attachPinUi: 'off' }).attachPinUi).toBe('off');
  });

  it('passes "builtin" through unchanged', () => {
    expect(extract({ sdkKey: 'k', attachPinUi: 'builtin' }).attachPinUi).toBe('builtin');
  });

  it('omits the flag entirely when absent — native defaults to builtin', () => {
    expect('attachPinUi' in extract({ sdkKey: 'k' })).toBe(false);
  });
});
