// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// companionDeviceId config passthrough (naming spec 2026-08-24) — the
// host-facing `RuntimeConfig.companionDeviceId` (inherited structurally from
// `ConfigOpts`, same as `attachPinUi`) reaching the bridge's flat
// `ConfigOpts.companionDeviceId?: string` unchanged.
import { describe, expect, it } from 'vitest';
import { __extractBridgeConfigForTesting as extract } from '../src/runtime.js';

describe('companionDeviceId config passthrough', () => {
  it('passes an explicit id through unchanged', () => {
    expect(
      extract({ apiKey: 'k', companionDeviceId: 'mdm-serial-1234' })
        .companionDeviceId,
    ).toBe('mdm-serial-1234');
  });

  it('omits the field entirely when absent — native falls through to its own resolution chain', () => {
    expect('companionDeviceId' in extract({ apiKey: 'k' })).toBe(false);
  });
});
