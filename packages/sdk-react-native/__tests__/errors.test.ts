// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Default-on ErrorUtils crash handler (spec 2026-07-18). Verifies: crash
// facts are forwarded over the sync `reportCrash` bridge method, the
// previous handler is ALWAYS chained (even when reportCrash throws — a dead
// bridge must never break RN's own crash handling), non-fatal errors are
// session-throttled per fingerprint while fatal errors always bypass the
// throttle (the process dies anyway), and teardown restores the previous
// handler.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installErrorHandler } from '../src/errors.js';
import NativeEverframe from '../src/NativeEverframe.js';
import { createRuntime } from '../src/runtime.js';
import { __getCurrentContext, __setCurrentContext } from '../src/contextSeam.js';

type Handler = (error: unknown, isFatal?: boolean) => void;

describe('RN crash error handler (spec 2026-07-18)', () => {
  let installed: Handler | undefined;
  let previous: Handler;
  let teardown: (() => void) | undefined;

  beforeEach(() => {
    previous = vi.fn<Handler>();
    installed = previous;
    (globalThis as Record<string, unknown>).ErrorUtils = {
      getGlobalHandler: () => installed!,
      setGlobalHandler: (h: Handler) => {
        installed = h;
      },
    };
    (NativeEverframe.reportCrash as ReturnType<typeof vi.fn>).mockClear?.();
    (NativeEverframe.reportCrash as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });
  afterEach(() => {
    teardown?.();
    delete (globalThis as Record<string, unknown>).ErrorUtils;
  });

  it('forwards crash facts over reportCrash and ALWAYS chains the previous handler', () => {
    teardown = installErrorHandler({});
    const err = new TypeError('boom');
    err.stack = 'TypeError: boom\n    at f (bundle.js:10:5)';
    installed!(err, true);

    expect(NativeEverframe.reportCrash).toHaveBeenCalledTimes(1);
    const facts = JSON.parse((NativeEverframe.reportCrash as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(facts).toMatchObject({
      exceptionType: 'TypeError',
      message: 'boom',
      framesRaw: ['at f (bundle.js:10:5)'],
      mechanism: 'errorutils',
      fatal: true,
    });
    expect(typeof facts.occurredAt).toBe('string');
    expect(facts.jsBundle).toBeUndefined();
    expect(previous).toHaveBeenCalledWith(err, true);
  });

  it('chains previous handler even when reportCrash throws', () => {
    (NativeEverframe.reportCrash as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('bridge dead');
    });
    teardown = installErrorHandler({});
    const err = new Error('x');
    installed!(err, true);
    expect(previous).toHaveBeenCalledWith(err, true);
  });

  it('throttles repeat non-fatal errors but never throttles fatal', () => {
    teardown = installErrorHandler({});
    const err = new Error('dup');
    err.stack = 'Error: dup\n    at g (b.js:2:2)';
    installed!(err, false);
    installed!(err, false);
    expect(NativeEverframe.reportCrash).toHaveBeenCalledTimes(1);
    installed!(err, true); // fatal bypasses the throttle
    expect(NativeEverframe.reportCrash).toHaveBeenCalledTimes(2);
  });

  it('teardown restores the previous handler', () => {
    teardown = installErrorHandler({});
    teardown();
    teardown = undefined;
    expect(installed).toBe(previous);
  });

  it('is a safe no-op when no ErrorUtils global is present', () => {
    delete (globalThis as Record<string, unknown>).ErrorUtils;
    expect(() => {
      teardown = installErrorHandler({});
    }).not.toThrow();
    teardown?.();
    teardown = undefined;
  });
});

// Fail-soft guards around the runtime's mount/unmount wiring (review fix):
// the crash-handler install/teardown must match the try/catch + console.warn
// discipline of every other native/integration call in runtime.ts.
describe('runtime crash-handler wiring is fail-soft', () => {
  afterEach(() => {
    __setCurrentContext(null);
    delete (globalThis as Record<string, unknown>).ErrorUtils;
    vi.restoreAllMocks();
  });

  it('a throwing ErrorUtils.setGlobalHandler warns and does not break mount (integrations still run)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (globalThis as Record<string, unknown>).ErrorUtils = {
      getGlobalHandler: () => () => undefined,
      setGlobalHandler: () => {
        throw new Error('hostile shim');
      },
    };
    const good = vi.fn();
    const rt = createRuntime({ apiKey: 'k', integrations: [{ name: 'good', setup: good }] });
    expect(() => rt.mount()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('crash handler install threw'));
    rt.unmount();
  });

  it('a throwing crash-handler teardown warns and does not break unmount (context still cleared)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let current: Handler = () => undefined;
    const eu = {
      getGlobalHandler: () => current,
      setGlobalHandler: (handler: Handler) => { current = handler; },
    };
    (globalThis as Record<string, unknown>).ErrorUtils = eu;
    const rt = createRuntime({ apiKey: 'k' });
    rt.mount();
    // Restore path (teardown calls setGlobalHandler(previous)) now throws.
    eu.setGlobalHandler = () => {
      throw new Error('hostile shim');
    };
    expect(() => rt.unmount()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('crash handler teardown threw'));
    expect(__getCurrentContext()).toBeNull();
  });
});

