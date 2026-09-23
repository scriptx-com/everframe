// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { safeWrap } from '../src/safe-wrap.js';

describe('DEFE-02: safeWrap', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through return value of sync function', () => {
    const wrapped = safeWrap(() => 42, { name: 'fortyTwo' });
    expect(wrapped()).toBe(42);
  });

  it('returns undefined when sync function throws and calls onError', () => {
    const onError = vi.fn();
    const wrapped = safeWrap(
      () => {
        throw new Error('boom');
      },
      { name: 'boom', onError }
    );
    expect(wrapped()).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('passes through resolved value of async function', async () => {
    const wrapped = safeWrap(async () => 'ok', { name: 'asyncOk' });
    await expect(wrapped()).resolves.toBe('ok');
  });

  it('returns undefined when async function rejects and calls onError', async () => {
    const onError = vi.fn();
    const wrapped = safeWrap(
      async () => {
        throw new Error('async-boom');
      },
      { name: 'asyncBoom', onError }
    );
    await expect(wrapped()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('preserves function name', () => {
    function namedFn() {
      return 1;
    }
    const wrapped = safeWrap(namedFn, { name: 'context-name' });
    expect(wrapped.name).toBe('namedFn');
  });

  it('uses context.name when fn has no name', () => {
    const wrapped = safeWrap(() => 1, { name: 'context-name' });
    expect(wrapped.name).toBe('context-name');
  });

  it('forwards non-Error throws (string) to onError', () => {
    const onError = vi.fn();
    const wrapped = safeWrap(
      () => {
        throw 'oops-string';
      },
      { name: 'stringy', onError }
    );
    wrapped();
    expect(onError).toHaveBeenCalledWith('oops-string');
  });

  it('logs to console.error with [everframe] prefix', () => {
    const wrapped = safeWrap(
      () => {
        throw new Error('x');
      },
      { name: 'log-prefix' }
    );
    wrapped();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[everframe]'),
      expect.any(Error)
    );
  });

  // Adversarial review of PR #218 round 6, finding 2 — logging-only, opt-in:
  // callers whose thrown value can carry a secret (the vitals collector's
  // identity callbacks) project it before it reaches the console. `onError`
  // still gets the untouched error, and callers that pass nothing are
  // unaffected by any of this.
  describe('projectError', () => {
    it('logs the projection instead of the raw error, but still reports the raw one', async () => {
      const onError = vi.fn();
      const boom = new TypeError('secret: Bearer a.b.c');
      for (const wrapped of [
        safeWrap(
          () => {
            throw boom;
          },
          { name: 'sync', onError, projectError: (e) => (e as Error).name }
        ),
        safeWrap(
          async () => {
            throw boom;
          },
          { name: 'async', onError, projectError: (e) => (e as Error).name }
        ),
      ]) {
        await wrapped();
      }
      expect(onError).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenCalledWith(boom);
      const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(logged).toHaveLength(2);
      for (const args of logged) {
        expect(args[1]).toBe('TypeError');
        expect(JSON.stringify(args)).not.toContain('Bearer');
      }
    });
  });
});
