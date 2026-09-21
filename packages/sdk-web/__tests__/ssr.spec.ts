// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { init } from '../src/init.js';

describe('SSR guard', () => {
  it('throws an actionable error instead of crashing on localStorage', () => {
    expect(() => init({ apiKey: 'k', appVersion: '1.0.0' })).toThrowError(
      /only run in a browser/i,
    );
  });

  it('names the client-side hook to call in the message', () => {
    let message = '';
    try {
      init({ apiKey: 'k', appVersion: '1.0.0' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/onMounted|onMount|useEffect/);
  });
});
