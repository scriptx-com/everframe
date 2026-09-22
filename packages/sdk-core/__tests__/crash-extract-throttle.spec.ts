// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { describe, expect, it } from 'vitest';
import { extractCrashFacts, createCrashThrottle } from '../src/crash/index.js';

describe('extractCrashFacts', () => {
  it('extracts name/message/frames from an Error, dropping the header line', () => {
    const err = new TypeError('x is not a function');
    err.stack = `TypeError: x is not a function\n    at render (app.tsx:10:5)\n    at main (index.ts:3:1)`;
    const facts = extractCrashFacts(err);
    expect(facts.exceptionType).toBe('TypeError');
    expect(facts.message).toBe('x is not a function');
    expect(facts.frames).toEqual([
      { raw: 'at render (app.tsx:10:5)' },
      { raw: 'at main (index.ts:3:1)' },
    ]);
  });

  it('handles non-Error rejection reasons', () => {
    expect(extractCrashFacts('boom')).toEqual({ exceptionType: 'UnhandledValue', message: 'boom', frames: [] });
    expect(extractCrashFacts({ code: 7 }).exceptionType).toBe('UnhandledValue');
    expect(extractCrashFacts(undefined).message).toBe('undefined');
  });

  it('enforces caps: message 4096, frames 256, raw 1024', () => {
    const err = new Error('m'.repeat(9000));
    err.stack = 'Error\n' + Array.from({ length: 300 }, (_, i) => `    at f${i} (${'p'.repeat(2000)}:1:1)`).join('\n');
    const facts = extractCrashFacts(err);
    expect(facts.message).toHaveLength(4096);
    expect(facts.frames).toHaveLength(256);
    expect(facts.frames[0]!.raw).toHaveLength(1024);
  });
});

describe('createCrashThrottle', () => {
  it('allows 1 per fingerprint and 10 per session', () => {
    const t = createCrashThrottle();
    expect(t.shouldReport('aaaa')).toBe(true);
    expect(t.shouldReport('aaaa')).toBe(false); // repeat fingerprint suppressed
    for (let i = 0; i < 9; i++) expect(t.shouldReport(`fp-${i}`)).toBe(true);
    expect(t.shouldReport('fresh')).toBe(false); // session cap of 10 hit
  });
});
