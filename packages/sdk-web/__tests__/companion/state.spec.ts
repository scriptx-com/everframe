// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 06.2-09 Task 1 — state.ts unit specs.
import { describe, expect, it, vi } from 'vitest';
import { createCompanion } from '../../src/companion/state.js';

describe('companion/state', () => {
  it('defaults to unpaired with null pairUrl', () => {
    const c = createCompanion();
    expect(c.getState()).toBe('unpaired');
    expect(c.getPairUrl()).toBeNull();
  });

  it('fires state handler with (oldVal, newVal) on transition', () => {
    const c = createCompanion();
    const handler = vi.fn();
    c.onState(handler);

    c.__setState('paired');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('unpaired', 'paired');
    expect(c.getState()).toBe('paired');
  });

  it('does NOT fire handler on no-op writes (distinctUntilChanged)', () => {
    const c = createCompanion();
    c.__setState('paired'); // initial transition before subscribing
    const handler = vi.fn();
    c.onState(handler);

    c.__setState('paired'); // no-op
    c.__setState('paired'); // no-op

    expect(handler).not.toHaveBeenCalled();
  });

  it('fires pairUrl handler on string and null transitions', () => {
    const c = createCompanion();
    const handler = vi.fn();
    c.onPairUrl(handler);

    c.__setPairUrl('https://relay.example.com/r/abc');
    c.__setPairUrl(null);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(
      1,
      'https://relay.example.com/r/abc',
    );
    expect(handler).toHaveBeenNthCalledWith(2, null);
  });

  it('unsubscribe stops further handler calls', () => {
    const c = createCompanion();
    const handler = vi.fn();
    const unsubscribe = c.onState(handler);

    c.__setState('paired');
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    c.__setState('report_in_progress');

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('swallows handler exceptions (DEFE-02)', () => {
    const c = createCompanion();
    c.onState(() => {
      throw new Error('host bug');
    });
    const goodHandler = vi.fn();
    c.onState(goodHandler);

    // Must not throw — bad handler is isolated.
    expect(() => c.__setState('paired')).not.toThrow();
    expect(goodHandler).toHaveBeenCalledWith('unpaired', 'paired');
  });

  it('resolvedName: snapshot, subscription, distinct-until-changed', () => {
    const api = createCompanion();
    const seen: Array<string | null> = [];
    api.onResolvedName((n) => seen.push(n));
    expect(api.getResolvedName()).toBeNull();
    api.__setResolvedName('Samsung TV · Tizen 7.0');
    api.__setResolvedName('Samsung TV · Tizen 7.0'); // no-op
    api.__setResolvedName(null);
    expect(seen).toEqual(['Samsung TV · Tizen 7.0', null]);
  });

  it('multiple state subscribers all receive the same transition', () => {
    const c = createCompanion();
    const h1 = vi.fn();
    const h2 = vi.fn();
    c.onState(h1);
    c.onState(h2);

    c.__setState('paired');

    expect(h1).toHaveBeenCalledWith('unpaired', 'paired');
    expect(h2).toHaveBeenCalledWith('unpaired', 'paired');
  });
});
