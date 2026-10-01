// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { pageRedactionConfig, redactUrlPath } from '../../../src/capture/tv-snapshot/page-redact.js';
import { findLeaks } from './leak-assert.js';

const CONFIG = pageRedactionConfig();
const redact = (url: string): string => redactUrlPath(url, CONFIG);
const SECRETS = ['alice@example.test', 'alice%40example.test', '4111111111111111'];

describe('redactUrlPath — per-run percent decoding (final review finding 5)', () => {
  it.each([
    ['a malformed %ZZ escape', 'https://cdn.example.test/u/%ZZ-alice%40example.test/p.png'],
    ['an invalid UTF-8 byte %FF', 'https://cdn.example.test/u/%FF-alice%40example.test/p.png'],
    ['a lone % sign', 'https://cdn.example.test/u/100%-alice%40example.test/p.png'],
    ['a trailing lone %', 'https://cdn.example.test/u/alice%40example.test%/p.png'],
    ['an invalid byte in the same run as the @', 'https://cdn.example.test/u/alice%FF%40example.test/p.png'],
  ])('%s does not disable decoding of an encoded email in the same segment', (_label, url) => {
    const out = redact(url);
    expect(findLeaks(out, SECRETS)).toEqual([]);
    expect(out).toContain('%5BREDACTED%3AEMAIL%5D');
    expect(() => new URL(out)).not.toThrow();
  });

  it('decodes an encoded card number next to a malformed escape', () => {
    const out = redact('https://cdn.example.test/c/%ZZ-%34111111111111111/x.png');
    expect(findLeaks(out, SECRETS)).toEqual([]);
  });

  it('keeps a multi-byte UTF-8 run whole and leaves a clean segment byte-for-byte unchanged', () => {
    expect(redact('https://cdn.example.test/p/caf%C3%A9-%ZZ/x.png')).toBe('https://cdn.example.test/p/caf%C3%A9-%ZZ/x.png');
    expect(redact('https://cdn.example.test/p/%FF%/x.png')).toBe('https://cdn.example.test/p/%FF%/x.png');
  });

  it('scans a 20k-character near-miss segment in under a second', () => {
    const segment = '%4'.repeat(10_000) + '%ZZ'.repeat(3_000);
    const started = performance.now();
    redact(`https://cdn.example.test/${segment}`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
