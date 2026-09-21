// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import {
  CrashDetails,
  MAX_CRASH_CONTEXT_UNITS,
  MAX_CRASH_DETAIL_KEY_UNITS,
  MAX_CRASH_DETAIL_LEVELS,
  MAX_CRASH_DETAIL_NODES,
  MAX_CRASH_DETAIL_SCAN_UNITS,
  MAX_CRASH_DETAIL_STRING_UNITS,
  MAX_CRASH_DETAILS_BYTES,
  normalizeCrashDetails,
} from '../src/index.js';

const identity = (value: string): string => value;
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

function fourLevels(): Record<string, unknown> {
  return { second: { third: { fourth: { value: true } } } };
}

function fiveLevels(): Record<string, unknown> {
  return { second: { third: { fourth: { fifth: { value: true } } } } };
}

function escapedDetails(byteCount: 8192 | 8193): { metadata: Record<string, string> } {
  // JSON syntax is 49 bytes: {"metadata":{ + five one-letter property
  // prefixes/quotes + four commas + }}. Three backslash values serialize at
  // two bytes per code unit, leaving the final literal sized independently.
  return {
    metadata: {
      a: '\\'.repeat(1024),
      b: '\\'.repeat(1024),
      c: '\\'.repeat(1024),
      d: 'x'.repeat(1024),
      e: 'x'.repeat(byteCount === 8192 ? 975 : 976),
    },
  };
}

