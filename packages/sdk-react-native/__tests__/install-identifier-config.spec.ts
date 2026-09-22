// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// MAI meter Plan 2b-ii — the install-identifier veto crosses the codegen
// boundary the way networkBodies.disabled already does: nested host-facing
// shape, flat wire field, polarity flipped exactly once natively (JS names the
// VETO, native names the PERMISSION).
import { describe, expect, it } from 'vitest';
import { __extractBridgeConfigForTesting as extract } from '../src/runtime.js';

describe('installIdentifier config flattening', () => {
  it('flattens disabled:true to the flat bridge flag', () => {
    expect(extract({ apiKey: 'k', installIdentifier: { disabled: true } })
      .installIdentifierDisabled).toBe(true);
  });

  it('flattens disabled:false to false', () => {
    expect(extract({ apiKey: 'k', installIdentifier: { disabled: false } })
      .installIdentifierDisabled).toBe(false);
  });

  it('omits the flag entirely when installIdentifier is absent', () => {
    expect('installIdentifierDisabled' in extract({ apiKey: 'k' })).toBe(false);
  });

  it('omits the flag when installIdentifier is present but disabled is not set', () => {
    expect('installIdentifierDisabled' in extract({ apiKey: 'k', installIdentifier: {} }))
      .toBe(false);
  });
});
