// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { describe, it, expect } from 'vitest';
import { contentTypeAllowed, capUtf8, redactBodyText } from '../../src/capture/network-body.js';

describe('contentTypeAllowed', () => {
  const allow = ['application/json', 'text/*'];
  it('matches exact and wildcard types, ignoring params + case', () => {
    expect(contentTypeAllowed('application/json; charset=utf-8', allow)).toBe(true);
    expect(contentTypeAllowed('TEXT/HTML', allow)).toBe(true);
    expect(contentTypeAllowed('text/plain', allow)).toBe(true);
  });
  it('rejects binary / unknown / missing types', () => {
    expect(contentTypeAllowed('image/png', allow)).toBe(false);
    expect(contentTypeAllowed('application/octet-stream', allow)).toBe(false);
    expect(contentTypeAllowed('multipart/form-data; boundary=x', allow)).toBe(false);
    expect(contentTypeAllowed(null, allow)).toBe(false);
    expect(contentTypeAllowed(undefined, allow)).toBe(false);
  });
});

describe('capUtf8', () => {
  it('returns the input untouched when within the cap', () => {
    expect(capUtf8('hello', 8192)).toEqual({ text: 'hello', truncated: false, bytes: 5 });
  });
  it('truncates at the byte cap and reports the ORIGINAL byte length', () => {
    const r = capUtf8('a'.repeat(100), 10);
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBe(100);
    expect(r.text.length).toBe(10);
  });
  it('never splits a multi-byte char across the cut', () => {
    // '€' is 3 UTF-8 bytes; cap of 2 must drop it entirely, not emit half.
    const r = capUtf8('€€', 2);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe(''); // no partial code unit
  });
});

describe('redactBodyText', () => {
  it('masks JWT and Luhn CC inside a JSON body via the shared engine', () => {
    const body = JSON.stringify({ token: 'eyJhbGci.eyJzdWIi.SflKxwRJ', card: '4242 4242 4242 4242' });
    const out = redactBodyText(body, {});
    expect(out).toContain('[REDACTED:JWT]');
    expect(out).toContain('[REDACTED:CC]');
  });
});
