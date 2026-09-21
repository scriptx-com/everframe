// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import NativeTraceItX from '../src/NativeTraceItX.js';
import { attachTheoPlayerVitals, useTheoPlayerVitals, type TheoPlayerLike } from '../src/integrations/theoplayer.js';
import { __resetPlayerTokenCounterForTests } from '../src/vitals.js';

// `fileURLToPath(import.meta.url)` per this package's existing convention
// (see rbridge-no-surface.test.ts, companion-bridge-wiring.spec.ts,
// install-id-inheritance.spec.ts, integrations-react-native-video.spec.tsx)
// — `new URL(x, import.meta.url)` throws under the jsdom environment this
// spec needs for @testing-library/react.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const native = NativeTraceItX as unknown as Record<string, ReturnType<typeof vi.fn>>;
const fixture = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/vitals/theoplayer/session.json'), 'utf8'));
const BASE = 1_757_000_000_000;

function fakeTheo(init: Partial<TheoPlayerLike> = {}) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const p: TheoPlayerLike & { fire(type: string, e: unknown): void; count(): number; buffered: Array<{ start: number; end: number }>; currentTime: number; source: TheoPlayerLike['source'] } = {
    buffered: [], currentTime: 0, source: undefined, version: { version: '9.3.0' }, ...init,
    addEventListener(type, l) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(l); },
    removeEventListener(type, l) { listeners.get(type)?.delete(l); },
    fire(type, e) { listeners.get(type)?.forEach((l) => l(e)); },
    count() { let n = 0; listeners.forEach((s) => (n += s.size)); return n; },
  };
  return p;
}

