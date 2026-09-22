// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Behavioural coverage for the shared player-translator core: startup/play
// spans, buffer spans, rate/size de-dup, error rationing, stats throttling,
// seed/close lifecycle, and the per-source reset a `loadStart` mid-playback
// must perform (fix round 1).
import { describe, it, expect, vi } from 'vitest';
import { createPlayerTranslator } from '../src/integrations/player-translator.js';
import type { PlayerHandle } from '../src/vitals.js';

function fakeHandle() {
  const calls: Array<[string, unknown, number | undefined]> = [];
  const stats: unknown[] = [];
  const h: PlayerHandle & { calls: typeof calls; stats: unknown[]; detachCount: number } = {
    token: 'rp1', detached: false, calls, stats, detachCount: 0,
    emit: (type, data, t) => { calls.push([type, data, t]); },
    updateStats: (s) => { stats.push(s); },
    track: () => {}, detach: () => { h.detachCount++; },
  };
  return h;
}
const clock = (start = 1000) => { let t = start; return { now: () => t, tick: (ms: number) => { t += ms; } }; };
const types = (h: ReturnType<typeof fakeHandle>) => h.calls.map((c) => c[0]);

describe('player translator', () => {
  it('startup: loadStart → first playing emits source_change, startup{ttffMs}, play', () => {
    const h = fakeHandle(); const c = clock(); const tr = createPlayerTranslator(h, c);
    tr.loadStart('https://c/a.m3u8?t=1', { live: true, keySystem: 'widevine' }); c.tick(850); tr.playing();
    expect(h.calls).toEqual([
      ['source_change', { src: 'https://c/a.m3u8?t=1', live: true }, 1000],
      ['drm', { keySystem: 'widevine' }, 1000],
      ['startup', { ttffMs: 850 }, 1850],
      ['play', undefined, 1850],
    ]);
  });
  it('a later playing after pause is a plain play; ended and paused close the span once', () => {
    const h = fakeHandle(); const tr = createPlayerTranslator(h, clock());
    tr.loadStart('x'); tr.playing(); tr.paused(); tr.paused(); tr.playing(); tr.ended();
    expect(types(h)).toEqual(['source_change', 'startup', 'play', 'pause', 'play', 'pause']);
  });
  it('a new loadStart re-arms startup', () => {
    const h = fakeHandle(); const tr = createPlayerTranslator(h, clock());
    tr.loadStart('a'); tr.playing(); tr.loadStart('b'); tr.playing();
    expect(types(h).filter((t) => t === 'startup')).toHaveLength(2);
  });
  it('buffering spans carry durationMs and ignore repeats', () => {
    const h = fakeHandle(); const c = clock(); const tr = createPlayerTranslator(h, c);
    // Codex round-4, F2 — buffering only counts AFTER the first frame of the source, so this
    // test (and the ones below it that open a bare buffer span) has to get past startup first.
    // The expectation itself is unchanged.
    tr.playing(); h.calls.length = 0;
    tr.bufferingChanged(true); tr.bufferingChanged(true); c.tick(120); tr.bufferingChanged(false); tr.bufferingChanged(false);
    expect(h.calls).toEqual([['buffer_start', undefined, 1000], ['buffer_end', { durationMs: 120 }, 1120]]);
  });
  it('rate: ignores 0 and repeats', () => {
    const h = fakeHandle(); const tr = createPlayerTranslator(h, clock());
    tr.rateChanged(1); tr.rateChanged(0); tr.rateChanged(1); tr.rateChanged(1.5);
    expect(h.calls.map((c) => c[1])).toEqual([{ rate: 1 }, { rate: 1.5 }]);
  });
  it('bitrate and size', () => {
    const h = fakeHandle(); const tr = createPlayerTranslator(h, clock());
    tr.bitrateChanged(3e6, 1920, 1080); tr.sizeChanged(1920, 1080); tr.sizeChanged(1920, 1080); tr.sizeChanged(1280, 720);
    expect(h.calls.map((c) => [c[0], c[1]])).toEqual([
      ['bitrate_change', { bitrate: 3e6, width: 1920, height: 1080 }],
      ['quality_change', { width: 1920, height: 1080 }],
      ['quality_change', { width: 1280, height: 720 }],
    ]);
  });
  it('fatal error closes open spans', () => {
    const h = fakeHandle(); const c = clock(); const tr = createPlayerTranslator(h, c);
    tr.loadStart('a'); tr.playing(); tr.bufferingChanged(true); tr.error('dead', 'source/invalid-uri', true);
    expect(types(h).slice(-3)).toEqual(['error', 'buffer_end', 'pause']);
  });
  // Codex round-2, D4 — the allowance is ten per ROLLING minute of ADMITTED non-fatal
  // errors, evicted per candidate. The old fixed window restarted only when an error
  // arrived after it had expired, so a burst that straddled the boundary was charged
  // against whichever window happened to be open — a player erroring steadily reported ten
  // and then nothing at all for the rest of the minute. Neither case below distinguishes
  // the two implementations by accident: the first turns on the eviction of exactly ONE
  // entry, the second on the boundary being half-open.
  it('non-fatal errors are rationed on a rolling minute of admitted errors', () => {
    const h = fakeHandle(); const c = clock(); const tr = createPlayerTranslator(h, c);
    tr.error('blip', undefined, false);                       // 1 at t = 0
    c.tick(59_999);
    for (let i = 0; i < 9; i++) tr.error('blip', undefined, false);   // 9 at t = 59_999 → ten held
    expect(h.calls).toHaveLength(10);
    c.tick(2);                                                // t = 60_001
    // Only the t = 0 entry is 60_000 ms old or more, so exactly ONE slot frees up: the
    // first of these ten is admitted and the other nine are refused.
    for (let i = 0; i < 10; i++) tr.error('blip', undefined, false);
    expect(h.calls).toHaveLength(11);
    expect(h.calls[10]).toEqual(['error', { message: 'blip', fatal: false }, 60_001 + 1000]);
  });
  it('an error exactly one minute after a full window is admitted — the window is half-open', () => {
    const h = fakeHandle(); const c = clock(); const tr = createPlayerTranslator(h, c);
    for (let i = 0; i < 10; i++) tr.error('blip', undefined, false);  // ten at t = 0
    expect(h.calls).toHaveLength(10);
    c.tick(59_999); tr.error('blip', undefined, false);
    expect(h.calls).toHaveLength(10);                         // nothing evicted yet
    c.tick(1); tr.error('blip', undefined, false);            // t = 60_000: all ten evicted
    expect(h.calls).toHaveLength(11);
  });
  it('stats are throttled to one push per second', () => {
    const h = fakeHandle(); const c = clock(); const tr = createPlayerTranslator(h, c);
    tr.stats({ bufferAheadMs: 1 }); c.tick(500); tr.stats({ bufferAheadMs: 2 }); c.tick(500); tr.stats({ bufferAheadMs: 3 });
    expect(h.stats).toEqual([{ bufferAheadMs: 1 }, { bufferAheadMs: 3 }]);
  });
  it('seedPlaying opens a play span without startup and disarms a pending startup', () => {
    const h = fakeHandle(); const tr = createPlayerTranslator(h, clock());
    tr.loadStart('a'); tr.seedPlaying(); tr.paused(); tr.playing();
    expect(types(h)).toEqual(['source_change', 'play', 'pause', 'play']);
  });
  it('close closes spans and detaches once; the translator is inert afterwards', () => {
    const h = fakeHandle(); const tr = createPlayerTranslator(h, clock());
    tr.seedPlaying(); tr.bufferingChanged(true); tr.close(); tr.close();
    expect(types(h)).toEqual(['play', 'buffer_start', 'buffer_end', 'pause']); expect(h.detachCount).toBe(1);
    tr.playing(); expect(types(h)).toHaveLength(4);
  });
  it('wrap never throws into the host', () => {
    const tr = createPlayerTranslator(fakeHandle(), clock());
    expect(() => tr.wrap(() => { throw new Error('bug'); })()).not.toThrow();
  });
  it('loadStart during buffering closes the buffer span first', () => {
    const h = fakeHandle(); const c = clock(); const tr = createPlayerTranslator(h, c);
    tr.playing(); tr.paused();                 // past startup (F2), and the play span closed again
    tr.bufferingChanged(true); c.tick(300);
    h.calls.length = 0;
    tr.loadStart('b');
    expect(h.calls.map((c) => [c[0], c[1]])).toEqual([
      ['buffer_end', { durationMs: 300 }],
      ['source_change', { src: 'b' }],
    ]);
  });
  it('loadStart while playing closes the play span and the next playing emits startup AND play', () => {
    const h = fakeHandle(); const tr = createPlayerTranslator(h, clock());
    tr.loadStart('a'); tr.playing(); tr.loadStart('b'); tr.playing();
    expect(types(h)).toEqual(['source_change', 'startup', 'play', 'pause', 'source_change', 'startup', 'play']);
  });
  it('seedSource emits source_change (+ drm) without arming the startup clock', () => {
    const h = fakeHandle(); const c = clock(); const tr = createPlayerTranslator(h, c);
    tr.seedSource('https://c/x.mpd', { keySystem: 'fairplay' });
    c.tick(60_000); tr.playing();
    expect(h.calls).toEqual([
      ['source_change', { src: 'https://c/x.mpd' }, 1000],
      ['drm', { keySystem: 'fairplay' }, 1000],
      ['play', undefined, 61_000],
    ]);
  });
  it('seedSource closes nothing and resets no de-dup', () => {
    const h = fakeHandle(); const c = clock(); const tr = createPlayerTranslator(h, c);
    tr.seedPlaying(); tr.bufferingChanged(true); tr.rateChanged(1);
    h.calls.length = 0;
    tr.seedSource('a'); tr.rateChanged(1);
    expect(types(h)).toEqual(['source_change']);
  });
  it('paused closes an open buffer span before the play span', () => {
    const h = fakeHandle(); const c = clock(); const tr = createPlayerTranslator(h, c);
    tr.playing(); tr.paused(); h.calls.length = 0;   // past startup (F2), no play span open
    tr.bufferingChanged(true); c.tick(300); tr.paused();
    expect(h.calls.map((x) => [x[0], x[1]])).toEqual([
      ['buffer_start', undefined],
      ['buffer_end', { durationMs: 300 }],
    ]);
  });
  it('paused and ended emit buffer_end before pause when a play span is open', () => {
    const h = fakeHandle(); const c = clock(); const tr = createPlayerTranslator(h, c);
    tr.loadStart('a'); tr.playing(); tr.bufferingChanged(true); c.tick(300);
    h.calls.length = 0;
    tr.paused();
    expect(h.calls.map((x) => [x[0], x[1]])).toEqual([['buffer_end', { durationMs: 300 }], ['pause', undefined]]);
    tr.playing(); tr.bufferingChanged(true); c.tick(120);
    h.calls.length = 0;
    tr.ended();
    expect(h.calls.map((x) => [x[0], x[1]])).toEqual([['buffer_end', { durationMs: 120 }], ['pause', undefined]]);
  });
  // ---- Codex round-4, F2 — the FIRST buffering of a source is startup, not a rebuffer ----
  //
  // The player filling its buffer before the first frame is exactly what `startup{ttffMs}`
  // already measures; counting it again as a rebuffer inflated every session's rebuffer count
  // and rebuffer time by one span per source. Media3 gates the same way on `firstFrameSeen`.
  it('buffering before first playing emits no span', () => {
    const h = fakeHandle(); const c = clock(); const tr = createPlayerTranslator(h, c);
    tr.loadStart('a');
    c.tick(300); tr.bufferingChanged(true);         // startup stall: tracked as nothing
    c.tick(600); tr.bufferingChanged(false);        // …so its end emits nothing either
    tr.playing();
    expect(types(h)).toEqual(['source_change', 'startup', 'play']);
    expect(h.calls.find((x) => x[0] === 'startup')?.[1]).toEqual({ ttffMs: 900 });
  });
  it('buffering after playing does', () => {
    const h = fakeHandle(); const c = clock(); const tr = createPlayerTranslator(h, c);
    tr.loadStart('a'); c.tick(900); tr.playing();
    h.calls.length = 0;
    c.tick(1600); tr.bufferingChanged(true); c.tick(150); tr.bufferingChanged(false);
    expect(h.calls.map((x) => [x[0], x[1]])).toEqual([
      ['buffer_start', undefined],
      ['buffer_end', { durationMs: 150 }],
    ]);
  });
  it('a new loadStart re-arms the startup gate, so the next source stalls for free', () => {
    const h = fakeHandle(); const c = clock(); const tr = createPlayerTranslator(h, c);
    tr.loadStart('a'); tr.playing();
    tr.loadStart('b');                              // new source: startup again
    tr.bufferingChanged(true); c.tick(200); tr.bufferingChanged(false);
    expect(types(h).filter((t) => t.startsWith('buffer'))).toEqual([]);
  });
  it('seedSource does NOT re-arm the gate — an attached, running player stalls for real', () => {
    const h = fakeHandle(); const c = clock(); const tr = createPlayerTranslator(h, c);
    tr.seedPlaying(); tr.seedSource('a');           // attach-time seed of a player already going
    h.calls.length = 0;
    tr.bufferingChanged(true); c.tick(80); tr.bufferingChanged(false);
    expect(h.calls.map((x) => [x[0], x[1]])).toEqual([
      ['buffer_start', undefined],
      ['buffer_end', { durationMs: 80 }],
    ]);
  });

  // ---- Codex round-8, J2 — attaching to a player already past startup but not playing ----
  it('seedStarted marks the source started so a later stall is a real rebuffer span', () => {
    const h = fakeHandle(); const c = clock(); const tr = createPlayerTranslator(h, c);
    tr.seedSource('a'); tr.seedStarted(); tr.seedStarted();   // idempotent
    h.calls.length = 0;
    tr.bufferingChanged(true); c.tick(500); tr.bufferingChanged(false);
    expect(h.calls.map((x) => [x[0], x[1]])).toEqual([
      ['buffer_start', undefined],
      ['buffer_end', { durationMs: 500 }],
    ]);
  });
  it('seedStarted opens no play span and arms no startup', () => {
    const h = fakeHandle(); const c = clock(); const tr = createPlayerTranslator(h, c);
    tr.seedStarted();
    expect(types(h)).toEqual([]);                 // no play, no startup, nothing
    c.tick(60_000); tr.playing();
    expect(types(h)).toEqual(['play']);           // …and the later playing is a bare play
  });

  it('loadStart resets rate and size de-dup', () => {
    const h = fakeHandle(); const tr = createPlayerTranslator(h, clock());
    tr.rateChanged(1); tr.sizeChanged(1280, 720); tr.loadStart('b'); tr.rateChanged(1); tr.sizeChanged(1280, 720);
    expect(types(h).filter((t) => t === 'rate_change')).toHaveLength(2);
    expect(types(h).filter((t) => t === 'quality_change')).toHaveLength(2);
  });
});
