// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { createBreadcrumbBuffer, MAX_BREADCRUMBS } from '../src/breadcrumbs/buffer.js';

const tick = () => {
  let t = 1000;
  return () => t++;
};

describe('createBreadcrumbBuffer', () => {
  it('stamps t from the injected clock and a monotonic seq', () => {
    const buf = createBreadcrumbBuffer({ now: tick() });
    buf.add({ kind: 'tap', message: 'a' });
    buf.add({ kind: 'tap', message: 'b' });
    buf.freeze();
    const frozen = buf.takeFrozen()!;
    expect(frozen).toHaveLength(2);
    expect(frozen[0]).toMatchObject({ t: 1000, seq: 0, kind: 'tap', message: 'a' });
    expect(frozen[1]).toMatchObject({ t: 1001, seq: 1, message: 'b' });
  });

  it('caps at maxCount, evicting oldest (ring), default 100', () => {
    const buf = createBreadcrumbBuffer({ now: tick(), maxCount: 3 });
    for (let i = 0; i < 5; i++) buf.add({ kind: 'console', message: `m${i}` });
    expect(buf.size).toBe(3);
    buf.freeze();
    expect(buf.takeFrozen()!.map((c) => c.message)).toEqual(['m2', 'm3', 'm4']);
    expect(MAX_BREADCRUMBS).toBe(100);
  });

  it('redacts message and data strings BEFORE buffering (mask-before-bytes)', () => {
    const jwt = 'eyJhbGciOi.eyJzdWIiOn.SflKxwRJSM'; // 3 dot-separated >=8-char segments
    const buf = createBreadcrumbBuffer({ now: tick(), getRedaction: () => ({}) });
    buf.add({ kind: 'console', message: `token ${jwt}`, data: { nested: { v: jwt } } });
    buf.freeze();
    const [crumb] = buf.takeFrozen()!;
    expect(crumb!.message).toBe('token [REDACTED:JWT]');
    expect((crumb!.data as any).nested.v).toBe('[REDACTED:JWT]');
  });

  it('never passes a raw subtree through the depth cap (redacts before truncating)', () => {
    const jwt = 'eyJhbGciOi.eyJzdWIiOn.SflKxwRJSM'; // 3 dot-separated >=8-char segments
    const buf = createBreadcrumbBuffer({ now: tick(), getRedaction: () => ({}) });
    buf.add({
      kind: 'custom',
      message: 'deep',
      data: { a: { b: { c: { d: { e: jwt } } } } },
    });
    buf.freeze();
    const [crumb] = buf.takeFrozen()!;
    expect((crumb!.data as any).a.b.c.d).toBe('[TRUNCATED:DEPTH]');
    expect(JSON.stringify(crumb)).not.toContain(jwt);
  });

  it('caps message at the 2048 protocol ceiling at add-time and marks truncated:true', () => {
    const buf = createBreadcrumbBuffer({ now: tick() });
    buf.add({ kind: 'custom', message: 'x'.repeat(5000) });
    buf.freeze();
    const [crumb] = buf.takeFrozen()!;
    expect(crumb!.message).toHaveLength(2048);
    expect(crumb!.truncated).toBe(true);
  });

  it('does not set truncated when the message is at/under the 2048 cap', () => {
    const buf = createBreadcrumbBuffer({ now: tick() });
    buf.add({ kind: 'custom', message: 'x'.repeat(2048) });
    buf.freeze();
    const [crumb] = buf.takeFrozen()!;
    expect(crumb!.message).toHaveLength(2048);
    expect(crumb!.truncated).toBeUndefined();
  });

  it('freeze snapshots the chain; later adds do not pollute the snapshot', () => {
    const buf = createBreadcrumbBuffer({ now: tick() });
    buf.add({ kind: 'tap', message: 'before' });
    buf.freeze();
    buf.add({ kind: 'tap', message: 'reporter-own-tap' });
    expect(buf.takeFrozen()!.map((c) => c.message)).toEqual(['before']);
    expect(buf.size).toBe(2); // live capture was never interrupted
  });

  it('freeze while frozen is a no-op (keeps the FIRST snapshot)', () => {
    const buf = createBreadcrumbBuffer({ now: tick() });
    buf.add({ kind: 'tap', message: 'one' });
    buf.freeze();
    buf.add({ kind: 'tap', message: 'two' });
    buf.freeze();
    expect(buf.takeFrozen()).toHaveLength(1);
  });

  it('discardAndResume drops the snapshot; takeFrozen then returns null', () => {
    const buf = createBreadcrumbBuffer({ now: tick() });
    buf.add({ kind: 'tap', message: 'a' });
    buf.freeze();
    buf.discardAndResume();
    expect(buf.takeFrozen()).toBeNull();
  });

  it('takeFrozen returns null when freeze was never called, and clears after use', () => {
    const buf = createBreadcrumbBuffer({ now: tick() });
    buf.add({ kind: 'tap', message: 'a' });
    expect(buf.takeFrozen()).toBeNull();
    buf.freeze();
    expect(buf.takeFrozen()).toHaveLength(1);
    expect(buf.takeFrozen()).toBeNull();
  });

  it('clear zeroizes entries and snapshot (logout / identity change)', () => {
    const buf = createBreadcrumbBuffer({ now: tick() });
    buf.add({ kind: 'tap', message: 'a' });
    buf.freeze();
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.takeFrozen()).toBeNull();
  });

  it('setMaxCount shrinks the cap and evicts oldest immediately', () => {
    const buf = createBreadcrumbBuffer({ now: tick(), maxCount: 5 });
    for (let i = 0; i < 5; i++) buf.add({ kind: 'tap', message: `m${i}` });
    buf.setMaxCount(2);
    expect(buf.size).toBe(2);
    buf.freeze();
    expect(buf.takeFrozen()!.map((c) => c.message)).toEqual(['m3', 'm4']);
  });

  it('setMaxCount grows the cap for future adds', () => {
    const buf = createBreadcrumbBuffer({ now: tick(), maxCount: 2 });
    buf.setMaxCount(4);
    for (let i = 0; i < 4; i++) buf.add({ kind: 'tap', message: `m${i}` });
    expect(buf.size).toBe(4);
  });

  it('setMaxCount ignores invalid values (zero, negative, NaN, fraction)', () => {
    const buf = createBreadcrumbBuffer({ now: tick(), maxCount: 3 });
    for (let i = 0; i < 3; i++) buf.add({ kind: 'tap', message: `m${i}` });
    buf.setMaxCount(0);
    buf.setMaxCount(-1);
    buf.setMaxCount(Number.NaN);
    buf.setMaxCount(2.5);
    expect(buf.size).toBe(3); // cap unchanged by all four calls
  });
});

describe('snapshot() — crash-time read (spec 2026-07-18)', () => {
  it('returns a copy of the live chain without touching freeze state', () => {
    const buf = createBreadcrumbBuffer({ now: () => 1000 });
    buf.add({ kind: 'console', message: 'one' });
    buf.add({ kind: 'error', message: 'two' });
    const snap = buf.snapshot();
    expect(snap.map((b) => b.message)).toEqual(['one', 'two']);
    // Non-destructive: live buffer unchanged, freeze lifecycle unaffected.
    expect(buf.size).toBe(2);
    buf.freeze();
    expect(buf.takeFrozen()?.length).toBe(2);
    // Returned array is a copy — mutating it can't corrupt the ring.
    snap.pop();
    expect(buf.size).toBe(2);
  });

  it('snapshot during an active freeze returns the LIVE chain, not the frozen one', () => {
    const buf = createBreadcrumbBuffer({ now: () => 1000 });
    buf.add({ kind: 'console', message: 'pre' });
    buf.freeze();
    buf.add({ kind: 'error', message: 'post-freeze' });
    expect(buf.snapshot().map((b) => b.message)).toContain('post-freeze');
  });
});