describe('THEOplayer adapter', () => {
  beforeEach(() => { for (const f of Object.values(native)) f.mockClear?.(); __resetPlayerTokenCounterForTests(); vi.restoreAllMocks(); });

  it('replays the recorded session into the expected vocabulary', () => {
    let now = BASE; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const p = fakeTheo(); const detach = attachTheoPlayerVitals(p, { name: 'tv' });
    expect(native.trackPlayer).toHaveBeenCalledWith('rp1', 'theoplayer', 'tv', '9.3.0');
    for (const ev of fixture.events) {
      now = BASE + ev.at;
      if (ev.buffered) p.buffered = ev.buffered;
      if (ev.type === 'sourcechange') p.source = ev.event.source;
      if (typeof ev.event?.currentTime === 'number') p.currentTime = ev.event.currentTime;
      p.fire(ev.type, ev.event);
    }
    const got = native.recordPlayerEvent.mock.calls.map(([, type, t, data]) => ({ type, ...(data ? { data } : {}), t: t - BASE }));
    expect(got).toEqual(fixture.expect);
    expect(native.updatePlayerStats.mock.calls.map(([, s]) => s)).toEqual(fixture.expectStats);
    detach(); expect(native.detachPlayer).toHaveBeenCalledWith('rp1'); expect(p.count()).toBe(0);
  });

  it('seeds from a loaded, playing player (paused === false)', () => {
    const p = fakeTheo({ paused: false, source: { sources: [{ src: 'https://c/v.mpd', type: 'application/dash+xml', contentProtection: { widevine: {} } }] } });
    attachTheoPlayerVitals(p);
    expect(native.recordPlayerEvent.mock.calls.map((c) => c[1])).toEqual(['source_change', 'drm', 'play']);
    expect(native.recordPlayerEvent.mock.calls[1][3]).toEqual({ keySystem: 'widevine' });
  });

  it('a reload of the SAME url is reported again (the loadstart latch is consumable)', () => {
    const p = fakeTheo();
    p.source = { sources: [{ src: 'https://c/a.m3u8' }] };
    attachTheoPlayerVitals(p);
    native.recordPlayerEvent.mockClear();          // drop the attach-time seed
    for (let i = 0; i < 2; i++) {
      p.fire('sourcechange', { source: p.source });
      p.fire('loadstart', {});
      p.fire('playing', {});
    }
    const types = native.recordPlayerEvent.mock.calls.map((c) => c[1]);
    expect(types.filter((t: string) => t === 'source_change')).toHaveLength(2);
    expect(types.filter((t: string) => t === 'startup')).toHaveLength(2);
  });

  it('a bare loadstart with no preceding sourcechange still starts a load cycle', () => {
    const p = fakeTheo();
    p.source = { sources: [{ src: 'https://c/a.m3u8' }] };
    attachTheoPlayerVitals(p);
    native.recordPlayerEvent.mockClear();
    p.fire('loadstart', {});
    expect(native.recordPlayerEvent.mock.calls.map((c) => c[1])).toEqual(['source_change']);
  });

  it('seeding a loaded but paused player never fabricates a startup latency', () => {
    let now = BASE; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const p = fakeTheo({ paused: true, source: { sources: [{ src: 'https://c/v.mpd' }] } });
    attachTheoPlayerVitals(p);
    now = BASE + 60_000;
    p.fire('playing', {});
    expect(native.recordPlayerEvent.mock.calls.map((c) => c[1])).toEqual(['source_change', 'play']);
  });

  it('a load cycle drops the previous source cached bitrate from stats', () => {
    let now = BASE; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const p = fakeTheo();
    p.source = { sources: [{ src: 'https://c/a.m3u8' }] };
    attachTheoPlayerVitals(p);
    p.fire('mediatrack', { subType: 'activequalitychanged', trackType: 'video', qualities: { bandwidth: 2_800_000, width: 1280, height: 720 } });
    p.currentTime = 1; p.buffered = [{ start: 0, end: 6 }];
    p.fire('timeupdate', { currentTime: 1 });
    now = BASE + 2000;
    p.fire('sourcechange', { source: p.source });
    p.fire('timeupdate', { currentTime: 1 });
    expect(native.updatePlayerStats.mock.calls.map(([, s]) => s)).toEqual([
      { bufferAheadMs: 5000, bitrate: 2_800_000, width: 1280, height: 720 },
      { bufferAheadMs: 5000 },
    ]);
  });

  it('destroy detaches once', () => {
    const p = fakeTheo(); attachTheoPlayerVitals(p); p.fire('destroy', {}); p.fire('destroy', {});
    expect(native.detachPlayer).toHaveBeenCalledTimes(1); expect(p.count()).toBe(0);
  });

  // ---- Codex round-8, J3 — a throw mid-attach must not leave half an attachment behind ----

  // A THEOplayer destroyed between the caller's null check and the attach throws from
  // `addEventListener`. Without a rollback the adapter left the listeners it had already
  // installed on a dead player AND a native registration that never emits again — a player
  // the session reports as live for the rest of its life.
  it('an addEventListener that throws mid-attach rolls the whole attachment back', () => {
    const p = fakeTheo();
    let n = 0;
    const real = p.addEventListener.bind(p);
    p.addEventListener = (type: string, l: (e: unknown) => void) => {
      if (++n === 3) throw new Error('player destroyed');
      real(type, l);
    };
    const detach = attachTheoPlayerVitals(p);
    expect(native.trackPlayer).toHaveBeenCalledTimes(1);
    expect(native.detachPlayer).toHaveBeenCalledTimes(1);   // the token is released
    expect(p.count()).toBe(0);                              // nothing left subscribed
    expect(() => detach()).not.toThrow();
    expect(native.detachPlayer).toHaveBeenCalledTimes(1);   // …and the inert detach is a no-op
  });

  it('a seed getter that throws mid-attach rolls the whole attachment back', () => {
    const p = fakeTheo();
    Object.defineProperty(p, 'source', { get() { throw new Error('player destroyed'); } });
    const detach = attachTheoPlayerVitals(p);
    expect(native.detachPlayer).toHaveBeenCalledTimes(1);
    expect(p.count()).toBe(0);
    expect(() => detach()).not.toThrow();
  });

  it('useTheoPlayerVitals binds per instance', () => {
    const a = fakeTheo(); const b = fakeTheo();
    function C({ p }: { p: TheoPlayerLike | null }) { useTheoPlayerVitals(p); return null; }
    const { rerender, unmount } = render(<C p={null} />);
    expect(native.trackPlayer).not.toHaveBeenCalled();
    rerender(<C p={a} />); expect(native.trackPlayer).toHaveBeenCalledTimes(1);
    rerender(<C p={b} />); expect(native.detachPlayer).toHaveBeenCalledWith('rp1'); expect(a.count()).toBe(0);
    unmount(); expect(native.detachPlayer).toHaveBeenCalledWith('rp2');
  });
});
