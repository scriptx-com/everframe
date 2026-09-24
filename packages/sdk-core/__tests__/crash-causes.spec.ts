// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CRASH_CAUSE_BYTES,
  MAX_CRASH_CAUSE_STACK_SCAN_UNITS,
} from '@everframe/protocol';
import { extractCrashCauseChain } from '../src/crash/index.js';

const identity = (value: string): string => value;

function errorWithCause(message: string, cause: unknown): Error {
  return new Error(message, { cause });
}

function dataCause(target: object, cause: unknown): void {
  Object.defineProperty(target, 'cause', {
    configurable: true,
    enumerable: false,
    value: cause,
    writable: true,
  });
}

function dataStack(target: object, stack: string): void {
  Object.defineProperty(target, 'stack', {
    configurable: true,
    enumerable: false,
    value: stack,
    writable: true,
  });
}

type ErrorConstructorWithFormatter = ErrorConstructor & {
  prepareStackTrace?: (error: Error, frames: unknown[]) => unknown;
};

function withPrepareStackTrace<T>(
  formatter: (error: Error, frames: unknown[]) => unknown,
  run: () => T,
): T {
  const constructor = Error as ErrorConstructorWithFormatter;
  const previous = Object.getOwnPropertyDescriptor(constructor, 'prepareStackTrace');
  Object.defineProperty(constructor, 'prepareStackTrace', {
    configurable: true,
    value: formatter,
    writable: true,
  });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(constructor, 'prepareStackTrace', previous);
    else Reflect.deleteProperty(constructor, 'prepareStackTrace');
  }
}

function nativeTypeCause(): TypeError {
  return new TypeError('inner');
}

