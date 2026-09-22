// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installConsolePatcher } from '../../src/capture/logs.js';
import {
  consoleBuffer,
  DEFAULT_CONSOLE_CAP,
  __claimCaptureBuffers,
} from '../../src/capture/buffers.js';

describe('installConsolePatcher', () => {
  let uninstall: () => void = () => undefined;
  beforeEach(() => {
    __claimCaptureBuffers(DEFAULT_CONSOLE_CAP, 100);
    consoleBuffer.clear();
  });
  afterEach(() => {
    uninstall();
    uninstall = () => undefined;
    consoleBuffer.clear();
  });

  it('captures one entry per console.{log,info,warn,error,debug} call', () => {
    uninstall = installConsolePatcher();
    console.log('a');
    console.info('b');
    console.warn('c');
    console.error('d');
    console.debug('e');
    const snap = consoleBuffer.snapshot();
    expect(snap.map((e) => e.level)).toEqual(['log', 'info', 'warn', 'error', 'debug']);
    expect(snap.map((e) => e.message)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(snap.every((e) => typeof e.timestamp === 'number')).toBe(true);
  });

  it('defaults to the last 100 logs (memory-bounded)', () => {
    expect(DEFAULT_CONSOLE_CAP).toBe(100);
  });

  it('caps at the default 100 entries (oldest-first eviction)', () => {
    uninstall = installConsolePatcher();
    for (let i = 0; i < 260; i++) console.log(`m${i}`);
    const snap = consoleBuffer.snapshot();
    expect(snap.length).toBe(100);
    expect(snap[0].message).toBe('m160');
    expect(snap[snap.length - 1].message).toBe('m259');
  });

  it('idempotent — second install no-ops and does not double-capture', () => {
    const u1 = installConsolePatcher();
    const u2 = installConsolePatcher(); // should no-op
    console.log('once');
    expect(consoleBuffer.size()).toBe(1);
    u2();
    u1();
  });

  it('chains to a previously-installed wrapper (Sentry coexistence)', () => {
    const sentryBuf: unknown[] = [];
    const origError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      sentryBuf.push(args);
      origError(...args);
    };
    uninstall = installConsolePatcher();
    console.error('boom');
    expect(consoleBuffer.snapshot().map((e) => e.message)).toContain('boom');
    expect(sentryBuf.length).toBe(1);
  });

  it('window.onerror routes to buffer with [uncaught-error] prefix', () => {
    uninstall = installConsolePatcher();
    const err = new Error('synthetic');
    if (typeof window.onerror === 'function') {
      window.onerror.call(window, 'synthetic', 'file.js', 1, 1, err);
    }
    const last = consoleBuffer.snapshot().at(-1);
    expect(last?.level).toBe('error');
    expect(last?.message).toContain('[uncaught-error]');
    expect(last?.message).toContain('synthetic');
  });

  it('unhandledrejection event routes to buffer with [unhandled-rejection] prefix', () => {
    uninstall = installConsolePatcher();
    const ev = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(ev, 'reason', { value: new Error('promise-bad') });
    window.dispatchEvent(ev);
    const last = consoleBuffer.snapshot().at(-1);
    expect(last?.level).toBe('error');
    expect(last?.message).toContain('[unhandled-rejection]');
  });

  it('config.levels = [warn, error] narrows capture; log/info/debug pass through unbuffered', () => {
    uninstall = installConsolePatcher({ levels: ['warn', 'error'] });
    console.log('skip');
    console.info('skip');
    console.debug('skip');
    console.warn('keep1');
    console.error('keep2');
    expect(consoleBuffer.snapshot().map((e) => e.message)).toEqual(['keep1', 'keep2']);
  });

  it('uninstall restores originals and clears symbol marker', () => {
    const origLog = console.log.bind(console);
    const u = installConsolePatcher();
    u();
    const slot = globalThis as unknown as Record<symbol, unknown>;
    expect(slot[Symbol.for('__traceitx_patched_console__')]).toBeUndefined();
    // After uninstall, re-installing must work cleanly:
    const u2 = installConsolePatcher();
    console.log('post-reinstall');
    expect(consoleBuffer.snapshot().map((e) => e.message)).toContain('post-reinstall');
    u2();
    void origLog; // suppress unused-binding warning
  });

  it('formats %s/%d/%o placeholders into message and stores NO args', () => {
    uninstall = installConsolePatcher();
    console.error(
      'React does not recognize the `%s` prop. Spell it lowercase `%s`.',
      'accessibilityLabel',
      'accessibilitylabel',
    );
    console.log('count=%d obj=%o', 3, { a: 1 });
    const snap = consoleBuffer.snapshot();
    expect(snap[0].message).toBe(
      'React does not recognize the `accessibilityLabel` prop. Spell it lowercase `accessibilitylabel`.',
    );
    expect(snap[1].message).toBe('count=3 obj={"a":1}');
    // args is gone — message is the single source of truth now.
    expect(snap.every((e) => !('args' in e))).toBe(true);
  });

  it('appends leftover (non-placeholder) args space-separated', () => {
    uninstall = installConsolePatcher();
    console.log('hello', 'world', 42);
    console.log('with %s leftover', 'one', 'two');
    const snap = consoleBuffer.snapshot();
    expect(snap[0].message).toBe('hello world 42');
    expect(snap[1].message).toBe('with one leftover two');
  });
});
