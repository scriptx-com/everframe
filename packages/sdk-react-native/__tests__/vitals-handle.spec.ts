// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Session Vitals — trackPlayer/PlayerHandle/trackVitals unit tests
// (spec 2026-09-06 §3, Task 3).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import NativeEverframe from '../src/NativeEverframe.js';
import { trackPlayer, trackVitals, serializeVitalsData, __resetPlayerTokenCounterForTests } from '../src/vitals.js';

type M = Record<'trackPlayer' | 'detachPlayer' | 'recordPlayerEvent' | 'updatePlayerStats' | 'trackVitals', ReturnType<typeof vi.fn>>;
const native = NativeEverframe as unknown as M;

describe('trackPlayer handle (spec 2026-09-06 §3)', () => {
  beforeEach(() => {
    for (const k of Object.keys(native) as (keyof M)[]) native[k].mockClear?.();
    __resetPlayerTokenCounterForTests();
  });

  it('registers immediately with a minted token and forwards library/name/version', () => {
    const h = trackPlayer({ library: 'theoplayer', libraryVersion: '9.1.0', name: 'main' });
    expect(h.token).toBe('rp1');
    expect(native.trackPlayer).toHaveBeenCalledWith('rp1', 'theoplayer', 'main', '9.1.0');
  });

  it('mints distinct tokens per call', () => {
    expect(trackPlayer({ library: 'a' }).token).toBe('rp1');
    expect(trackPlayer({ library: 'b' }).token).toBe('rp2');
  });

  it('emit defaults t to Date.now() and passes an explicit t through', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1757000000000);
    const h = trackPlayer({ library: 'x' });
    h.emit('play');
    expect(native.recordPlayerEvent).toHaveBeenCalledWith('rp1', 'play', 1757000000000, undefined);
    h.emit('buffer_end', { durationMs: 40 }, 1757000000500);
    expect(native.recordPlayerEvent).toHaveBeenLastCalledWith('rp1', 'buffer_end', 1757000000500, { durationMs: 40 });
    vi.restoreAllMocks();
  });

  it('updateStats and track forward with the token', () => {
    const h = trackPlayer({ library: 'x' });
    h.updateStats({ bufferAheadMs: 1200, bitrate: 3_000_000 });
    expect(native.updatePlayerStats).toHaveBeenCalledWith('rp1', { bufferAheadMs: 1200, bitrate: 3_000_000 });
    h.track('ad_break', { id: 7 });
    expect(native.trackVitals).toHaveBeenCalledWith('ad_break', '{"id":7}', 'rp1');
  });

  it('detach is idempotent and the handle goes inert afterwards', () => {
    const h = trackPlayer({ library: 'x' });
    h.detach(); h.detach();
    expect(native.detachPlayer).toHaveBeenCalledTimes(1);
    expect(h.detached).toBe(true);
    h.emit('play'); h.updateStats({ bufferAheadMs: 1 }); h.track('n');
    expect(native.recordPlayerEvent).not.toHaveBeenCalled();
    expect(native.updatePlayerStats).not.toHaveBeenCalled();
    expect(native.trackVitals).not.toHaveBeenCalled();
  });

  it('a throwing native call never escapes to the host', () => {
    native.recordPlayerEvent.mockImplementationOnce(() => { throw new Error('boom'); });
    expect(() => trackPlayer({ library: 'x' }).emit('play')).not.toThrow();
  });
});

describe('trackVitals', () => {
  beforeEach(() => native.trackVitals.mockClear());
  it('session-scoped: serialises data, no token', () => {
    trackVitals('cdn', ['a', 1, null]);
    expect(native.trackVitals).toHaveBeenCalledWith('cdn', '["a",1,null]', undefined);
  });
  it('no data → dataJson undefined', () => {
    trackVitals('mark');
    expect(native.trackVitals).toHaveBeenCalledWith('mark', undefined, undefined);
  });
  it('player-scoped routes through the handle (inert once detached)', () => {
    const h = trackPlayer({ library: 'x' });
    trackVitals('x', 1, h);
    expect(native.trackVitals).toHaveBeenLastCalledWith('x', '1', h.token);
    h.detach(); native.trackVitals.mockClear();
    trackVitals('y', 2, h);
    expect(native.trackVitals).not.toHaveBeenCalled();
  });
});

describe('serializeVitalsData', () => {
  it('returns undefined for undefined and for unserialisable values', () => {
    expect(serializeVitalsData(undefined)).toBeUndefined();
    const cyc: Record<string, unknown> = {}; cyc.self = cyc;
    expect(serializeVitalsData(cyc)).toBeUndefined();
    expect(serializeVitalsData(10n)).toBeUndefined();
  });
  it('serialises scalars, arrays and objects', () => {
    expect(serializeVitalsData(null)).toBe('null');
    expect(serializeVitalsData('s')).toBe('"s"');
    expect(serializeVitalsData({ a: [1, 2] })).toBe('{"a":[1,2]}');
  });
});
