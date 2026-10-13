// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { isSensitiveKey, normalizeCrashDetails } from '../src/index.js';

describe('isSensitiveKey', () => {
  it.each([
    'password',
    'PASSWORD',
    'userPassword',
    'passwd',
    'client_secret',
    'token',
    'accessToken',
    'Authorization',
    'AUTHORIZATION',
    'set-cookie',
    'Cookie',
    'apiKey',
    'api_key',
    'X-API-KEY',
    'Api-Key',
  ])('treats %s as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['assetId', 'retries', 'screen', 'apiVersion', 'keyboard', 'author'])(
    'keeps %s',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );

  it('is the rule normalizeCrashDetails applies', () => {
    const details = normalizeCrashDetails(
      { metadata: { 'X-API-KEY': 'k', assetId: 'A-1' } },
      (v) => v,
      'error',
    );
    expect(details?.metadata).toEqual({ 'X-API-KEY': '[REDACTED]', assetId: 'A-1' });
  });
});
