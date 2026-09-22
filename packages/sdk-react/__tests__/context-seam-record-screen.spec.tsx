// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { __setCurrentContext, recordScreen, setUser, setExtra } from '../src/contextSeam.js';

describe('top-level recordScreen and setUser', () => {
  beforeEach(() => __setCurrentContext(null));

  it('are no-ops before the provider mounts', () => {
    expect(() => recordScreen('Home')).not.toThrow();
    expect(() => setUser()).not.toThrow();
    expect(() => setExtra('x')).not.toThrow();
  });

  it('routes transitions through the mounted context', () => {
    const recorded: unknown[] = [];
    __setCurrentContext({
      open: () => Promise.reject(new Error('unused')),
      addBreadcrumb: () => undefined,
      captureException: () => undefined,
      setUser: () => undefined,
      setExtra: () => undefined,
      recordScreen: (name, data) => recorded.push([name, data]),
    });
    recordScreen('Home');
    recordScreen('Settings', { tab: 'audio' });
    expect(recorded).toEqual([
      ['Home', undefined],
      ['Settings', { tab: 'audio' }],
    ]);
  });

  it('maps a no-argument setUser to an explicit null — sign-out must detach', () => {
    const seen: unknown[] = [];
    __setCurrentContext({
      open: () => Promise.reject(new Error('unused')),
      addBreadcrumb: () => undefined,
      captureException: () => undefined,
      setUser: (user) => seen.push(user),
      setExtra: () => undefined,
      recordScreen: () => undefined,
    });
    setUser({ id: 'u1', displayName: 'Ada' });
    setUser();
    expect(seen).toEqual([{ id: 'u1', displayName: 'Ada' }, null]);
  });
});

describe('top-level setExtra', () => {
  beforeEach(() => __setCurrentContext(null));

  it('is a no-op before the provider mounts', () => {
    expect(() => setExtra('x')).not.toThrow();
    expect(() => setExtra({ a: 1 })).not.toThrow();
  });

  it('accepts the string form and routes it through the mounted context', () => {
    const seen: unknown[] = [];
    __setCurrentContext({
      open: () => Promise.reject(new Error('unused')),
      addBreadcrumb: () => undefined,
      captureException: () => undefined,
      setUser: () => undefined,
      setExtra: (value) => seen.push(value),
      recordScreen: () => undefined,
    });
    setExtra('plain string');
    expect(seen).toEqual(['plain string']);
  });

  it('accepts the object form and routes it through the mounted context', () => {
    const seen: unknown[] = [];
    __setCurrentContext({
      open: () => Promise.reject(new Error('unused')),
      addBreadcrumb: () => undefined,
      captureException: () => undefined,
      setUser: () => undefined,
      setExtra: (value) => seen.push(value),
      recordScreen: () => undefined,
    });
    setExtra({ a: 1, b: 2 });
    expect(seen).toEqual([{ a: 1, b: 2 }]);
  });

  // setExtra resolver form (spec 2026-09-17 setExtra-resolver) — the
  // top-level export is a pass-through seam, so it must forward the
  // function reference UNCHANGED and never call it itself. Resolution is
  // sdk-core's job (`resolveClientExtra`), invoked only at report-assembly
  // read time, far downstream of this seam.
  it('accepts the resolver form and forwards the function itself, without calling it', () => {
    const seen: unknown[] = [];
    const resolve = () => ({ screen: 'checkout' });
    __setCurrentContext({
      open: () => Promise.reject(new Error('unused')),
      addBreadcrumb: () => undefined,
      captureException: () => undefined,
      setUser: () => undefined,
      setExtra: (value) => seen.push(value),
      recordScreen: () => undefined,
    });
    setExtra(resolve);
    expect(seen).toEqual([resolve]);
  });

  it('resolver form is a no-op before the provider mounts (never invoked)', () => {
    const resolve = vi.fn(() => ({ a: 1 }));
    expect(() => setExtra(resolve)).not.toThrow();
    expect(resolve).not.toHaveBeenCalled();
  });
});
