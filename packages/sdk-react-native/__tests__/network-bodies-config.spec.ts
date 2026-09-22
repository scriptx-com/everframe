// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { __extractBridgeConfigForTesting as extract } from '../src/runtime.js';

describe('networkBodies config flattening', () => {
  it('flattens disabled:true to the flat bridge flag', () => {
    expect(extract({ apiKey: 'k', networkBodies: { disabled: true } }).networkBodiesDisabled).toBe(true);
  });

  it('flattens disabled:false to false', () => {
    expect(extract({ apiKey: 'k', networkBodies: { disabled: false } }).networkBodiesDisabled).toBe(false);
  });

  it('omits the flag entirely when networkBodies is absent', () => {
    expect('networkBodiesDisabled' in extract({ apiKey: 'k' })).toBe(false);
  });

  it('omits the flag when networkBodies is present but disabled is not set', () => {
    expect('networkBodiesDisabled' in extract({ apiKey: 'k', networkBodies: {} })).toBe(false);
  });
});
