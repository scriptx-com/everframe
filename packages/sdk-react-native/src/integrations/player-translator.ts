// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Library-neutral translator core shared by the RN player adapters (spec
// 2026-09-06 §3). Owns: the startup clock, play/buffer spans, rate/size
// de-duplication, non-fatal error rationing (10 per ROLLING minute of
// admitted errors — the Media3 rule), the ≤ 1/s stats throttle, and span
// closure on fatal error / close. Adapters only map their library's events
// onto these calls.
import type { PlayerHandle, PlayerStats } from '../vitals.js';

export interface TranslatorClock { now(): number }
export interface PlayerTranslator {
  loadStart(src: string | undefined, extra?: { mime?: string; live?: boolean; keySystem?: string }): void;
  seedSource(src: string | undefined, extra?: { mime?: string; live?: boolean; keySystem?: string }): void;
  playing(): void; paused(): void; ended(): void;
  bufferingChanged(on: boolean): void;
  seek(): void;
  rateChanged(rate: number): void;
  bitrateChanged(bitrate: number, width?: number, height?: number): void;
  sizeChanged(width: number, height: number): void;
  error(message: string, code: string | undefined, fatal: boolean): void;
  stats(stats: PlayerStats): void;
  seedPlaying(): void;
  seedStarted(): void;
  close(): void;
  wrap<T extends unknown[]>(fn: (...a: T) => void): (...a: T) => void;
}

const NON_FATAL_ERRORS_PER_MINUTE = 10;
const STATS_MIN_INTERVAL_MS = 1000;

