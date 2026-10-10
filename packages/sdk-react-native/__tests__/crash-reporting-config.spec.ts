// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The crash-reporting veto crosses the codegen boundary the way installIdentifier.disabled
// does: nested host-facing shape, flat wire field, polarity flipped exactly once natively
// (JS names the VETO, native names the PERMISSION `capture.crash`).
import { describe, expect, it } from 'vitest';
import { __extractBridgeConfigForTesting as extract } from '../src/runtime.js';

describe('crashReporting config flattening', () => {
  it('flattens disabled:true to the flat bridge flag', () => {
    expect(extract({ apiKey: 'k', crashReporting: { disabled: true } }).crashReportingDisabled).toBe(true);
  });
  it('flattens disabled:false to false', () => {
    expect(extract({ apiKey: 'k', crashReporting: { disabled: false } }).crashReportingDisabled).toBe(false);
  });
  it('omits the flag when crashReporting is absent', () => {
    expect('crashReportingDisabled' in extract({ apiKey: 'k' })).toBe(false);
  });
  it('omits the flag when only promise rejections are configured', () => {
    expect('crashReportingDisabled' in extract({ apiKey: 'k', crashReporting: { promiseRejections: { enabled: true } } })).toBe(false);
  });
});