describe('extractCrashCauseChain', () => {
  it('extracts a real Error cause with its bounded raw stack frames', () => {
    const inner = nativeTypeCause();
    const outer = errorWithCause('outer', inner);

    const chain = extractCrashCauseChain(outer, identity, () => true);
    expect(chain?.causes[0]).toMatchObject({
      exceptionType: 'TypeError',
      message: 'inner',
      framesTruncated: false,
    });
    expect(chain?.causes[0]?.frames.some(frame => frame.raw.includes('nativeTypeCause'))).toBe(true);
    expect(chain?.truncated).toBe(false);
  });

  it('materializes ordinary Error, subclass, and no-message native stacks', () => {
    class CheckoutFailure extends Error {
      override name = 'CheckoutFailure';
    }
    const fixtures = [
      { value: new Error('ordinary'), type: 'Error', message: 'ordinary' },
      { value: new CheckoutFailure('subclass'), type: 'CheckoutFailure', message: 'subclass' },
      { value: new Error(), type: 'Error', message: '' },
    ];

    for (const fixture of fixtures) {
      const chain = extractCrashCauseChain(errorWithCause('outer', fixture.value), identity, () => true);
      expect(chain?.causes[0]).toMatchObject({
        exceptionType: fixture.type,
        message: fixture.message,
        framesTruncated: false,
      });
      expect(chain?.causes[0]?.frames.length).toBeGreaterThan(0);
      expect(chain?.causes[0]?.frames.some(frame => frame.raw.includes('crash-causes.spec.ts'))).toBe(true);
    }
  });

  it('never invokes custom or delegating stack getters and records frame loss', () => {
    const nativeDescriptor = Object.getOwnPropertyDescriptor(new Error('probe'), 'stack');
    expect(typeof nativeDescriptor?.get).toBe('function');
    const custom = vi.fn(() => 'Error: custom\n    at forbidden (custom.js:1:1)');
    const delegated = vi.fn(function (this: Error) {
      return Reflect.apply(nativeDescriptor!.get!, this, []);
    });

    for (const getter of [custom, delegated]) {
      const inner = new Error('inner');
      Object.defineProperty(inner, 'stack', { configurable: true, get: getter });
      const chain = extractCrashCauseChain(errorWithCause('outer', inner), identity, () => true);
      expect(chain?.causes[0]).toMatchObject({
        exceptionType: 'Error',
        message: 'inner',
        frames: [],
        framesTruncated: true,
      });
      expect(getter).not.toHaveBeenCalled();
    }
  });

  it('keeps admitted headers when native formatting throws or returns a non-string', () => {
    const conversion = vi.fn(() => 'forbidden');
    const nonString = { toString: conversion, [Symbol.toPrimitive]: conversion };
    const formatters = [
      vi.fn(() => { throw new Error('formatter failed'); }),
      vi.fn(() => nonString),
    ];

    for (const formatter of formatters) {
      const inner = new Error('inner');
      const deepest = new RangeError('deepest');
      dataStack(deepest, 'RangeError: deepest\n    at deepest (deep.js:1:1)');
      dataCause(inner, deepest);
      const chain = withPrepareStackTrace(formatter, () => (
        extractCrashCauseChain(errorWithCause('outer', inner), identity, () => true)
      ));
      expect(chain?.causes.map(cause => cause.message)).toEqual(['inner', 'deepest']);
      expect(chain?.causes[0]?.frames).toEqual([]);
      expect(chain?.causes[0]?.framesTruncated).toBe(true);
      expect(formatter).toHaveBeenCalledTimes(1);
    }
    expect(conversion).not.toHaveBeenCalled();
  });

  it('cancels immediately after native formatting changes ownership', () => {
    let owned = true;
    let formatterCalls = 0;
    const inner = new Error('inner');
    dataCause(inner, new RangeError('must not be read'));

    const chain = withPrepareStackTrace(() => {
      formatterCalls += 1;
      owned = false;
      return 'Error: inner\n    at stale (stale.js:1:1)';
    }, () => extractCrashCauseChain(errorWithCause('outer', inner), identity, () => owned));

    expect(formatterCalls).toBe(1);
    expect(chain).toBeUndefined();
  });

  it('never invokes a cause accessor and ignores an inherited cause', () => {
    let accessorCalls = 0;
    const accessorRoot = new Error('outer');
    Object.defineProperty(accessorRoot, 'cause', {
      get() {
        accessorCalls += 1;
        return new Error('forbidden');
      },
    });
    expect(extractCrashCauseChain(accessorRoot, identity, () => true)).toEqual({
      causes: [],
      truncated: true,
    });
    expect(accessorCalls).toBe(0);

    const inherited = Object.create({ cause: new Error('inherited') }) as Error;
    expect(extractCrashCauseChain(inherited, identity, () => true)).toBeUndefined();
  });

  it.each([
    [undefined, 'undefined'],
    [null, 'null'],
    [true, 'true'],
    [false, 'false'],
    [42, '42'],
    ['plain text', 'plain text'],
  ])('captures a present terminal non-Error cause %p', (cause, message) => {
    const chain = extractCrashCauseChain(errorWithCause('outer', cause), identity, () => true);
    expect(chain).toEqual({
      causes: [{
        exceptionType: 'UnhandledValue',
        message,
        frames: [],
        framesTruncated: false,
      }],
      truncated: false,
    });
  });

  it.each([
    [1n, '[bigint]'],
    [Symbol('secret'), '[symbol]'],
    [function secret() {}, '[function]'],
  ])('uses fixed lossy labels for %p without coercion', (cause, message) => {
    const chain = extractCrashCauseChain(errorWithCause('outer', cause), identity, () => true);
    expect(chain?.causes[0]?.message).toBe(message);
    expect(chain?.truncated).toBe(true);
  });

  it('uses a fixed object label without invoking host conversion hooks', () => {
    const toJSON = vi.fn(() => 'forbidden');
    const toString = vi.fn(() => 'forbidden');
    const primitive = vi.fn(() => 'forbidden');
    const cause = { toJSON, toString, [Symbol.toPrimitive]: primitive };

    expect(extractCrashCauseChain(errorWithCause('outer', cause), identity, () => true)).toEqual({
      causes: [{
        exceptionType: 'UnhandledValue',
        message: '[object]',
        frames: [],
        framesTruncated: false,
      }],
      truncated: true,
    });
    expect(toJSON).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
    expect(primitive).not.toHaveBeenCalled();
  });

  it('recognizes cross-realm Error-like values without instanceof', () => {
    const inner = runInNewContext(`(() => {
      const error = new RangeError('foreign');
      Object.defineProperty(error, 'stack', {
        configurable: true,
        value: 'RangeError: foreign\\n    at foreign (realm.js:2:7)',
      });
      return error;
    })()`);

    expect(extractCrashCauseChain(errorWithCause('outer', inner), identity, () => true))
      .toMatchObject({
        causes: [{
          exceptionType: 'RangeError',
          message: 'foreign',
          frames: [{ raw: 'at foreign (realm.js:2:7)' }],
        }],
        truncated: false,
      });
  });

  it('keeps a foreign native-accessor header with explicit frame loss', () => {
    const inner = runInNewContext('new TypeError("foreign native")');

    const chain = extractCrashCauseChain(errorWithCause('outer', inner), identity, () => true);
    expect(chain?.causes[0]).toMatchObject({
      exceptionType: 'TypeError',
      message: 'foreign native',
      frames: [],
      framesTruncated: true,
    });
  });

  it('uses safe defaults for accessor facts and bounds prototype name lookup', () => {
    let messageAccesses = 0;
    let prototypeReads = 0;
    const namedPrototype = Object.create(null) as object;
    Object.defineProperty(namedPrototype, 'name', { value: 'ForeignFailure' });
    const proxiedPrototype = new Proxy(namedPrototype, {
      getPrototypeOf(target) {
        prototypeReads += 1;
        return Reflect.getPrototypeOf(target);
      },
    });
    const cause = Object.create(proxiedPrototype) as Record<string, unknown>;
    Object.defineProperty(cause, 'message', {
      get() {
        messageAccesses += 1;
        return 'forbidden';
      },
    });
    Object.defineProperty(cause, 'stack', {
      value: 'ForeignFailure\n    at safe (foreign.js:1:1)',
    });

    const chain = extractCrashCauseChain(errorWithCause('outer', cause), identity, () => true);
    expect(messageAccesses).toBe(0);
    expect(prototypeReads).toBeLessThanOrEqual(4);
    expect(chain).toEqual({
      causes: [{
        exceptionType: 'ForeignFailure',
        message: '',
        frames: [{ raw: 'at safe (foreign.js:1:1)' }],
        framesTruncated: false,
      }],
      truncated: true,
    });
  });

  it('does not read a data name beyond four prototype links', () => {
    let prototypeCallbacks = 0;
    let nameDescriptorReads = 0;
    const tooDeep = Object.create(null) as object;
    Object.defineProperty(tooDeep, 'name', { value: 'TooDeep' });
    let prototype = tooDeep;
    for (let index = 0; index < 5; index++) {
      prototype = new Proxy(Object.create(prototype) as object, {
        getOwnPropertyDescriptor(target, property) {
          if (property === 'name') nameDescriptorReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
        getPrototypeOf(target) {
          prototypeCallbacks += 1;
          return Reflect.getPrototypeOf(target);
        },
      });
    }
    const cause = Object.create(prototype) as object;
    Object.defineProperty(cause, 'message', { value: 'bounded' });

    const chain = extractCrashCauseChain(errorWithCause('outer', cause), identity, () => true);
    expect(chain?.causes[0]?.exceptionType).toBe('Error');
    expect(prototypeCallbacks).toBeLessThanOrEqual(4);
    expect(nameDescriptorReads).toBeLessThanOrEqual(4);
  });

  it('preserves the prefix and marks self and multi-node cycles', () => {
    const self = new Error('self');
    dataCause(self, self);
    expect(extractCrashCauseChain(self, identity, () => true)).toEqual({
      causes: [],
      truncated: true,
    });

    const outer = new Error('outer');
    const inner = new TypeError('inner');
    dataCause(outer, inner);
    dataCause(inner, outer);
    const chain = extractCrashCauseChain(outer, identity, () => true);
    expect(chain?.causes.map(cause => cause.message)).toEqual(['inner']);
    expect(chain?.truncated).toBe(true);
  });

  it('continues after clipped header text while room remains for the next cause', () => {
    const deepest = new RangeError('deepest');
    const clipped = new Error('x'.repeat(9_000));
    dataCause(clipped, deepest);
    const outer = errorWithCause('outer', clipped);

    const chain = extractCrashCauseChain(outer, identity, () => true);
    expect(chain?.causes.map(cause => cause.exceptionType)).toEqual(['Error', 'RangeError']);
    expect(chain?.causes[0]?.message).toHaveLength(4_096);
    expect(chain?.truncated).toBe(true);
  });

  it('continues after redactor expansion clips a Unicode-safe header', () => {
    const deepest = new RangeError('deepest');
    const expanded = new Error('expand-me');
    dataCause(expanded, deepest);
    const chain = extractCrashCauseChain(errorWithCause('outer', expanded), value => (
      value === 'expand-me' ? `${'a'.repeat(4_095)}😀` : value
    ), () => true);

    expect(chain?.causes.map(cause => cause.exceptionType)).toEqual(['Error', 'RangeError']);
    expect(chain?.causes[0]?.message).toBe('a'.repeat(4_095));
    expect(chain?.truncated).toBe(true);
  });

  it('omits the optional chain when redaction throws or returns a non-string', () => {
    const outer = errorWithCause('outer', new TypeError('inner'));
    expect(extractCrashCauseChain(outer, () => { throw new Error('redactor failed'); }, () => true))
      .toBeUndefined();
    expect(extractCrashCauseChain(
      outer,
      (() => 7) as unknown as (value: string) => string,
      () => true,
    )).toBeUndefined();
  });

  it('treats frame truncation as loss evidence and still admits the next cause', () => {
    const deepest = new RangeError('deepest');
    const framed = new Error('framed');
    dataStack(framed, [
      'Error: framed',
      ...Array.from({ length: 33 }, (_, index) => `at frame${index} (file.js:${index + 1}:1)`),
    ].join('\n'));
    dataCause(framed, deepest);

    const chain = extractCrashCauseChain(errorWithCause('outer', framed), identity, () => true);
    expect(chain?.causes).toHaveLength(2);
    expect(chain?.causes[0]?.frames).toHaveLength(32);
    expect(chain?.causes[0]?.framesTruncated).toBe(true);
    expect(chain?.causes[1]?.message).toBe('deepest');
    expect(chain?.truncated).toBe(false);
  });

  it('repairs Unicode, bounds stack scanning, and marks frame loss', () => {
    const inner = new Error(`broken-\uD800-${'m'.repeat(9_000)}`);
    dataStack(inner, `Error: ignored\n${'s'.repeat(MAX_CRASH_CAUSE_STACK_SCAN_UNITS + 2_000)}`);
    const chain = extractCrashCauseChain(errorWithCause('outer', inner), identity, () => true);

    expect(chain?.causes[0]?.message).toContain('\uFFFD');
    expect(chain?.causes[0]?.message).toHaveLength(4_096);
    expect(chain?.causes[0]?.frames).toHaveLength(1);
    expect(chain?.causes[0]?.frames[0]?.raw).toHaveLength(1_024);
    expect(chain?.causes[0]?.framesTruncated).toBe(true);
    expect(chain?.truncated).toBe(true);
  });

  it('stops every later source read and redactor callback after byte exhaustion', () => {
    let nextCauseDescriptorReads = 0;
    const next = new Proxy(new Error('unreachable'), {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'message') nextCauseDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const exhausting = new Error('large');
    dataStack(exhausting, [
      'Error: large',
      ...Array.from({ length: 32 }, (_, index) => `${index}:${'\\'.repeat(1_020)}`),
      'late-marker',
    ].join('\n'));
    dataCause(exhausting, next);
    const seenByRedactor: string[] = [];
    const outer = errorWithCause('outer', exhausting);

    const chain = extractCrashCauseChain(outer, value => {
      seenByRedactor.push(value);
      return value;
    }, () => true);

    const serializedBytes = new TextEncoder().encode(JSON.stringify(chain)).byteLength;
    expect(serializedBytes).toBeLessThanOrEqual(MAX_CRASH_CAUSE_BYTES);
    expect(chain?.truncated).toBe(true);
    expect(chain?.causes[0]?.framesTruncated).toBe(true);
    expect(seenByRedactor.some(value => value.includes('late-marker'))).toBe(false);
    expect(nextCauseDescriptorReads).toBe(0);
    if (process.env['EVERFRAME_TASK3_RECEIPTS'] === '1') {
      console.log(`TASK3_BYTE_FIT_RECEIPT ${JSON.stringify({
        serializedBytes,
        byteLimit: MAX_CRASH_CAUSE_BYTES,
        retainedCauses: chain?.causes.length,
        retainedFrames: chain?.causes[0]?.frames.length,
        framesTruncated: chain?.causes[0]?.framesTruncated,
        chainTruncated: chain?.truncated,
        lateMarkerRedactions: seenByRedactor.filter(value => value.includes('late-marker')).length,
        nextCauseDescriptorReads,
      })}`);
    }
  });

  it('never normalizes a ninth cause and only checks whether the eighth has a next link', () => {
    const nodes = Array.from({ length: 9 }, (_, index) => new Error(`cause-${index}`));
    for (let index = 0; index < nodes.length - 1; index++) dataCause(nodes[index]!, nodes[index + 1]);
    let ninthFactReads = 0;
    const ninth = new Proxy(nodes[8]!, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'message' || property === 'stack' || property === 'name') ninthFactReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    dataCause(nodes[7]!, ninth);
    const outer = errorWithCause('outer', nodes[0]);

    const chain = extractCrashCauseChain(outer, identity, () => true);
    expect(chain?.causes).toHaveLength(8);
    expect(chain?.truncated).toBe(true);
    expect(ninthFactReads).toBe(0);
  });

  it('does not materialize a native stack when its header cannot fit', () => {
    const formatter = vi.fn(() => 'Error: rejected\n    at forbidden (forbidden.js:1:1)');
    const rejected = new Error('\\'.repeat(4_096));
    const retained = new Error('retained');
    dataStack(retained, [
      'Error: retained',
      ...Array.from({ length: 28 }, () => '\\'.repeat(1_024)),
    ].join('\n'));
    dataCause(retained, rejected);

    const chain = withPrepareStackTrace(formatter, () => (
      extractCrashCauseChain(errorWithCause('outer', retained), identity, () => true)
    ));

    expect(chain?.causes).toHaveLength(1);
    expect(chain?.truncated).toBe(true);
    expect(formatter).not.toHaveBeenCalled();
  });

  it('does not inspect or materialize a ninth native cause', () => {
    const formatter = vi.fn(() => 'Error: ninth\n    at forbidden (forbidden.js:1:1)');
    const nodes = Array.from({ length: 8 }, (_, index) => new Error(`cause-${index}`));
    for (const node of nodes) dataStack(node, `Error: ${node.message}`);
    for (let index = 0; index < nodes.length - 1; index++) dataCause(nodes[index]!, nodes[index + 1]);
    dataCause(nodes[7]!, new Error('ninth'));

    const chain = withPrepareStackTrace(formatter, () => (
      extractCrashCauseChain(errorWithCause('outer', nodes[0]), identity, () => true)
    ));

    expect(chain?.causes).toHaveLength(8);
    expect(chain?.truncated).toBe(true);
    expect(formatter).not.toHaveBeenCalled();
  });

  it('keeps an exactly eight-node complete chain untruncated', () => {
    const nodes = Array.from({ length: 8 }, (_, index) => new Error(`cause-${index}`));
    for (let index = 0; index < nodes.length - 1; index++) dataCause(nodes[index]!, nodes[index + 1]);

    const chain = extractCrashCauseChain(errorWithCause('outer', nodes[0]), identity, () => true);
    expect(chain?.causes).toHaveLength(8);
    expect(chain?.truncated).toBe(false);
  });

  it('discards the optional chain as soon as method-entry ownership is lost', () => {
    let owned = true;
    let messageReads = 0;
    const inner = new Proxy(new Error('inner'), {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'message') messageReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const outer = new Proxy(errorWithCause('outer', inner), {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'cause') owned = false;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    expect(extractCrashCauseChain(outer, identity, () => owned)).toBeUndefined();
    expect(messageReads).toBe(0);
  });

  it('preserves data stacks and explicit accessor loss when the bootstrap probe fails', async () => {
    const originalError = globalThis.Error;
    let withoutNativeProbe: typeof import('../src/crash/causes.js');
    vi.stubGlobal('Error', class ProbeFailure {
      constructor() {
        throw new originalError('probe failed');
      }
    });
    try {
      vi.resetModules();
      withoutNativeProbe = await import('../src/crash/causes.js');
    } finally {
      vi.unstubAllGlobals();
    }

    const dataInner = Object.create(null) as object;
    Object.defineProperty(dataInner, 'message', { value: 'data inner' });
    Object.defineProperty(dataInner, 'stack', {
      value: 'Error: data inner\n    at dataFrame (data.js:1:1)',
    });
    const dataRoot = Object.create(null) as object;
    dataCause(dataRoot, dataInner);
    expect(withoutNativeProbe!.extractCrashCauseChain(dataRoot, identity, () => true))
      .toMatchObject({
        causes: [{
          message: 'data inner',
          frames: [{ raw: 'at dataFrame (data.js:1:1)' }],
          framesTruncated: false,
        }],
      });

    const nativeInner = new Error('native after failed probe');
    const nativeRoot = errorWithCause('outer', nativeInner);
    expect(withoutNativeProbe!.extractCrashCauseChain(nativeRoot, identity, () => true))
      .toMatchObject({
        causes: [{
          message: 'native after failed probe',
          frames: [],
          framesTruncated: true,
        }],
      });
  });
});