export function createPlayerTranslator(
  handle: PlayerHandle,
  clock: TranslatorClock = { now: () => Date.now() },
): PlayerTranslator {
  let closed = false;
  let loadStartAt: number | undefined;
  let startupPending = false;
  // Codex round-4, F2 — has the CURRENT source ever reached its first frame? Buffering before
  // that is STARTUP, not a rebuffer: the player is filling its buffer for the first time, which
  // is what the `startup{ttffMs}` event already measures. Counting it twice inflated every
  // session's rebuffer count and rebuffer time by one span per source — on a short clip, the
  // dominant contribution. Media3 gates the identical way on `firstFrameSeen`.
  //
  // Set by `playing()` and `seedPlaying()` (both mean "frames are on screen"), cleared by
  // `loadStart()` (a NEW source starts its own startup) and deliberately NOT by `seedSource()`:
  // that describes a source loaded before we attached, whose startup we did not witness and
  // must not re-arm — an already-running player's next stall is a rebuffer, not a startup.
  let started = false;
  let playing = false;
  let bufferStartAt: number | undefined;
  let lastRate: number | undefined;
  let lastSize: string | undefined;
  let lastStatsAt = -Infinity;
  // Codex round-2, D4 — the timestamps of the last ten ADMITTED non-fatal errors, oldest
  // first. The previous `errorWindowStart`/`errorsInWindow` pair was a FIXED window, not a
  // rolling one: ten errors at t=0 exhausted the allowance until t=60_001, so a player
  // erroring steadily reported ten and then nothing for a whole minute — and, worse, the
  // window only ever restarted on an error that arrived after it expired, so a burst
  // straddling the boundary was charged against whichever window happened to be open.
  // Evicting per candidate makes the limit what the doc always claimed: ten per ROLLING
  // minute. Bounded at ten entries by construction (nothing is pushed once ten remain).
  const nonFatalAdmittedAt: number[] = [];

  const emit = (type: Parameters<PlayerHandle['emit']>[0], data?: Record<string, unknown>) => {
    if (!closed) handle.emit(type, data, clock.now());
  };
  const openPlay = () => { if (!playing) { playing = true; emit('play'); } };
  const closePlay = () => { if (playing) { playing = false; emit('pause'); } };
  const closeBuffer = () => {
    if (bufferStartAt !== undefined) { const d = clock.now() - bufferStartAt; bufferStartAt = undefined; emit('buffer_end', { durationMs: Math.max(0, d) }); }
  };
  const emitSource = (src: string | undefined, extra?: { mime?: string; live?: boolean; keySystem?: string }) => {
    const data: Record<string, unknown> = {};
    if (src) data.src = src;
    if (extra?.mime) data.mime = extra.mime;
    if (extra?.live !== undefined) data.live = extra.live;
    emit('source_change', data);
    if (extra?.keySystem) emit('drm', { keySystem: extra.keySystem });
  };

  return {
    loadStart(src, extra) {
      // A source swap resets per-source state: an open buffer span must
      // close against the OLD source (not report its duration against the
      // new one), an open play span must close (a source swap always
      // interrupts playback, and leaving it open would let a later startup
      // land without an accompanying play), and rate/size de-dup must not
      // suppress the new source's first real values just because they
      // match the old source's last-seen ones.
      closeBuffer(); closePlay(); lastRate = undefined; lastSize = undefined;
      // The new source has its own startup to serve, so its first buffering is startup again.
      started = false;
      loadStartAt = clock.now(); startupPending = true;
      emitSource(src, extra);
    },
    // Attach-time source read: describes what is ALREADY loaded. It emits the
    // same `source_change` (+ `drm`) as an observed load, but must never arm
    // the startup clock — the load it describes happened before we attached,
    // so a later `playing` would report the time since ATTACH as ttff (an
    // idle player picked up an hour later would claim an hour-long startup).
    // It also closes nothing and resets no de-dup: at attach there is no open
    // span and no previous source to de-dup against.
    seedSource(src, extra) { emitSource(src, extra); },
    playing() {
      if (startupPending && loadStartAt !== undefined) {
        startupPending = false; emit('startup', { ttffMs: Math.max(0, clock.now() - loadStartAt) });
      }
      started = true;
      openPlay();
    },
    // A buffer span left open when playback stops would otherwise run until
    // the next `buffer_end` (or forever), so close it BEFORE the play span:
    // `buffer_end` then `pause` keeps the spans properly nested.
    paused() { closeBuffer(); closePlay(); },
    ended() { closeBuffer(); closePlay(); },
    bufferingChanged(on) {
      // Round-4, F2 — before the first frame of this source there is no span to open and none
      // to close: nothing is tracked, so an unmatched `bufferingChanged(false)` on the way out
      // of startup emits nothing either (`closeBuffer` is a no-op with no span open, but the
      // gate makes the intent explicit rather than incidental).
      if (!started) return;
      if (on) { if (bufferStartAt === undefined) { bufferStartAt = clock.now(); emit('buffer_start'); } }
      else closeBuffer();
    },
    seek() { emit('seek'); },
    rateChanged(rate) {
      if (!(rate > 0) || rate === lastRate) return;
      lastRate = rate; emit('rate_change', { rate });
    },
    bitrateChanged(bitrate, width, height) {
      const data: Record<string, unknown> = { bitrate };
      if (width !== undefined) data.width = width;
      if (height !== undefined) data.height = height;
      emit('bitrate_change', data);
    },
    sizeChanged(width, height) {
      const key = `${width}x${height}`;
      if (key === lastSize || !(width > 0) || !(height > 0)) return;
      lastSize = key; emit('quality_change', { width, height });
    },
    error(message, code, fatal) {
      if (!fatal) {
        // Codex round-4, F3 — this budget counts forwarding ATTEMPTS, not admissions.
        // `PlayerHandle.emit` is void: the bridge is fire-and-forget, so JS never learns
        // whether native took the entry (it drops one recorded before vitals started, for a
        // token whose registration was refused, or against a killed SDK). An error refused
        // over there still spends a slot here. Making it exact would mean a promise per error
        // on the JS thread for an event class that is already rate-limited — the wrong trade.
        // Documented in the README's Session Vitals limitations.
        const now = clock.now();
        // `>=` so an error exactly 60_000 ms after an admitted one evicts it: the window is
        // the last minute, half-open, and the two SDK twins charge it the same way.
        while (nonFatalAdmittedAt.length > 0 && now - (nonFatalAdmittedAt[0] as number) >= 60_000) nonFatalAdmittedAt.shift();
        if (nonFatalAdmittedAt.length >= NON_FATAL_ERRORS_PER_MINUTE) return;
        nonFatalAdmittedAt.push(now);
      }
      const data: Record<string, unknown> = { message, fatal };
      if (code !== undefined) data.code = code;
      emit('error', data);
      if (fatal) { closeBuffer(); closePlay(); }
    },
    stats(stats) {
      const now = clock.now();
      if (now - lastStatsAt < STATS_MIN_INTERVAL_MS) return;
      lastStatsAt = now;
      if (!closed) handle.updateStats(stats);
    },
    // Attach-time seed: open the span WITHOUT a startup. Adapters seed the
    // source via `seedSource` (which never arms), so the disarm here is only
    // belt-and-braces against a caller that used `loadStart` to seed.
    seedPlaying() { startupPending = false; started = true; openPlay(); },
    // Codex round-8, J2 — attach-time seed for a player that is PAST startup but not
    // currently playing: the source has produced frames (a positive `currentTime`, or the
    // library says it is ready), it is simply paused or — the case this exists for —
    // mid-rebuffer at the moment we attach.
    //
    // Without it, `started` stayed false for such a player, so the round-4 F2 startup gate
    // swallowed every `bufferingChanged` until the next `playing`: attach during a stall and
    // the whole stall, plus any that followed before playback resumed, went unreported.
    //
    // It marks the source started and NOTHING else: no play span (the player is not
    // playing), no startup arming (we did not witness this source's load, and arming would
    // report the time since ATTACH as its ttff). The in-flight stall itself is deliberately
    // NOT back-dated into a `buffer_start` — its start time is unknowable from here — so the
    // span opens on the next `onBuffer(true)`/state event, which is the first moment we
    // actually observe. Idempotent.
    seedStarted() { started = true; },
    close() {
      if (closed) return;
      closeBuffer(); closePlay();
      closed = true;
      handle.detach();
    },
    wrap: (fn) => (...a) => {
      try { fn(...a); } catch (e) {
        if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn('[everframe] player adapter handler failed', e);
      }
    },
  };
}