// Controller coverage uses the actual runtime and native boundary only.
describe('shared capture acceptance and bounded facts', () => {
  const handled = vi.mocked(NativeEverframe.captureHandledException);
  const automatic = vi.mocked(NativeEverframe.reportCrash);
  let current: Handler;
  let previous: ReturnType<typeof vi.fn<Handler>>;
  let runtime: ReturnType<typeof createRuntime>;
  const makeError = (frame: string) => Object.assign(new Error('message'), {
    stack: `Error: message\n at ${frame} (bundle.js:1:2)`,
  });
  beforeEach(() => {
    handled.mockReset().mockReturnValue(true);
    automatic.mockReset().mockReturnValue(true);
    previous = vi.fn<Handler>();
    current = previous;
    vi.stubGlobal('ErrorUtils', {
      getGlobalHandler: () => current,
      setGlobalHandler: (handler: Handler) => { current = handler; },
    });
    runtime = createRuntime({ apiKey: 'k' });
    runtime.mount();
  });
  afterEach(() => {
    runtime.unmount();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    __setCurrentContext(null);
  });

  it.each(['handled', 'automatic'])('first accepted object wins when %s captures first; fatal always bypasses', (first) => {
    const thrown = makeError('same');
    if (first === 'handled') {
      runtime.captureException(thrown);
      current(thrown, false);
      expect(handled).toHaveBeenCalledTimes(1);
      expect(automatic).not.toHaveBeenCalled();
    } else {
      current(thrown, false);
      runtime.captureException(thrown);
      expect(automatic).toHaveBeenCalledTimes(1);
      expect(handled).not.toHaveBeenCalled();
    }
    current(thrown, true);
    current(thrown, true);
    expect(automatic).toHaveBeenCalledTimes(first === 'handled' ? 2 : 3);
    expect(JSON.parse(automatic.mock.calls.at(-1)![0])).toMatchObject({
      source: 'crash', mechanism: 'errorutils', handled: false, fatal: true,
    });
    expect(previous).toHaveBeenLastCalledWith(thrown, true);
  });

  it.each(['handled', 'automatic'])('%s false and thrown calls leave the same object retryable until true', (path) => {
    const bridge = path === 'handled' ? handled : automatic;
    bridge.mockReturnValueOnce(false).mockImplementationOnce(() => { throw new Error('bridge'); }).mockReturnValue(true);
    const thrown = makeError('retry');
    const capture = () => path === 'handled' ? runtime.captureException(thrown) : current(thrown, false);
    capture(); capture(); capture(); capture();
    expect(bridge).toHaveBeenCalledTimes(3);
    if (path === 'handled') current(thrown, false);
    else runtime.captureException(thrown);
    expect(path === 'handled' ? automatic : handled).not.toHaveBeenCalled();
  });

  it.each(['handled', 'automatic'])('rejected %s object can be accepted by the other path', (first) => {
    const thrown = makeError('opposite');
    if (first === 'handled') {
      handled.mockReturnValueOnce(false);
      runtime.captureException(thrown);
      current(thrown, false);
      runtime.captureException(thrown);
    } else {
      automatic.mockReturnValueOnce(false);
      current(thrown, false);
      runtime.captureException(thrown);
      current(thrown, false);
    }
    expect(handled).toHaveBeenCalledTimes(1);
    expect(automatic).toHaveBeenCalledTimes(1);
  });

  it.each(['handled', 'automatic'])('keeps independent ten-report allowances when %s exhausts first', (first) => {
    const capture = (path: string, value: Error) => path === 'handled' ? runtime.captureException(value) : current(value, false);
    for (const path of [first, first === 'handled' ? 'automatic' : 'handled']) {
      for (const name of 'abcdefghijk') capture(path, makeError(name));
    }
    expect(handled).toHaveBeenCalledTimes(10);
    expect(automatic).toHaveBeenCalledTimes(10);
    current(makeError('fatal'), true);
    expect(automatic).toHaveBeenCalledTimes(11);
  });

  it('normalizes digits per path, while allowing separate objects on the other path', () => {
    runtime.captureException(makeError('row12'));
    runtime.captureException(makeError('row34'));
    current(makeError('row56'), false);
    current(makeError('row78'), false);
    expect(handled).toHaveBeenCalledTimes(1);
    expect(automatic).toHaveBeenCalledTimes(1);
    expect(JSON.parse(automatic.mock.calls[0]![0])).toMatchObject({ source: 'error', handled: false, fatal: false });
  });

  it('legacy automatic true results preserve distinct keys on a reused object', () => {
    const descriptor = Object.getOwnPropertyDescriptor(NativeEverframe, 'captureHandledException')!;
    Object.defineProperty(NativeEverframe, 'captureHandledException', { configurable: true, value: undefined });
    try {
      automatic.mockReturnValue(true);
      const thrown = makeError('original');
      thrown.message = 'first occurrence';
      current(thrown, false);
      current(thrown, false);
      thrown.message = 'later occurrence';
      thrown.stack = 'Error: later occurrence\n at anotherFunction (bundle.js:1:2)';
      current(thrown, false);
      current(thrown, false);
      expect(automatic).toHaveBeenCalledTimes(2);
      expect(automatic.mock.calls.map(([payload]) => JSON.parse(payload))).toMatchObject([
        { message: 'first occurrence', framesRaw: ['at original (bundle.js:1:2)'] },
        { message: 'later occurrence', framesRaw: ['at anotherFunction (bundle.js:1:2)'] },
      ]);
      current(makeError('anotherFunction'), false);
      expect(automatic).toHaveBeenCalledTimes(2);
      expect(handled).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(NativeEverframe, 'captureHandledException', descriptor);
    }
  });

  it('legacy automatic attempts consume allowance even on false or throwing reports', () => {
    const descriptor = Object.getOwnPropertyDescriptor(NativeEverframe, 'captureHandledException')!;
    Object.defineProperty(NativeEverframe, 'captureHandledException', { configurable: true, value: undefined });
    try {
      automatic.mockReturnValueOnce(false).mockImplementationOnce(() => { throw new Error('bridge'); });
      const first = makeError('first');
      current(first, false); current(first, false);
      const second = makeError('second');
      current(second, false); current(second, false);
      expect(automatic).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(NativeEverframe, 'captureHandledException', descriptor);
    }
  });

  it('one latch prevents bridge-driven recursion across automatic and explicit capture', () => {
    handled.mockImplementation(() => {
      current(makeError('recursive-auto'), false);
      runtime.captureException(makeError('recursive-explicit'));
      return true;
    });
    runtime.captureException(makeError('outer'));
    expect(handled).toHaveBeenCalledTimes(1);
    expect(automatic).not.toHaveBeenCalled();
    expect(previous).toHaveBeenCalledTimes(1);
  });

  it('projects deliberate details with shared redaction, caps and binary64 values while automatic capture stays unchanged', () => {
    let sensitiveReads = 0;
    const metadata: Record<string, unknown> = {
      message: `card 4111-1111-1111-1111 ssn 123-45-6789 ${'x'.repeat(2000)}`,
      numbers: [9007199254740992, 9007199254740994, -9007199254740994, 1e100, 1.25, -0],
      enabled: true,
    };
    const sensitiveValue = {};
    Object.defineProperty(sensitiveValue, 'value', {
      enumerable: true,
      get() { sensitiveReads++; return 'must-not-be-read'; },
    });
    metadata.accessToken = sensitiveValue;

    runtime.captureException(makeError('details-wire'), {
      severity: 'info',
      context: `context 123-45-6789 ${'c'.repeat(300)}`,
      metadata,
    });
    current(makeError('automatic-details-absence'), false);

    const payload = JSON.parse(handled.mock.calls[0]![0]);
    expect(payload.details.severity).toBe('info');
    expect(payload.details.context).toHaveLength(256);
    expect(payload.details.context).toContain('[REDACTED:SSN]');
    expect(payload.details.metadata.message).toContain('[REDACTED:CC]');
    expect(payload.details.metadata.message).toContain('[REDACTED:SSN]');
    expect(payload.details.metadata.message).toHaveLength(1024);
    expect(payload.details.metadata.accessToken).toBe('[REDACTED]');
    expect(payload.details.metadata.numbers).toEqual([
      9007199254740992, 9007199254740994, -9007199254740994, 1e100, 1.25, 0,
    ]);
    expect(payload.details.metadata.enabled).toBe(true);
    expect(payload.details.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(payload.details)).byteLength).toBeLessThanOrEqual(8192);
    expect(sensitiveReads).toBe(0);
    expect(JSON.parse(automatic.mock.calls[0]![0]).details).toBeUndefined();
  });

  it('does not inspect details before native capability, duplicate and allowance admission', () => {
    let inspections = 0;
    const options = new Proxy({ metadata: { value: 'unused' } }, {
      getPrototypeOf: Reflect.getPrototypeOf,
      getOwnPropertyDescriptor(target, property) {
        inspections++;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const handledDescriptor = Object.getOwnPropertyDescriptor(NativeEverframe, 'captureHandledException')!;
    try {
      Object.defineProperty(NativeEverframe, 'captureHandledException', { configurable: true, value: undefined });
      runtime.captureException(makeError('missing-capability'), options);
      expect(inspections).toBe(0);
    } finally {
      Object.defineProperty(NativeEverframe, 'captureHandledException', handledDescriptor);
    }

    runtime.captureException(makeError('duplicate1'));
    runtime.captureException(makeError('duplicate2'), options);
    for (const frame of 'abcdefghij') runtime.captureException(makeError(`allowance-${frame}`));
    runtime.captureException(makeError('over-allowance'), options);
    expect(inspections).toBe(0);
  });

  it('reprojects refused details until acceptance and then owns the accepted payload', () => {
    handled.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const thrown = makeError('accepted-details');
    const nested = { state: 'first' };
    const options = { metadata: { nested } };

    runtime.captureException(thrown, options);
    nested.state = 'second';
    runtime.captureException(thrown, options);
    nested.state = 'after';
    runtime.captureException(thrown, options);

    expect(handled).toHaveBeenCalledTimes(2);
    expect(JSON.parse(handled.mock.calls[0]![0]).details.metadata.nested.state).toBe('first');
    expect(JSON.parse(handled.mock.calls[1]![0]).details.metadata.nested.state).toBe('second');
  });

  it('drops a details projection whose proxy reenters and remounts its owner', () => {
    let reentered = false;
    const options = new Proxy({ metadata: { state: 'old' } }, {
      getPrototypeOf: Reflect.getPrototypeOf,
      getOwnPropertyDescriptor(target, property) {
        if (!reentered) {
          reentered = true;
          runtime.captureException(makeError('nested-old-owner'));
          runtime.unmount();
          runtime.mount();
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    runtime.captureException(makeError('same-fingerprint1'), options);
    expect(handled).not.toHaveBeenCalled();
    runtime.captureException(makeError('same-fingerprint2'));
    expect(handled).toHaveBeenCalledTimes(1);
    expect(JSON.parse(handled.mock.calls[0]![0]).details).toEqual({ severity: 'error' });
  });

  it('invokes handled host functions without reading a reentrant call property', () => {
    const callDescriptor = Object.getOwnPropertyDescriptor(handled, 'call');
    let callGetterReads = 0;
    let receiver: unknown;
    handled.mockImplementation(function (this: unknown) {
      receiver = this;
      return true;
    });
    let armed = false;
    const options = new Proxy({ metadata: { state: 'owned' } }, {
      getOwnPropertyDescriptor(target, property) {
        if (!armed) {
          armed = true;
          Object.defineProperty(handled, 'call', { configurable: true, get() {
            callGetterReads++;
            runtime.unmount();
            runtime.mount();
            return Function.prototype.call;
          } });
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    try {
      runtime.captureException(makeError('host-call-property'), options);
      expect(callGetterReads).toBe(0);
      expect(handled).toHaveBeenCalledTimes(1);
      expect(receiver).toBe(NativeEverframe);
      expect(JSON.parse(handled.mock.calls[0]![0]).details).toEqual({
        severity: 'error', metadata: { state: 'owned' },
      });
    } finally {
      if (callDescriptor) Object.defineProperty(handled, 'call', callDescriptor);
      else delete (handled as { call?: unknown }).call;
    }
  });

  it.each([
    [undefined, 'undefined'], [null, 'null'], [42, '42'], [true, 'true'],
    ['text', 'text'], [Symbol('symbol'), 'Symbol(symbol)'], [12n, '12'],
    [{ reason: 'bad' }, '{"reason":"bad"}'],
  ])('normalizes arbitrary value %s', (value, message) => {
    runtime.captureException(value);
    expect(JSON.parse(handled.mock.calls[0]![0])).toMatchObject({ exceptionType: 'UnhandledValue', message, framesRaw: [] });
  });

  it('survives hostile getters and preserves independently readable Error facts', () => {
    const thrown = new Error('useful');
    Object.defineProperty(thrown, 'name', { get() { throw new Error('name'); } });
    Object.defineProperty(thrown, 'stack', { value: ' at useful (bundle.js:1:2)' });
    runtime.captureException(thrown);
    expect(JSON.parse(handled.mock.calls[0]![0])).toMatchObject({ exceptionType: 'Error', message: 'useful', framesRaw: ['at useful (bundle.js:1:2)'] });
  });

  it.each(['proxy', 'cycle', 'unrenderable'])('captures %s values without arbitrary JSON hooks', (kind) => {
    let value: unknown;
    if (kind === 'proxy') value = new Proxy({}, { get() { throw new Error('get'); }, getPrototypeOf() { throw new Error('prototype'); }, ownKeys() { throw new Error('keys'); } });
    else if (kind === 'cycle') { const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; value = cyclic; }
    else value = { toJSON() { throw new Error('JSON'); }, toString() { throw new Error('string'); }, [Symbol.toPrimitive]() { throw new Error('primitive'); } };
    expect(() => runtime.captureException(value)).not.toThrow();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(JSON.parse(handled.mock.calls[0]![0]).message.length).toBeLessThanOrEqual(4096);
  });

  it('caps facts and scans only a bounded stack prefix without splitting the host string', () => {
    const thrown = new Error('m'.repeat(10000));
    thrown.name = 'T'.repeat(300);
    thrown.stack = `${thrown.name}: message\n${Array.from({ length: 1000 }, () => ` at ${'f'.repeat(2000)}`).join('\n')}`;
    const split = vi.spyOn(String.prototype, 'split');
    runtime.captureException(thrown);
    const facts = JSON.parse(handled.mock.calls[0]![0]);
    expect(facts.exceptionType).toHaveLength(256);
    expect(facts.message).toHaveLength(4096);
    expect(facts.framesRaw.length).toBeGreaterThan(0);
    expect(facts.framesRaw.length).toBeLessThanOrEqual(256);
    expect(facts.framesRaw[0]).toMatch(/^at f/);
    expect(facts.framesRaw.every((line: string) => line.length <= 1024)).toBe(true);
    expect(split.mock.calls.length).toBe(0);
  });

  it('bounds object field reads, nesting and serialized output before crossing the bridge', () => {
    let reads = 0;
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 10000; i++) Object.defineProperty(wide, `field${i}`, { enumerable: true, get() { reads++; return 'x'; } });
    let deep: Record<string, unknown> = { wide };
    for (let i = 0; i < 10000; i++) deep = { deep };
    runtime.captureException(wide);
    expect(reads).toBeLessThanOrEqual(64);
    expect(JSON.parse(handled.mock.calls[0]![0]).message.length).toBeLessThanOrEqual(4096);
    // Same primitive fingerprint gets one report; fresh controller for nesting.
    runtime.unmount(); runtime.mount();
    runtime.captureException(deep);
    expect(handled).toHaveBeenCalledTimes(2);
    expect(JSON.parse(handled.mock.calls[1]![0]).message.length).toBeLessThanOrEqual(4096);
  });
  it('delegates the exact original argument list and lets predecessor exceptions propagate', () => {
    const thrown = makeError('one-argument');
    current(thrown);
    expect(previous.mock.calls[0]).toEqual([thrown]);
    const predecessorFailure = new Error('predecessor');
    previous.mockImplementationOnce(() => { throw predecessorFailure; });
    expect(() => current(thrown, true)).toThrow(predecessorFailure);
  });

  it('rechecks ownership after a native automatic method getter unmounts the runtime', () => {
    const descriptor = Object.getOwnPropertyDescriptor(NativeEverframe, 'reportCrash')!;
    try {
      Object.defineProperty(NativeEverframe, 'reportCrash', { configurable: true, get() {
        runtime.unmount();
        return automatic;
      } });
      current(makeError('unmount-on-lookup'), false);
      expect(automatic).not.toHaveBeenCalled();
      expect(previous).toHaveBeenCalledTimes(1);
    } finally { Object.defineProperty(NativeEverframe, 'reportCrash', descriptor); }
  });

  it('rechecks ownership after a native handled method getter unmounts before details projection', () => {
    const descriptor = Object.getOwnPropertyDescriptor(NativeEverframe, 'captureHandledException')!;
    try {
      Object.defineProperty(NativeEverframe, 'captureHandledException', { configurable: true, get() {
        runtime.unmount();
        return handled;
      } });
      runtime.captureException(makeError('handled-unmount-on-lookup'), { context: 'stale' });
      expect(handled).not.toHaveBeenCalled();
    } finally { Object.defineProperty(NativeEverframe, 'captureHandledException', descriptor); }
  });

  it('does not call the bridge if a thrown value getter unmounts the owner', () => {
    const thrown = makeError('unmount-on-read');
    Object.defineProperty(thrown, 'message', { get() { runtime.unmount(); return 'message'; } });
    runtime.captureException(thrown);
    expect(handled).not.toHaveBeenCalled();
  });

  it('caps a long raw frame and the frame count independently', () => {
    const thrown = makeError('frames');
    thrown.stack = 'Error: message\n' + ' at '.concat('x'.repeat(2000)) + '\n' + ' at short\n'.repeat(1000);
    runtime.captureException(thrown);
    const facts = JSON.parse(handled.mock.calls[0]![0]);
    expect(facts.framesRaw).toHaveLength(256);
    expect(facts.framesRaw[0].length).toBeLessThanOrEqual(1024);
    expect(facts.framesRaw[255]).toBe('at short');
  });

  it('preserves legacy attempt accounting when reportCrash property lookup throws', () => {
    const handledDescriptor = Object.getOwnPropertyDescriptor(NativeEverframe, 'captureHandledException')!;
    const automaticDescriptor = Object.getOwnPropertyDescriptor(NativeEverframe, 'reportCrash')!;
    const thrown = makeError('legacy-lookup');
    try {
      Object.defineProperty(NativeEverframe, 'captureHandledException', { configurable: true, value: undefined });
      Object.defineProperty(NativeEverframe, 'reportCrash', { configurable: true, get() { throw new Error('lookup'); } });
      current(thrown, false);
      Object.defineProperty(NativeEverframe, 'reportCrash', automaticDescriptor);
      current(thrown, false);
      expect(automatic).not.toHaveBeenCalled();
      expect(previous).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(NativeEverframe, 'captureHandledException', handledDescriptor);
      Object.defineProperty(NativeEverframe, 'reportCrash', automaticDescriptor);
    }
  });

  it.each([10n ** 10000n, Symbol('s'.repeat(10000))])('bounds oversized primitive rendering before String conversion', (value) => {
    const conversion = vi.spyOn(globalThis, 'String');
    runtime.captureException(value);
    expect(conversion.mock.calls.some(([argument]) => argument === value)).toBe(false);
    const facts = JSON.parse(handled.mock.calls[0]![0]);
    expect(facts.message.length).toBeGreaterThan(0);
    expect(facts.message.length).toBeLessThanOrEqual(4096);
  });

});