describe('CrashDetails', () => {
  it('normalizes a healthy details object and redacts sensitive metadata keys', () => {
    const details = normalizeCrashDetails({
      severity: 'warning',
      context: 'checkout',
      metadata: {
        retry: 2,
        flags: [true, null],
        request: { accessToken: 'synthetic' },
      },
    }, identity, 'error');

    expect(details).toEqual({
      severity: 'warning',
      context: 'checkout',
      metadata: {
        retry: 2,
        flags: [true, null],
        request: { accessToken: '[REDACTED]' },
      },
    });
    expect(CrashDetails.safeParse(details).success).toBe(true);
  });

  it('keeps absent details absent', () => {
    expect(normalizeCrashDetails(undefined, identity)).toBeUndefined();
    expect(normalizeCrashDetails(undefined, identity, 'error')).toEqual({ severity: 'error' });
  });

  it('uses the explicit severity, otherwise the caller default, without accepting invalid values', () => {
    expect(normalizeCrashDetails({ severity: 'info' }, identity, 'error')).toEqual({ severity: 'info' });
    expect(normalizeCrashDetails({}, identity, 'warning')).toEqual({ severity: 'warning' });
    expect(normalizeCrashDetails({ severity: 'fatal' }, identity, 'error')).toEqual({
      severity: 'error',
      truncated: true,
    });
  });

  it('normalizes unsafe text, scans and caps by UTF-16 units without splitting pairs', () => {
    const seen: string[] = [];
    const result = normalizeCrashDetails({
      context: `${'c'.repeat(MAX_CRASH_CONTEXT_UNITS - 1)}😀tail`,
      metadata: {
        unsafe: 'left\0\ud800😀\udc00right',
        huge: `${'x'.repeat(MAX_CRASH_DETAIL_SCAN_UNITS - 1)}😀unscanned`,
      },
    }, value => {
      seen.push(value);
      return value;
    });

    expect(result?.context).toBe('c'.repeat(MAX_CRASH_CONTEXT_UNITS - 1));
    expect(result?.metadata?.unsafe).toBe('left��😀�right');
    expect(result?.metadata?.huge).toBe('x'.repeat(MAX_CRASH_DETAIL_STRING_UNITS));
    expect(seen).toContain('x'.repeat(MAX_CRASH_DETAIL_SCAN_UNITS - 1));
    expect(result?.truncated).toBe(true);
    expect(CrashDetails.safeParse(result).success).toBe(true);
  });

  it('rechecks string and key caps after redaction expansion and keeps the first collided key', () => {
    const result = normalizeCrashDetails({
      metadata: {
        first: 'expand-value',
        one: 1,
        two: 2,
      },
    }, value => {
      if (value === 'expand-value') return 'v'.repeat(MAX_CRASH_DETAIL_STRING_UNITS + 10);
      if (value === 'one' || value === 'two') return 'k'.repeat(MAX_CRASH_DETAIL_KEY_UNITS + 10);
      return value;
    });

    const keys = Object.keys(result?.metadata ?? {});
    expect(result?.metadata?.first).toBe('v'.repeat(MAX_CRASH_DETAIL_STRING_UNITS));
    expect(keys).toContain('k'.repeat(MAX_CRASH_DETAIL_KEY_UNITS));
    expect(keys).toHaveLength(2);
    expect(result?.metadata?.[keys[1]!]).toBe(1);
    expect(result?.truncated).toBe(true);
  });

  it('accepts four container levels and truncates a fifth', () => {
    const atLimit = normalizeCrashDetails({ metadata: fourLevels() }, identity);
    const overLimit = normalizeCrashDetails({ metadata: fiveLevels() }, identity);

    expect(atLimit).toEqual({ metadata: fourLevels() });
    expect(overLimit).toEqual({
      metadata: { second: { third: { fourth: {} } } },
      truncated: true,
    });
    expect(CrashDetails.safeParse({ metadata: fourLevels() }).success).toBe(true);
    expect(CrashDetails.safeParse({ metadata: fiveLevels() }).success).toBe(false);
    expect(MAX_CRASH_DETAIL_LEVELS).toBe(4);
  });

  it('accepts 128 metadata nodes and stops before inspecting node 129', () => {
    const atLimit = Object.fromEntries(Array.from({ length: MAX_CRASH_DETAIL_NODES - 1 }, (_, i) => [`k${i}`, i]));
    const overLimit = { ...atLimit, overflow: 'never' };
    const normalized = normalizeCrashDetails({ metadata: overLimit }, identity)!;

    expect(normalizeCrashDetails({ metadata: atLimit }, identity)).toEqual({ metadata: atLimit });
    expect(Object.keys(normalized.metadata!)).toHaveLength(MAX_CRASH_DETAIL_NODES - 1);
    expect(normalized.metadata).not.toHaveProperty('overflow');
    expect(normalized.truncated).toBe(true);
    expect(CrashDetails.safeParse({ metadata: atLimit }).success).toBe(true);
    expect(CrashDetails.safeParse({ metadata: overLimit }).success).toBe(false);
  });

  it('accounts for JSON escaping at the exact 8192-byte boundary', () => {
    const atLimit = escapedDetails(8192);
    const overLimit = escapedDetails(8193);
    expect(jsonBytes(atLimit)).toBe(MAX_CRASH_DETAILS_BYTES);
    expect(jsonBytes(overLimit)).toBe(MAX_CRASH_DETAILS_BYTES + 1);

    expect(normalizeCrashDetails(atLimit, identity)).toEqual(atLimit);
    const normalized = normalizeCrashDetails(overLimit, identity)!;
    expect(normalized.truncated).toBe(true);
    expect(jsonBytes(normalized)).toBeLessThanOrEqual(MAX_CRASH_DETAILS_BYTES);
    expect(normalized.metadata).toBeDefined();
    expect(CrashDetails.safeParse(atLimit).success).toBe(true);
    expect(CrashDetails.safeParse(overLimit).success).toBe(false);
  });

  it('bounds sparse array inspection and output copies by the node budget', () => {
    let descriptorReads = 0;
    let valueReads = 0;
    const huge = new Proxy(new Array(1_000_000), {
      getOwnPropertyDescriptor(target, property) {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      get(target, property, receiver) {
        valueReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    const normalized = normalizeCrashDetails({ metadata: { huge } }, identity)!;
    expect(normalized.truncated).toBe(true);
    expect(normalized.metadata?.huge).toEqual(Array.from({ length: 126 }, () => null));
    expect(descriptorReads).toBeLessThanOrEqual(MAX_CRASH_DETAIL_NODES);
    expect(valueReads).toBe(0);
  });

  it('characterizes engine key discovery while bounding descriptor reads and output copies', () => {
    let keyResultReads = 0;
    let descriptorReads = 0;
    const keys = new Proxy({ length: 10_000 } as ArrayLike<string>, {
      get(target, property) {
        if (property === 'length') return target.length;
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          keyResultReads += 1;
          return `k${property}`;
        }
        return Reflect.get(target, property);
      },
    });
    const metadata = new Proxy(Object.create(null) as Record<string, unknown>, {
      ownKeys: () => keys,
      getOwnPropertyDescriptor: (_target, property) => {
        descriptorReads += 1;
        return { configurable: true, enumerable: true, value: typeof property === 'string' ? property : '', writable: true };
      },
    });
    const normalized = normalizeCrashDetails({ metadata }, identity)!;

    expect(Object.keys(normalized.metadata!)).toHaveLength(MAX_CRASH_DETAIL_NODES - 1);
    expect(keyResultReads).toBe(10_000);
    expect(descriptorReads).toBe(MAX_CRASH_DETAIL_NODES - 1);
    expect(normalized.truncated).toBe(true);
  });

  it('contains revoked proxies at the details root, metadata root and nested values', () => {
    const revokedDetails = Proxy.revocable({}, {});
    const revokedMetadata = Proxy.revocable({}, {});
    const revokedNested = Proxy.revocable({}, {});
    revokedDetails.revoke();
    revokedMetadata.revoke();
    revokedNested.revoke();

    expect(normalizeCrashDetails(revokedDetails.proxy, identity)).toEqual({ truncated: true });
    expect(normalizeCrashDetails({ metadata: revokedMetadata.proxy }, identity)).toEqual({ truncated: true });
    expect(normalizeCrashDetails({
      metadata: { before: 1, revoked: revokedNested.proxy, after: 2 },
    }, identity)).toEqual({
      metadata: { before: 1, after: 2 },
      truncated: true,
    });
  });

  it('normalizes hostile host objects before schema validation', () => {
    const throwingDetails: Record<string, unknown> = { metadata: { kept: true } };
    Object.defineProperty(throwingDetails, 'context', {
      enumerable: true,
      get: () => { throw new Error('host getter must stay contained'); },
    });
    const revokedDetails = Proxy.revocable({}, {});
    revokedDetails.revoke();

    const normalizedGetter = normalizeCrashDetails(throwingDetails, identity);
    const normalizedRevoked = normalizeCrashDetails(revokedDetails.proxy, identity);
    expect(normalizedGetter).toEqual({ metadata: { kept: true }, truncated: true });
    expect(normalizedRevoked).toEqual({ truncated: true });
    expect(CrashDetails.safeParse(normalizedGetter).success).toBe(true);
    expect(CrashDetails.safeParse(normalizedRevoked).success).toBe(true);
  });

  it('accepts cross-realm ordinary records while still rejecting class instances', () => {
    const foreignDetails = runInNewContext(`({
      context: 'foreign',
      metadata: { nested: { value: 7 }, list: [true, null] },
    })`) as unknown;
    const foreignClass = runInNewContext('new (class ForeignClass { constructor() { this.value = 8; } })()') as unknown;
    class LocalClass { value = 9; }

    expect(normalizeCrashDetails(foreignDetails, identity)).toEqual({
      context: 'foreign',
      metadata: { nested: { value: 7 }, list: [true, null] },
    });
    expect(normalizeCrashDetails({ metadata: {
      foreignClass,
      localClass: new LocalClass(),
      after: 'kept',
    } }, identity)).toEqual({
      metadata: {
        after: 'kept',
      },
      truncated: true,
    });
  });

  it('drops keys beyond the input scan bound without traversing their values', () => {
    let nestedReads = 0;
    const nested = new Proxy({ exposed: 'no' }, {
      ownKeys(target) {
        nestedReads += 1;
        return Reflect.ownKeys(target);
      },
    });
    const metadata = Object.create(null) as Record<string, unknown>;
    metadata['k'.repeat(MAX_CRASH_DETAIL_SCAN_UNITS + 1)] = nested;

    expect(normalizeCrashDetails({ metadata }, identity)).toEqual({
      metadata: {},
      truncated: true,
    });
    expect(nestedReads).toBe(0);
  });

  it('omits unsupported data while retaining siblings and preserving array indexes', () => {
    const result = normalizeCrashDetails({
      metadata: {
        ok: 3,
        badNumber: Number.POSITIVE_INFINITY,
        fn: () => undefined,
        bigint: 1n,
        symbol: Symbol('no'),
        array: [1, undefined, () => undefined, 4],
      },
    }, identity);

    expect(result).toEqual({
      metadata: { ok: 3, array: [1, null, null, 4] },
      truncated: true,
    });
  });

  it('omits accessors and class instances without invoking getters or toJSON', () => {
    let getterCalls = 0;
    let toJSONCalls = 0;
    const metadata: Record<string, unknown> = { before: true, after: true };
    Object.defineProperty(metadata, 'accessor', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('must not run');
      },
    });
    metadata.classValue = new class {
      toJSON(): string {
        toJSONCalls += 1;
        return 'coerced';
      }
    }();
    metadata.plainToJSON = { kept: 'yes', toJSON: () => {
      toJSONCalls += 1;
      return 'coerced';
    } };

    expect(normalizeCrashDetails({ metadata }, identity)).toEqual({
      metadata: { before: true, after: true, plainToJSON: { kept: 'yes' } },
      truncated: true,
    });
    expect(getterCalls).toBe(0);
    expect(toJSONCalls).toBe(0);
  });

  it('drops path cycles but copies repeated noncyclic references', () => {
    const shared = { value: 7 };
    const cyclic: Record<string, unknown> = { sibling: 'kept' };
    cyclic.self = cyclic;
    const result = normalizeCrashDetails({ metadata: { first: shared, second: shared, cyclic } }, identity);

    expect(result).toEqual({
      metadata: {
        first: { value: 7 },
        second: { value: 7 },
        cyclic: { sibling: 'kept' },
      },
      truncated: true,
    });
    expect(result?.metadata?.first).not.toBe(result?.metadata?.second);
  });

  it('redacts normalized sensitive keys without traversing their values or marking privacy loss', () => {
    let getterCalls = 0;
    const secretValue = {};
    Object.defineProperty(secretValue, 'value', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'exposed';
      },
    });
    const result = normalizeCrashDetails({
      metadata: {
        request: {
          accessToken: secretValue,
          'API-key': { deeply: { nested: { beyond: { limits: true } } } },
          COOKIE_value: 'cookie',
        },
      },
    }, identity);

    expect(result).toEqual({
      metadata: {
        request: {
          accessToken: '[REDACTED]',
          'API-key': '[REDACTED]',
          COOKIE_value: '[REDACTED]',
        },
      },
    });
    expect(getterCalls).toBe(0);
  });

  it('normalizes colliding unsafe keys and materializes prototype-related keys safely', () => {
    const metadata = Object.create(null) as Record<string, unknown>;
    metadata['a\0'] = 1;
    metadata['a\ud800'] = 2;
    Object.defineProperty(metadata, '__proto__', { enumerable: true, configurable: true, value: 'kept' });
    metadata['constructor'] = 'constructor';
    metadata['prototype'] = 'prototype';
    const result = normalizeCrashDetails({ metadata }, identity)!;

    expect(Object.keys(result.metadata!)).toEqual(['a�', '__proto__', 'constructor', 'prototype']);
    expect(result.metadata?.['a�']).toBe(1);
    expect(result.metadata?.['__proto__']).toBe('kept');
    expect(Object.getPrototypeOf(result.metadata!)).toBeNull();
    expect(result.truncated).toBe(true);
  });

  it('contains throwing redactors and known-option accessors to the affected optional fields', () => {
    let extraGetterCalls = 0;
    const input: Record<string, unknown> = { context: 'bad', metadata: { safe: 'good', bad: 'bad' } };
    Object.defineProperty(input, 'severity', { enumerable: true, get: () => { throw new Error('no'); } });
    Object.defineProperty(input, 'extra', { enumerable: true, get: () => { extraGetterCalls += 1; return 'ignored'; } });

    const result = normalizeCrashDetails(input, value => {
      if (value === 'bad') throw new Error('redactor failed');
      return value;
    });
    expect(result).toEqual({ metadata: { safe: 'good' }, truncated: true });
    expect(extraGetterCalls).toBe(0);
  });

  it('omits fields when a redactor returns a non-string value', () => {
    const nonStringRedactor = ((value: string): unknown => value === 'drop' ? 7 : value) as (value: string) => string;
    expect(normalizeCrashDetails({
      context: 'drop',
      metadata: { kept: 'yes', dropped: 'drop' },
    }, nonStringRedactor)).toEqual({
      metadata: { kept: 'yes' },
      truncated: true,
    });
  });

  it('returns a fresh snapshot that does not change after host mutation', () => {
    const child = { value: 'before' };
    const source = { context: 'context', metadata: { child, list: [1, 2] } };
    const result = normalizeCrashDetails(source, identity)!;
    child.value = 'after';
    source.metadata.list.push(3);
    source.context = 'changed';

    expect(result).toEqual({ context: 'context', metadata: { child: { value: 'before' }, list: [1, 2] } });
    expect(result.metadata).not.toBe(source.metadata);
  });

  it('directly rejects malformed details without relying on normalization', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cases: unknown[] = [
      { severity: 'fatal' },
      { context: 'x'.repeat(MAX_CRASH_CONTEXT_UNITS + 1) },
      { context: 'nul\0' },
      { context: '\ud800' },
      { metadata: [] },
      { metadata: { ['k'.repeat(MAX_CRASH_DETAIL_KEY_UNITS + 1)]: true } },
      { metadata: { nested: { ['k'.repeat(MAX_CRASH_DETAIL_KEY_UNITS + 1)]: true } } },
      { metadata: { value: 'x'.repeat(MAX_CRASH_DETAIL_STRING_UNITS + 1) } },
      { metadata: { value: Number.NaN } },
      { metadata: cyclic },
      { metadata: fiveLevels() },
      { metadata: Object.fromEntries(Array.from({ length: MAX_CRASH_DETAIL_NODES }, (_, i) => [`k${i}`, i])) },
      escapedDetails(8193),
      { extra: true },
    ];
    for (const [index, malformed] of cases.entries()) {
      expect(CrashDetails.safeParse(malformed).success, `malformed case ${index}`).toBe(false);
    }
  });
});
