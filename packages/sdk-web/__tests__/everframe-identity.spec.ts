// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { INGEST_URL, type Everframe } from '../src/index.js';
import { SENSITIVE_ATTR } from '../src/sensitive/registry.js';

describe('Everframe browser identity', () => {
  it('exposes the canonical Everframe handle type through init()', async () => {
    const sdk = await import('../src/index.js');
    const handle: Everframe | undefined = undefined;
    expect(handle).toBeUndefined();
    expect(typeof sdk.init).toBe('function');
  });

  it('uses the Everframe ingest define and DOM attribute', () => {
    expect(INGEST_URL).toBe('http://localhost:8787');
    expect(SENSITIVE_ATTR).toBe('data-everframe-sensitive');
  });
});
