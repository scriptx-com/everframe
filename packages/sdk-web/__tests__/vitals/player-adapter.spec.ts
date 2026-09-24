// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVitalsCollector } from '@everframe/sdk-core';
import type { PlayerIntegration, PlayerIntegrationContext } from '@everframe/sdk-core';
import {
  attachPlayerVitals,
  type PlayerVitalsAdapter,
  type PlayerVitalsDeps,
} from '../../src/vitals/player-adapter.js';
import { shakaIntegration, SHAKA_EVENTS } from '../../src/vitals/integrations/shaka.js';
import { MAX_PLAYER_LIBRARY_LENGTH } from '@everframe/protocol';

type Emitted = { t: number; type: string; data?: Record<string, unknown>; playerId?: string };

// Phase 4 (spec 2026-09-02 §1) introduces bind-time/lifecycle chatter
// (`player_attach`/`player_detach`, `source_change`, `quality_change`, `drm`,
// `stats`) alongside the phase 1-3 transport stream (play/pause/startup/…).
// The phase-3 cases below assert on `events` — the transport stream only —
// so they keep passing unmodified even though bind now also emits
// `player_attach`; the phase-4 cases assert on `lifecycle`. `all` preserves
// the true emission order across both, for the handful of cases (loadstart
// mid-rebuffer; reseed) whose assertion genuinely spans both streams.
const LIFECYCLE = new Set(['player_attach', 'player_detach', 'stats', 'source_change', 'quality_change', 'drm']);
let events: Emitted[];
let lifecycle: Emitted[];
let all: Emitted[];

function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function stubCurrentSrc(el: HTMLMediaElement, value: string) {
  // jsdom's HTMLMediaElement exposes `currentSrc` as a getter-only accessor —
  // redefine it as an own property on the instance so tests can drive it.
  Object.defineProperty(el, 'currentSrc', { value, configurable: true });
}

describe('attachPlayerVitals', () => {
  let adapter: PlayerVitalsAdapter | undefined;

  beforeEach(() => {
    document.body.innerHTML = '';
    events = [];
    lifecycle = [];
    all = [];
  });

  afterEach(() => {
    adapter?.stop();
    adapter = undefined;
  });

  function start(now?: () => number, deps: Partial<PlayerVitalsDeps> = {}) {
    adapter = attachPlayerVitals({
      onEvent: (e) => {
        all.push(e);
        (LIFECYCLE.has(e.type) ? lifecycle : events).push(e);
      },
      now,
      ...deps,
    });
    return adapter;
  }

  it('auto-attaches to an element already present at construction time', () => {
    document.body.innerHTML = '<video id="v1"></video>';
    start();
    const v1 = document.getElementById('v1') as HTMLVideoElement;

    v1.dispatchEvent(new Event('play'));

    expect(events).toEqual([expect.objectContaining({ type: 'play' })]);
  });

  it('attaches to an element added later via the MutationObserver', async () => {
    start();
    const v = document.createElement('video');
    document.body.appendChild(v);

    await flush();
    v.dispatchEvent(new Event('play'));

    expect(events).toContainEqual(expect.objectContaining({ type: 'play' }));
  });

  it('attaches to media elements nested inside an added subtree', async () => {
    start();
    const wrapper = document.createElement('div');
    const v = document.createElement('video');
    wrapper.appendChild(v);
    document.body.appendChild(wrapper);

    await flush();
    v.dispatchEvent(new Event('play'));

    expect(events).toContainEqual(expect.objectContaining({ type: 'play' }));
  });

  it('treats a waiting before the first playing as startup latency, not a rebuffer', () => {
    let clock = 1000;
    document.body.innerHTML = '<video id="v"></video>';
    start(() => clock);
    const v = document.getElementById('v') as HTMLVideoElement;

    v.dispatchEvent(new Event('loadstart'));
    clock = 1050;
    v.dispatchEvent(new Event('waiting')); // pre-first-frame — must not emit buffer_start
    clock = 1300;
    v.dispatchEvent(new Event('playing')); // first frame — startup, not buffer_end

    expect(events.map((e) => e.type)).toEqual(['startup']);
    expect(events[0].data).toEqual({ ttffMs: 300 });
  });

  it('opens and closes a buffer span across waiting -> playing after the first frame', () => {
    let clock = 1000;
    document.body.innerHTML = '<video id="v"></video>';
    start(() => clock);
    const v = document.getElementById('v') as HTMLVideoElement;

    v.dispatchEvent(new Event('loadstart'));
    clock = 1100;
    v.dispatchEvent(new Event('playing')); // startup — first frame
    events.length = 0;

    clock = 1400;
    v.dispatchEvent(new Event('waiting'));
    clock = 1650;
    v.dispatchEvent(new Event('playing'));

    expect(events.map((e) => e.type)).toEqual(['buffer_start', 'buffer_end']);
    expect(events[1].data).toEqual({ durationMs: 250 });
  });

  it('still opens a rebuffer span for a waiting that immediately follows a seek', () => {
    let clock = 1000;
    document.body.innerHTML = '<video id="v"></video>';
    start(() => clock);
    const v = document.getElementById('v') as HTMLVideoElement;

    v.dispatchEvent(new Event('loadstart'));
    clock = 1100;
    v.dispatchEvent(new Event('playing')); // startup
    events.length = 0;

    v.currentTime = 42;
    clock = 1700;
    v.dispatchEvent(new Event('seeking'));
    clock = 1750;
    v.dispatchEvent(new Event('waiting'));
    clock = 1900;
    v.dispatchEvent(new Event('playing'));

    expect(events.map((e) => e.type)).toEqual(['seek', 'buffer_start', 'buffer_end']);
    expect(events[0].data).toEqual({ from: 42 });
    expect(events[2].data).toEqual({ durationMs: 150 });
  });

  it('does not open a second buffer span for a repeated waiting', () => {
    let clock = 1000;
    document.body.innerHTML = '<video id="v"></video>';
    start(() => clock);
    const v = document.getElementById('v') as HTMLVideoElement;

    v.dispatchEvent(new Event('loadstart'));
    v.dispatchEvent(new Event('playing')); // startup
    events.length = 0;

    v.dispatchEvent(new Event('waiting'));
    v.dispatchEvent(new Event('waiting')); // span already open — must not re-emit
    clock = 1200;
    v.dispatchEvent(new Event('playing'));

    expect(events.map((e) => e.type)).toEqual(['buffer_start', 'buffer_end']);
  });

  // Fix T6-upgrade (final review): a source change mid-rebuffer (waiting ->
  // loadstart, e.g. quality/source swap) used to reset `s.buffering` WITHOUT
  // emitting `buffer_end`, leaving the accumulator's open span running until
  // end-of-session — this poisons rebufferDurationMs for the rest of the
  // session. loadstart must close the open span first.
  //
  // Codex round-5 finding F1 — loadstart on a PLAYING element now also
  // closes the play span (synthetic `pause`), since the HTML media load
  // algorithm resets `.paused` without firing a real `pause`. Order:
  // buffer_end before pause (setBuffering call precedes setPlaying in the
  // handler), pause before source_change.
  //
  // Harness note (phase 4): `source_change` now carries a payload and is
  // routed to `lifecycle`, not `events` — this assertion's ORDER still spans
  // both streams (buffer_end/pause are transport, source_change is
  // lifecycle), so it reads the combined `all` stream instead. The sequence
  // and timing asserted are unchanged from phase 3.
  it('closes an open buffer span when loadstart fires mid-rebuffer (source swap)', () => {
    let clock = 1000;
    document.body.innerHTML = '<video id="v"></video>';
    start(() => clock);
    const v = document.getElementById('v') as HTMLVideoElement;
    stubCurrentSrc(v, 'https://example.com/a.mp4');

    v.dispatchEvent(new Event('loadstart')); // first real src — recorded silently
    clock = 1100;
    v.dispatchEvent(new Event('playing')); // startup — first frame
    all.length = 0;
    lifecycle.length = 0;
    events.length = 0;

    clock = 1400;
    v.dispatchEvent(new Event('waiting')); // opens a buffer span
    clock = 1650;
    stubCurrentSrc(v, 'https://example.com/b.mp4'); // source swap mid-rebuffer
    v.dispatchEvent(new Event('loadstart')); // must close the open span before resetting

    expect(all.map((e) => e.type)).toEqual([
      'buffer_start',
      'buffer_end',
      'pause',
      'source_change',
    ]);
    expect(all[1]?.data).toEqual({ durationMs: 250 });

    // The next playing after the reload is startup latency again (sawFirstFrame
    // was reset by loadstart) — NOT a second buffer_end for the same span.
    events.length = 0;
    clock = 1900;
    v.dispatchEvent(new Event('playing'));

    expect(events.map((e) => e.type)).toEqual(['startup']);
  });

  // Codex round-5 finding F1 — loadstart must close the play span, not just
  // the buffer span. Without `setPlaying(s, false, t)` in the loadstart
  // handler, `isPlaying` stayed true straight through the reload/startup
  // gap: playtime kept accruing for however long the new source took to
  // start, and the eventual `pause` closed a span that silently included
  // the reload window.
  it('emits a synthetic pause at loadstart on a playing element, excluding the reload window from playtime', () => {
    let clock = 1000;
    document.body.innerHTML = '<video id="v"></video>';
    start(() => clock);
    const v = document.getElementById('v') as HTMLVideoElement;
    stubCurrentSrc(v, 'https://example.com/a.mp4');

    v.dispatchEvent(new Event('play'));
    clock = 1050;
    v.dispatchEvent(new Event('loadstart')); // first real src — recorded silently
    clock = 1100;
    v.dispatchEvent(new Event('playing')); // startup — first frame
    events.length = 0;

    // Reload while playing (same source re-selected, e.g. a manifest
    // refresh) — the HTML media load algorithm resets `.paused` WITHOUT
    // firing a real `pause`, then fires `loadstart`. Src is unchanged so
    // this asserts the pause in isolation, without a source_change alongside it.
    clock = 2000;
    v.dispatchEvent(new Event('loadstart'));

    expect(events.map((e) => e.type)).toEqual(['pause']);
    expect(events[0]!.t).toBe(2000);

    events.length = 0;
    clock = 2600; // 600ms reload/startup gap
    v.dispatchEvent(new Event('playing')); // startup again — new play span opens here
    clock = 3100; // 500ms of real playback
    v.dispatchEvent(new Event('pause'));

    expect(events.map((e) => e.type)).toEqual(['startup', 'pause']);
    // The playing handler does not re-emit `play` (see its own raw-assignment
    // comment) — only the final `pause` closes a span, and the span the
    // accumulator would compute (2600 -> 3100 = 500ms) EXCLUDES the
    // 1100 -> 2600 reload window, which is exactly what the synthetic pause
    // at loadstart (t=2000, closing the span opened at t=1000) achieved.
  });

  // Codex round-5 finding F1 — a rotation occurring between loadstart's
  // synthetic pause and the new source's `playing` must NOT reseed a
  // phantom play for this element: isPlaying is false during that window,
  // so reseed() (per its own `if (s.isPlaying)` guard) correctly skips it.
  it('does not reseed a phantom play for an element mid-reload (between loadstart and the next playing)', () => {
    document.body.innerHTML = '<video id="v"></video>';
    const v = document.getElementById('v') as HTMLVideoElement;
    stubCurrentSrc(v, 'https://example.com/a.mp4');
    const a = start();

    v.dispatchEvent(new Event('play'));
    v.dispatchEvent(new Event('loadstart'));
    v.dispatchEvent(new Event('playing')); // startup
    events.length = 0;

    // Reload mid-playback (src unchanged, isolating the pause assertion from
    // source_change) — loadstart closes the play span synthetically.
    v.dispatchEvent(new Event('loadstart'));
    expect(events.map((e) => e.type)).toEqual(['pause']);
    events.length = 0;

    // A rotation lands HERE, before the new source's first `playing` —
    // reseed() must not re-announce a play for an element that, per the
    // adapter's own bookkeeping, is not currently playing.
    a.reseed();
    expect(events).toEqual([]);

    // The new source's first playing is still read as startup (fresh span).
    events.length = 0;
    v.dispatchEvent(new Event('playing'));
    expect(events.map((e) => e.type)).toEqual(['startup']);
  });

  it('maps error to el.error.message when present', () => {
    document.body.innerHTML = '<video id="v"></video>';
    start();
    const v = document.getElementById('v') as HTMLVideoElement;
    Object.defineProperty(v, 'error', {
      value: { message: 'boom', code: 3 },
      configurable: true,
    });

    v.dispatchEvent(new Event('error'));

    // Phase 4 widens `error` to carry the native MediaError `code` (1-4) —
    // this fixture already sets code: 3, so the widened payload includes it.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', data: { message: 'boom', code: 3 } }),
    );
  });

  it('falls back to "code N" when el.error has no message', () => {
    document.body.innerHTML = '<video id="v"></video>';
    start();
    const v = document.getElementById('v') as HTMLVideoElement;
    Object.defineProperty(v, 'error', {
      value: { code: 4 },
      configurable: true,
    });

    v.dispatchEvent(new Event('error'));

    // Phase 4 widens `error` to carry the native MediaError `code` (1-4) —
    // this fixture already sets code: 4, so the widened payload includes it.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', data: { message: 'code 4', code: 4 } }),
    );
  });

  it('emits rate_change with the current playbackRate', () => {
    document.body.innerHTML = '<video id="v"></video>';
    start();
    const v = document.getElementById('v') as HTMLVideoElement;
    v.playbackRate = 1.5;

    v.dispatchEvent(new Event('ratechange'));

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'rate_change', data: { rate: 1.5 } }),
    );
  });

  // Reviewer note (task 4 fix round, finding 5): this asserted on `events`,
  // but `source_change` now routes to `lifecycle` — the assertion could
  // never fail against `events` regardless of behaviour. Reads `lifecycle`
  // instead; the intent (same src -> no re-emit) is unchanged.
  it('does not emit source_change when a later loadstart carries the same src', () => {
    document.body.innerHTML = '<video id="v"></video>';
    start();
    const v = document.getElementById('v') as HTMLVideoElement;
    stubCurrentSrc(v, 'https://example.com/a.mp4');
    v.dispatchEvent(new Event('loadstart'));
    lifecycle.length = 0;

    v.dispatchEvent(new Event('loadstart')); // e.g. .load() called again for the same src

    expect(lifecycle.filter((e) => e.type === 'source_change')).toEqual([]);
  });

  // Reviewer note (task 4 fix round, finding 5): renamed from "skips
  // elements without getVideoPlaybackQuality without throwing" — that name
  // is now misleading, since `sampleQuality` DOES emit a `stats` entry for
  // such an element; it just has no droppedFrames delta to report (video
  // playback quality isn't observable), so `droppedFrames` stays at the
  // default 0. The old assertion also checked only `events` — `stats`
  // routes to `lifecycle`, so it could never fail either way.
  it('emits stats with droppedFrames: 0 (no delta) for elements without getVideoPlaybackQuality, without throwing', () => {
    document.body.innerHTML = '<video id="v"></video>';
    const a = start();
    const v = document.getElementById('v') as HTMLVideoElement;
    // Fix wave item 6 — sampleQuality now skips an idle element (no known
    // source, not playing); give this element a source so it's in-scope for
    // the droppedFrames-fallback behaviour this test actually targets.
    stubCurrentSrc(v, 'https://example.com/a.mp4');
    v.dispatchEvent(new Event('loadstart'));
    lifecycle.length = 0;

    expect(() => a.sampleQuality()).not.toThrow();
    expect(events).toEqual([]);
    expect(lifecycle.filter((e) => e.type === 'stats')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ droppedFrames: 0 }) }),
    ]);
  });

  it('detaches listeners when an element is removed from the DOM — no events after', async () => {
    document.body.innerHTML = '<video id="v"></video>';
    start();
    const v = document.getElementById('v') as HTMLVideoElement;

    v.dispatchEvent(new Event('play'));
    expect(events).toHaveLength(1);

    // Codex round-3 finding F2 — detaching a PLAYING element now emits a
    // synthetic `pause` (closing the accumulator's open play span) in
    // addition to unbinding — see the adapter's `unbind`.
    v.remove();
    await flush();
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual(expect.objectContaining({ type: 'pause' }));

    v.dispatchEvent(new Event('play'));

    expect(events).toHaveLength(2); // listeners are gone — this play is never observed
  });

  it('detaches nested media elements when their subtree is removed', async () => {
    const wrapper = document.createElement('div');
    const v = document.createElement('video');
    wrapper.appendChild(v);
    document.body.appendChild(wrapper);
    start();
    await flush();

    v.dispatchEvent(new Event('play'));
    expect(events).toHaveLength(1);

    // Codex round-3 finding F2 — same synthetic-pause-on-detach behavior as
    // the flat-DOM case above, just via subtree removal.
    wrapper.remove();
    await flush();
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual(expect.objectContaining({ type: 'pause' }));

    v.dispatchEvent(new Event('play'));

    expect(events).toHaveLength(2); // listeners are gone — this play is never observed
  });

  it('trackPlayer binds an out-of-scan element and is idempotent on repeated calls', () => {
    const a = start();
    const v = document.createElement('video'); // never inserted — outside the auto-attach scan

    a.trackPlayer(v);
    a.trackPlayer(v);
    a.trackPlayer(v);
    v.dispatchEvent(new Event('play'));

    expect(events.filter((e) => e.type === 'play')).toHaveLength(1);
  });

  // Codex round-2 finding R9 — bind-time seeding. An element already
  // mid-playback at bind time (config resolved after autoplay) must be
  // seeded, not assumed blank: sawFirstFrame from
  // (!paused && readyState >= 3), a synthetic `play` so playtime accrues,
  // and the dropped-frames baseline from the element's OWN current count
  // (not 0).
  it('seeds sawFirstFrame + emits a synthetic play when bound mid-playback', () => {
    document.body.innerHTML = '<video id="v"></video>';
    const v = document.getElementById('v') as HTMLVideoElement;
    Object.defineProperty(v, 'paused', { value: false, configurable: true });
    Object.defineProperty(v, 'readyState', { value: 3, configurable: true });

    start();

    expect(events).toEqual([expect.objectContaining({ type: 'play' })]);

    // No fake startup on the next playing — sawFirstFrame was already seeded true.
    events.length = 0;
    v.dispatchEvent(new Event('playing'));
    expect(events.filter((e) => e.type === 'startup')).toEqual([]);
  });

  // Codex round-3 finding F1 — the bind-time synthetic play must not depend
  // on readyState. Before this fix, an element where `play` already fired
  // but the first frame hasn't arrived yet (paused === false, readyState <
  // 3) got NO synthetic play (gated on the same readyState >= 3 check as
  // sawFirstFrame), so that playback's playtime span never opened and stuck
  // at 0 for as long as it took the first frame to arrive.
  it('emits a synthetic play at bind time even when readyState < 3 (play fired, first frame not yet arrived)', () => {
    document.body.innerHTML = '<video id="v"></video>';
    const v = document.getElementById('v') as HTMLVideoElement;
    Object.defineProperty(v, 'paused', { value: false, configurable: true });
    Object.defineProperty(v, 'readyState', { value: 1, configurable: true }); // HAVE_METADATA only

    start();

    // The synthetic play must fire despite readyState < 3.
    expect(events).toEqual([expect.objectContaining({ type: 'play' })]);

    // sawFirstFrame must still be seeded FALSE (readyState < 3) — the next
    // `playing` (the first frame actually arriving) is startup latency, not
    // a rebuffer recovery.
    events.length = 0;
    v.dispatchEvent(new Event('playing'));
    expect(events.map((e) => e.type)).toEqual(['startup']);
  });

  it('does NOT seed sawFirstFrame or emit a synthetic play for an element that is not yet playing', () => {
    document.body.innerHTML = '<video id="v"></video>';
    const v = document.getElementById('v') as HTMLVideoElement;
    // jsdom defaults: paused=true, readyState=0 — left as-is.
    start();

    expect(events).toEqual([]);

    v.dispatchEvent(new Event('loadstart'));
    v.dispatchEvent(new Event('playing'));
    expect(events.map((e) => e.type)).toEqual(['startup']);
  });

  // Phase 4: `dropped_frames` is no longer emitted at all — the delta rides
  // inside the per-tick `stats` entry instead (see the phase-4 describe
  // block below). This case keeps its original intent — the baseline is
  // seeded from the element's OWN current count at bind time, not 0 — by
  // asserting the first `stats` tick reports `droppedFrames: 0`.
  it('seeds the dropped-frames baseline at bind time, not 0', () => {
    document.body.innerHTML = '<video id="v"></video>';
    const v = document.getElementById('v') as HTMLVideoElement;
    Object.defineProperty(v, 'getVideoPlaybackQuality', {
      value: () => ({ droppedVideoFrames: 42 }), // pre-existing drops before this adapter attached
      configurable: true,
    });

    const a = start();
    // Fix wave item 6 — give this element a source so it's in-scope for
    // sampleQuality's idle-skip guard; the baseline-seeding behaviour this
    // test targets is orthogonal to that guard.
    stubCurrentSrc(v, 'https://example.com/a.mp4');
    v.dispatchEvent(new Event('loadstart'));
    lifecycle.length = 0;

    a.sampleQuality(); // first tick after bind — must see delta 0, not 42

    const stats = lifecycle.filter((e) => e.type === 'stats');
    expect(stats).toHaveLength(1);
    expect(stats[0]?.data?.droppedFrames).toBe(0);
  });

  // Codex round-2 finding R9 — terminal buffer-span closure, centralized.
  it('closes an open buffer span on pause (paused mid-rebuffer, never resumes)', () => {
    let clock = 1000;
    document.body.innerHTML = '<video id="v"></video>';
    start(() => clock);
    const v = document.getElementById('v') as HTMLVideoElement;

    v.dispatchEvent(new Event('loadstart'));
    v.dispatchEvent(new Event('playing')); // startup
    events.length = 0;

    clock = 1200;
    v.dispatchEvent(new Event('waiting'));
    clock = 1450;
    v.dispatchEvent(new Event('pause'));

    expect(events.map((e) => e.type)).toEqual(['buffer_start', 'buffer_end', 'pause']);
    expect(events[1].data).toEqual({ durationMs: 250 });
  });

  it('closes an open buffer span on ended, mapped onto pause semantics', () => {
    let clock = 1000;
    document.body.innerHTML = '<video id="v"></video>';
    start(() => clock);
    const v = document.getElementById('v') as HTMLVideoElement;

    v.dispatchEvent(new Event('loadstart'));
    v.dispatchEvent(new Event('playing')); // startup
    events.length = 0;

    clock = 1200;
    v.dispatchEvent(new Event('waiting'));
    clock = 1500;
    v.dispatchEvent(new Event('ended'));

    // 'ended' has no VitalsPlayerEventType of its own — it maps to 'pause'.
    expect(events.map((e) => e.type)).toEqual(['buffer_start', 'buffer_end', 'pause']);
    expect(events[1].data).toEqual({ durationMs: 300 });
  });

  // Codex round-3 finding F2 — `playing` now marks the element isPlaying
  // (it's the definitive "actively playing" signal, and can fire without a
  // `play` this adapter ever observed — e.g. resuming after a rebuffer), so
  // an `error` while genuinely playing now ALSO closes the play span with a
  // synthetic `pause`, in addition to the pre-existing buffer_end. Before
  // this fix, an error mid-playback left that element's play span open in
  // the accumulator forever.
  it('closes an open buffer span on error, and pauses since the element was playing', () => {
    let clock = 1000;
    document.body.innerHTML = '<video id="v"></video>';
    start(() => clock);
    const v = document.getElementById('v') as HTMLVideoElement;

    v.dispatchEvent(new Event('loadstart'));
    v.dispatchEvent(new Event('playing')); // startup
    events.length = 0;

    clock = 1200;
    v.dispatchEvent(new Event('waiting'));
    clock = 1600;
    v.dispatchEvent(new Event('error'));

    expect(events.map((e) => e.type)).toEqual(['buffer_start', 'buffer_end', 'pause', 'error']);
    expect(events[1].data).toEqual({ durationMs: 400 });
  });

  // Codex round-3 finding F2 — same isPlaying-gated synthetic pause as
  // above: detaching a PLAYING element (not just one mid-rebuffer) must
  // close its play span, or it stays open in the accumulator forever.
  it('closes an open buffer span when the element is detached from the DOM mid-rebuffer, and pauses since it was playing', async () => {
    let clock = 1000;
    document.body.innerHTML = '<video id="v"></video>';
    start(() => clock);
    const v = document.getElementById('v') as HTMLVideoElement;

    v.dispatchEvent(new Event('loadstart'));
    v.dispatchEvent(new Event('playing')); // startup
    events.length = 0;

    clock = 1200;
    v.dispatchEvent(new Event('waiting'));
    clock = 1800;
    v.remove();
    await flush();

    expect(events.map((e) => e.type)).toEqual(['buffer_start', 'buffer_end', 'pause']);
    expect(events[1].data).toEqual({ durationMs: 600 });
  });

  // Codex round-3 finding F2 — stop() unbinds every tracked element, so a
  // playing element must get the same synthetic pause treatment.
  it('closes an open buffer span when the adapter stops mid-rebuffer, and pauses since it was playing', () => {
    let clock = 1000;
    document.body.innerHTML = '<video id="v"></video>';
    const a = start(() => clock);
    const v = document.getElementById('v') as HTMLVideoElement;

    v.dispatchEvent(new Event('loadstart'));
    v.dispatchEvent(new Event('playing')); // startup
    events.length = 0;

    clock = 1200;
    v.dispatchEvent(new Event('waiting'));
    clock = 1900;
    a.stop();
    adapter = undefined; // already stopped — afterEach should not double-stop

    expect(events.map((e) => e.type)).toEqual(['buffer_start', 'buffer_end', 'pause']);
    expect(events[1].data).toEqual({ durationMs: 700 });
  });

  // Codex round-3 finding F2 — plain (not mid-rebuffer) cases: `ended`/
  // `error` while genuinely playing must close the play span with a
  // synthetic pause even with no buffer span involved at all.
  it('emits a synthetic pause on ended while playing (no rebuffer involved)', () => {
    document.body.innerHTML = '<video id="v"></video>';
    start();
    const v = document.getElementById('v') as HTMLVideoElement;

    v.dispatchEvent(new Event('play'));
    events.length = 0;

    v.dispatchEvent(new Event('ended'));

    expect(events.map((e) => e.type)).toEqual(['pause']);
  });

  it('does NOT emit a synthetic pause on ended when the element was already paused', () => {
    document.body.innerHTML = '<video id="v"></video>';
    start();
    const v = document.getElementById('v') as HTMLVideoElement;

    // No 'play' ever dispatched — isPlaying stays false the whole time.
    v.dispatchEvent(new Event('ended'));

    expect(events).toEqual([]);
  });

  it('emits a synthetic pause on error while playing (no rebuffer involved)', () => {
    document.body.innerHTML = '<video id="v"></video>';
    start();
    const v = document.getElementById('v') as HTMLVideoElement;

    v.dispatchEvent(new Event('play'));
    events.length = 0;

    v.dispatchEvent(new Event('error'));

    expect(events.map((e) => e.type)).toEqual(['pause', 'error']);
  });

  it('emits a synthetic pause on detach while playing (no rebuffer involved)', async () => {
    document.body.innerHTML = '<video id="v"></video>';
    start();
    const v = document.getElementById('v') as HTMLVideoElement;

    v.dispatchEvent(new Event('play'));
    events.length = 0;

    v.remove();
    await flush();

    expect(events.map((e) => e.type)).toEqual(['pause']);
  });

  // Codex round-3 finding F3 — reseed() re-emits ongoing per-element state
  // (playing, buffering) so a fresh accumulator after a rotation isn't
  // blind to playback/buffering that started under the OLD session and is
  // still ongoing.
  describe('reseed()', () => {
    it('emits play for a playing element and play + buffer_start for one that is playing AND buffering', () => {
      document.body.innerHTML = '<video id="a"></video><video id="b"></video>';
      const a = start();
      const va = document.getElementById('a') as HTMLVideoElement;
      const vb = document.getElementById('b') as HTMLVideoElement;

      va.dispatchEvent(new Event('play'));
      vb.dispatchEvent(new Event('loadstart'));
      vb.dispatchEvent(new Event('playing')); // startup — first frame; isPlaying=true
      // `waiting` stalls playback but does NOT pause the element (.paused
      // stays false) — vb is simultaneously still-playing AND buffering.
      vb.dispatchEvent(new Event('waiting')); // opens a buffer span
      events.length = 0;

      a.reseed();

      // One `play` per genuinely-playing element (va, vb) plus one
      // `buffer_start` for vb's still-open buffer span.
      expect(events).toHaveLength(3);
      expect(events.filter((e) => e.type === 'play')).toHaveLength(2);
      expect(events.filter((e) => e.type === 'buffer_start')).toHaveLength(1);
    });

    it('restarts the buffer span timestamp at reseed time, not the original buffer_start time', () => {
      let clock = 1000;
      document.body.innerHTML = '<video id="v"></video>';
      const a = start(() => clock);
      const v = document.getElementById('v') as HTMLVideoElement;

      v.dispatchEvent(new Event('loadstart'));
      v.dispatchEvent(new Event('playing')); // startup
      clock = 1200;
      v.dispatchEvent(new Event('waiting')); // buffer span opened at t=1200
      events.length = 0;

      clock = 5000; // the new session starts long after the old span opened
      a.reseed();
      expect(events).toEqual([
        expect.objectContaining({ type: 'play', t: 5000 }),
        expect.objectContaining({ type: 'buffer_start', t: 5000 }),
      ]);

      events.length = 0;
      clock = 5300;
      v.dispatchEvent(new Event('playing')); // closes the (re-seeded) span

      expect(events).toEqual([
        expect.objectContaining({ type: 'buffer_end', data: { durationMs: 300 } }),
      ]);
    });

    it('emits nothing for an idle (not playing, not buffering) element', () => {
      document.body.innerHTML = '<video id="v"></video>';
      const a = start();

      a.reseed();

      expect(events).toEqual([]);
    });
  });

  // Codex round-4 — two interlocking findings, one unified fix:
  //   1. Reseed double-counts the rotation trigger: a native event (`play` or
  //      `waiting`) that itself crosses the collector's idle/max-age boundary
  //      triggers a SYNCHRONOUS `onRotate` -> `reseed()` nested inside that
  //      same emit's call chain. The old code flipped the element's
  //      isPlaying/buffering flag to true BEFORE calling emit, so reseed's
  //      nested read saw the transition as already-applied and re-announced
  //      it a second time into the brand-new session.
  //   2. Unconditional native emits: bind-time seeding (or a real close) can
  //      leave the adapter's per-element flag already at the value a queued
  //      native event is about to redundantly re-assert; the old handlers
  //      emitted regardless of the current flag.
  // `setPlaying`/`setBuffering` in player-adapter.ts fix both: transition-
  // gated (no-op unless the value is actually changing) and — for the
  // OPENING direction only — emit-before-flip so a reentrant reseed() sees
  // the pre-transition (false) value and skips re-announcing.
  describe('Codex round-4 — transition-gated state (no reseed double-count, no unconditional re-emit)', () => {
    /** Wires a REAL VitalsCollector to a REAL attachPlayerVitals adapter so a
     *  rotation's synchronous onRotate -> reseed() path is exercised exactly
     *  as it runs in production (packages/sdk-web/src/vitals/index.ts), not
     *  simulated via a mock. `clockRef` lets the test drive both the
     *  adapter's and the collector's `now()` in lockstep. */
    function makeWiredCollector(clockRef: { t: number }) {
      const sent: Array<{ body: Record<string, unknown>; beacon: boolean }> = [];
      // Phase 4: `attachPlayerVitals` now emits `player_attach` SYNCHRONOUSLY
      // during construction (the initial DOM scan binds every already-present
      // element before the constructor returns) — so `collector` must exist
      // BEFORE `attachPlayerVitals` is called, not after. `a` is hoisted the
      // same way for the symmetric `onRotate` dependency; that closure is
      // only ever invoked later; on a rotation, never during construction.
      let a!: PlayerVitalsAdapter;
      let n = 0;
      const collector = createVitalsCollector({
        dims: { platform: 'web', appVersion: '1', sdkVersion: '1' },
        now: () => clockRef.t,
        send: (body, opts) => sent.push({ body: body as Record<string, unknown>, beacon: opts.beacon }),
        newSessionId: () => `session-${n++}`,
        maxIdleMs: 100,
        onRotate: () => a.reseed(),
      });
      a = attachPlayerVitals({
        onEvent: (e) => collector.recordPlayerEvent(e),
        now: () => clockRef.t,
      });
      return { adapter: a, collector, sent };
    }

    function lastFinalSummary(sent: Array<{ body: Record<string, unknown> }>): Record<string, unknown> {
      const finals = sent.filter((s) => s.body.kind === 'summary' && s.body.final === true);
      return finals[finals.length - 1]!.body;
    }

    it('a play entry that triggers rotation is recorded exactly once — a 10ms span reports 10ms, not 20ms', () => {
      document.body.innerHTML = '<video id="v"></video>';
      const v = document.getElementById('v') as HTMLVideoElement;
      const clockRef = { t: 0 };
      const { adapter: a, collector, sent } = makeWiredCollector(clockRef);
      adapter = a;

      // First play/pause cycle — establishes lastEntryAt and closes cleanly.
      v.dispatchEvent(new Event('play'));
      clockRef.t = 10;
      v.dispatchEvent(new Event('pause'));

      // Idle gap of 190ms > maxIdleMs(100) — this `play` IS the rotation
      // trigger, landing in the brand-new session's accumulator.
      const firstSessionId = collector.sessionId;
      clockRef.t = 200;
      v.dispatchEvent(new Event('play'));
      expect(collector.sessionId).not.toBe(firstSessionId);

      clockRef.t = 210;
      v.dispatchEvent(new Event('pause'));

      // The new session's ring (cleared on rotation) must hold exactly ONE
      // `play` for this element — reseed() must not have re-announced it.
      const newSessionEntries = collector.recent();
      expect(
        newSessionEntries.filter((e) => e.kind === 'player' && e.type === 'play'),
      ).toHaveLength(1);

      collector.stop();
      const finalSummary = lastFinalSummary(sent);
      expect(finalSummary.sessionId).toBe(collector.sessionId);
      expect(finalSummary.playtimeMs).toBe(10);
    });

    it('a waiting entry that triggers rotation opens exactly one buffer span — a 50ms rebuffer reports 50ms, not 100ms', () => {
      document.body.innerHTML = '<video id="v"></video>';
      const v = document.getElementById('v') as HTMLVideoElement;
      const clockRef = { t: 0 };
      const { adapter: a, collector, sent } = makeWiredCollector(clockRef);
      adapter = a;

      v.dispatchEvent(new Event('loadstart'));
      v.dispatchEvent(new Event('playing')); // startup — first frame; establishes lastEntryAt=0

      // Idle gap of 200ms > maxIdleMs(100) — this `waiting` IS the rotation
      // trigger.
      const firstSessionId = collector.sessionId;
      clockRef.t = 200;
      v.dispatchEvent(new Event('waiting'));
      expect(collector.sessionId).not.toBe(firstSessionId);

      clockRef.t = 250; // 50ms rebuffer
      v.dispatchEvent(new Event('playing')); // closes the span

      const newSessionEntries = collector.recent();
      expect(
        newSessionEntries.filter((e) => e.kind === 'player' && e.type === 'buffer_start'),
      ).toHaveLength(1);

      collector.stop();
      const finalSummary = lastFinalSummary(sent);
      expect(finalSummary.sessionId).toBe(collector.sessionId);
      expect(finalSummary.rebufferDurationMs).toBe(50);
    });

    it('bind seeding then a queued native play event emits exactly one play', () => {
      document.body.innerHTML = '<video id="v"></video>';
      const v = document.getElementById('v') as HTMLVideoElement;
      Object.defineProperty(v, 'paused', { value: false, configurable: true });
      Object.defineProperty(v, 'readyState', { value: 3, configurable: true });

      start();
      expect(events.filter((e) => e.type === 'play')).toHaveLength(1); // bind-time synthetic

      // The native `play` event already queued before this adapter attached
      // fires now — must be absorbed as a no-op, not a second `play`.
      v.dispatchEvent(new Event('play'));

      expect(events.filter((e) => e.type === 'play')).toHaveLength(1);
    });

    it('a stray native pause for an element already paused at bind emits nothing (no cross-player decrement)', () => {
      document.body.innerHTML = '<video id="v"></video>';
      const v = document.getElementById('v') as HTMLVideoElement;
      // jsdom defaults: paused=true — isPlayingAtBind=false, isPlaying starts false.
      start();
      expect(events).toEqual([]);

      // A native `pause` queued before bind (or firing redundantly) dispatches
      // now — must not emit, since this element was never marked playing.
      v.dispatchEvent(new Event('pause'));

      expect(events).toEqual([]);
    });
  });

  it('clamps ttffMs to 0 on a backwards clock (playing before loadstart’s own timestamp)', () => {
    let clock = 1000;
    document.body.innerHTML = '<video id="v"></video>';
    start(() => clock);
    const v = document.getElementById('v') as HTMLVideoElement;

    clock = 2000;
    v.dispatchEvent(new Event('loadstart')); // loadStartT = 2000
    clock = 1500; // backwards jump
    v.dispatchEvent(new Event('playing')); // ttffMs would be -500 unclamped

    expect(events.map((e) => e.type)).toEqual(['startup']);
    expect(events[0].data).toEqual({ ttffMs: 0 });
  });

  it('stop() disconnects the observer and removes all listeners', async () => {
    document.body.innerHTML = '<video id="v"></video>';
    const a = start();
    const v = document.getElementById('v') as HTMLVideoElement;

    a.stop();
    adapter = undefined; // already stopped — afterEach should not double-stop

    v.dispatchEvent(new Event('play'));
    expect(events).toEqual([]);

    const v2 = document.createElement('video');
    document.body.appendChild(v2);
    await flush();
    v2.dispatchEvent(new Event('play'));

    expect(events).toEqual([]);
  });

  describe('phase 4 — identity, payloads, stats, integrations', () => {
    function fakeIntegration(over: Partial<PlayerIntegration> & { onAttach?: (ctx: PlayerIntegrationContext) => void } = {}) {
      let ctx: PlayerIntegrationContext | undefined;
      const integ: PlayerIntegration & { ctx: () => PlayerIntegrationContext | undefined; detached: number } = {
        library: 'fake', version: '9.9', detached: 0,
        attach(c) { ctx = c; over.onAttach?.(c); },
        detach() { integ.detached++; },
        ctx: () => ctx,
        ...over,
      };
      return integ;
    }

    it('stamps a stable playerId on every event and emits player_attach at bind', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start();
      const v = document.getElementById('v') as HTMLVideoElement;
      v.dispatchEvent(new Event('play'));
      expect(lifecycle[0]).toEqual(expect.objectContaining({ type: 'player_attach', playerId: 'p1', data: { tag: 'video', library: 'native' } }));
      expect(events).toEqual([expect.objectContaining({ type: 'play', playerId: 'p1' })]);
    });

    // Codex round-3 item 6 — a repeat trackPlayer() re-emitted player_attach
    // only when the INTEGRATION changed, never for a name-only upgrade. Auto-
    // attach binding a native element before trackPlayer({element, name})
    // resolves — exactly what the React hook and the example app do — used
    // to leave the admin timeline showing that player as unnamed for the
    // whole session.
    it('re-emits player_attach when a repeat trackPlayer() supplies only a new name (no integration change)', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start(); // auto-attach binds it bare, unnamed, native
      const v = document.getElementById('v') as HTMLVideoElement;
      expect(lifecycle.filter((e) => e.type === 'player_attach')).toEqual([
        expect.objectContaining({ playerId: 'p1', data: { tag: 'video', library: 'native' } }),
      ]);

      adapter!.trackPlayer(v, { name: 'main' });

      expect(lifecycle.filter((e) => e.type === 'player_attach')).toEqual([
        expect.objectContaining({ playerId: 'p1', data: { tag: 'video', library: 'native' } }),
        expect.objectContaining({ playerId: 'p1', data: { name: 'main', tag: 'video', library: 'native' } }),
      ]);
    });

    it('does not re-emit player_attach for a repeat trackPlayer() that supplies the SAME name again', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start();
      const v = document.getElementById('v') as HTMLVideoElement;
      adapter!.trackPlayer(v, { name: 'main' });
      const before = lifecycle.filter((e) => e.type === 'player_attach').length;

      adapter!.trackPlayer(v, { name: 'main' });

      expect(lifecycle.filter((e) => e.type === 'player_attach')).toHaveLength(before);
    });

    it('uses deps.playerIdFor as the id authority', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start(undefined, { playerIdFor: () => 'reg-7' });
      expect(lifecycle[0]).toEqual(expect.objectContaining({ type: 'player_attach', playerId: 'reg-7' }));
    });

    it('binds deps.registered players (with name + integration) BEFORE the DOM scan', () => {
      document.body.innerHTML = '<video id="a"></video><video id="b"></video>';
      const b = document.getElementById('b') as HTMLVideoElement;
      const integ = fakeIntegration();
      start(undefined, { registered: [{ element: b, name: 'pip', integration: integ }] });
      expect(lifecycle[0]).toEqual(expect.objectContaining({ playerId: 'p1', type: 'player_attach', data: { name: 'pip', tag: 'video', library: 'fake', libraryVersion: '9.9' } }));
      expect(lifecycle[1]).toEqual(expect.objectContaining({ playerId: 'p2', type: 'player_attach' }));
      expect(integ.ctx()?.element).toBe(b);
    });

    // Codex round-5 item 2 (safety-net half) — `vitals/index.ts`'s own
    // `trackPlayer()` now rejects a non-element before it ever reaches a
    // registry (the honest-contract half of this same item, tested in
    // wiring.spec.ts), but this constructor must not depend on every caller
    // enforcing that: a malformed `registered` entry reaching
    // `attachPlayerVitals` directly (exactly what this test does) used to
    // throw out of `bind()` (a fake element has no `addEventListener`),
    // aborting the ENTIRE construction — the OTHER, perfectly valid
    // registration below it, and the DOM scan after the loop, never ran at
    // all. One bad registration must not cost every other player its
    // telemetry.
    it('one malformed deps.registered entry does not abort construction — other registrations and the DOM scan still bind', () => {
      // `explicit` is a real element ONLY reachable via `deps.registered`;
      // `scanned` is a real element ONLY reachable via the DOM scan that
      // runs AFTER that registered-list loop. Both binding proves the loop
      // survived the bad entry AND that `attachPlayerVitals` itself
      // returned normally (a throw escaping the loop would abort the scan
      // too, since it runs later in the same function body).
      document.body.innerHTML = '<video id="explicit"></video><video id="scanned"></video>';
      const explicitEl = document.getElementById('explicit') as HTMLVideoElement;
      const bad = {} as HTMLMediaElement; // no addEventListener — bind() would throw
      expect(() =>
        start(undefined, {
          registered: [{ element: bad, name: 'broken' }, { element: explicitEl, name: 'ok' }],
        }),
      ).not.toThrow();
      // `bad` itself gets a player_attach too — `emitAttach` runs BEFORE
      // the `on('loadstart', ...)` call that actually throws, and JS
      // doesn't roll back side effects on a later exception — harmless
      // noise this test doesn't care about. What matters: the explicit
      // registration AFTER the bad one in the loop still bound (proof the
      // loop didn't abort), AND the DOM scan that runs AFTER the whole
      // loop still ran and bound `scanned` (proof the throw never escaped
      // `attachPlayerVitals` itself — an escape would have skipped
      // everything after the loop, including that scan).
      const videoAttaches = lifecycle.filter((e) => e.type === 'player_attach' && e.data?.tag === 'video');
      expect(videoAttaches).toHaveLength(2);
      expect(videoAttaches.some((e) => e.data?.name === 'ok')).toBe(true);
      expect(videoAttaches.some((e) => e.data?.name === undefined)).toBe(true); // the scanned element
    });

    it('emits source_change WITH a sanitised payload on the first loadstart that carries a src, and on a later change, not on a repeat', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start();
      const v = document.getElementById('v') as HTMLVideoElement;
      stubCurrentSrc(v, 'https://cdn.example.com/a.m3u8?token=1');
      v.dispatchEvent(new Event('loadstart'));
      v.dispatchEvent(new Event('loadstart'));
      stubCurrentSrc(v, 'https://cdn.example.com/b.mp4');
      v.dispatchEvent(new Event('loadstart'));
      expect(lifecycle.filter((e) => e.type === 'source_change')).toEqual([
        expect.objectContaining({ data: { src: 'https://cdn.example.com/a.m3u8', protocol: 'hls' } }),
        expect.objectContaining({ data: { src: 'https://cdn.example.com/b.mp4', protocol: 'progressive' } }),
      ]);
    });

    it('keeps the query string when keepSourceQuery is set', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start(undefined, { keepSourceQuery: true });
      const v = document.getElementById('v') as HTMLVideoElement;
      stubCurrentSrc(v, 'https://cdn.example.com/a.m3u8?token=1');
      v.dispatchEvent(new Event('loadstart'));
      expect(lifecycle.at(-1)?.data?.src).toBe('https://cdn.example.com/a.m3u8?token=1');
    });

    it('emits source_change at bind when the element already has a src, with the <source type> as mime', () => {
      document.body.innerHTML = '<video id="v"><source src="/clip.webm" type="video/webm"></video>';
      const v = document.getElementById('v') as HTMLVideoElement;
      stubCurrentSrc(v, new URL('/clip.webm', document.baseURI).href);
      start();
      expect(lifecycle[1]).toEqual(expect.objectContaining({ type: 'source_change', data: expect.objectContaining({ protocol: 'progressive', mime: 'video/webm' }) }));
    });

    it('emits quality_change on resize when the dimensions change (native only)', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start();
      const v = document.getElementById('v') as HTMLVideoElement;
      Object.defineProperty(v, 'videoWidth', { value: 1280, configurable: true });
      Object.defineProperty(v, 'videoHeight', { value: 720, configurable: true });
      v.dispatchEvent(new Event('resize'));
      v.dispatchEvent(new Event('resize')); // same dims — nothing
      expect(lifecycle.filter((e) => e.type === 'quality_change')).toEqual([expect.objectContaining({ data: { width: 1280, height: 720 } })]);
    });

    it('sampleQuality emits one stats entry per player with bufferAheadMs, droppedFrames delta and the integration snapshot; never dropped_frames', () => {
      document.body.innerHTML = '<video id="v"></video>';
      const v = document.getElementById('v') as HTMLVideoElement;
      let dropped = 42;
      Object.defineProperty(v, 'getVideoPlaybackQuality', { value: () => ({ droppedVideoFrames: dropped }), configurable: true });
      Object.defineProperty(v, 'currentTime', { value: 10, configurable: true });
      Object.defineProperty(v, 'buffered', { value: { length: 1, start: () => 0, end: () => 22.5 }, configurable: true });
      const integ = fakeIntegration({
        // Fix wave item 6 — sampleQuality skips a player with no known
        // source that isn't playing; a real integration always reports
        // source_change at/near attach (see hls.ts/shaka.ts's late-attach
        // paths), so mirror that here rather than leave this element
        // looking idle.
        onAttach: (ctx) => ctx.emit('source_change', { src: 'https://cdn.example.com/x.m3u8', protocol: 'hls' }),
        snapshot: () => ({ bitrate: 3_000_000, width: 1920, height: 1080, bandwidthEstimate: 8_000_000 }),
      });
      start();
      adapter!.trackPlayer(v, { integration: integ });
      adapter!.sampleQuality();
      dropped = 45;
      adapter!.sampleQuality();
      const stats = lifecycle.filter((e) => e.type === 'stats');
      expect(stats).toEqual([
        expect.objectContaining({ playerId: 'p1', data: { bufferAheadMs: 12500, droppedFrames: 0, bitrate: 3_000_000, width: 1920, height: 1080, bandwidthEstimate: 8_000_000 } }),
        expect.objectContaining({ data: expect.objectContaining({ droppedFrames: 3 }) }),
      ]);
      expect(all.some((e) => e.type === 'dropped_frames')).toBe(false);
    });

    // Fix wave item 6 — an element with no known source that isn't playing
    // is idle (an unbound <video> on a media-heavy page); a `stats` entry
    // for it every tick is noise that crowds the report-enrichment tail
    // the play/error events an operator reads compete for.
    it('sampleQuality skips an idle player: no known source and not playing', () => {
      document.body.innerHTML = '<video id="v"></video>';
      const a = start();
      a.sampleQuality();
      expect(lifecycle.filter((e) => e.type === 'stats')).toEqual([]);
    });

    it('sampleQuality does NOT skip a playing element even with no known source yet', () => {
      document.body.innerHTML = '<video id="v"></video>';
      const v = document.getElementById('v') as HTMLVideoElement;
      const a = start();
      v.dispatchEvent(new Event('play'));
      lifecycle.length = 0;
      a.sampleQuality();
      expect(lifecycle.filter((e) => e.type === 'stats')).toHaveLength(1);
    });

    it('sampleQuality does NOT skip a player with a known source that is currently paused', () => {
      document.body.innerHTML = '<video id="v"></video>';
      const v = document.getElementById('v') as HTMLVideoElement;
      const a = start();
      stubCurrentSrc(v, 'https://example.com/a.mp4');
      v.dispatchEvent(new Event('loadstart'));
      lifecycle.length = 0;
      a.sampleQuality();
      expect(lifecycle.filter((e) => e.type === 'stats')).toHaveLength(1);
    });

    it('upgrades an auto-attached element in place: same id, integration attached, one more player_attach with the new library', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start();
      const v = document.getElementById('v') as HTMLVideoElement;
      const integ = fakeIntegration({ library: 'hls.js' });
      const id = adapter!.trackPlayer(v, { name: 'main', integration: integ });
      expect(id).toBe('p1');
      const attaches = lifecycle.filter((e) => e.type === 'player_attach');
      expect(attaches).toHaveLength(2);
      expect(attaches[1]).toEqual(expect.objectContaining({ playerId: 'p1', data: expect.objectContaining({ name: 'main', library: 'hls.js' }) }));
      expect(integ.ctx()?.element).toBe(v);
    });

    // Fix round finding 6 — an `attach()` that throws PARTWAY may already
    // have registered listeners on the player library before failing;
    // `startIntegration`'s catch must clean those up (best-effort) AND the
    // adapter must fall back to working native-only, not get stuck with a
    // half-attached, since-cleared integration. Both halves asserted: the
    // cleanup (`detach()` called once), and that native behaviour resumes
    // (`quality_change`, suppressed only while `s.integration` is set, fires
    // again once the failed integration is cleared).
    it('best-effort detaches an integration whose attach() throws partway, and the player falls back to native', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start();
      const v = document.getElementById('v') as HTMLVideoElement;
      let registeredOnLibrary = false;
      let detachCalls = 0;
      const throwingIntegration: PlayerIntegration = {
        library: 'broken',
        attach() {
          // Stands in for a real integration having already wired a
          // listener onto the player library before the rest of attach()
          // blows up.
          registeredOnLibrary = true;
          throw new Error('attach blew up partway through');
        },
        detach() {
          detachCalls++;
        },
      };

      adapter!.trackPlayer(v, { integration: throwingIntegration });

      expect(registeredOnLibrary).toBe(true);
      expect(detachCalls).toBe(1); // best-effort cleanup of whatever attach() had already registered

      // Native fallback: quality_change fires again now that the failed
      // integration was cleared — it's suppressed only while `s.integration`
      // is set (see the native `resize` listener's own guard).
      Object.defineProperty(v, 'videoWidth', { value: 640, configurable: true });
      Object.defineProperty(v, 'videoHeight', { value: 360, configurable: true });
      v.dispatchEvent(new Event('resize'));
      expect(lifecycle.filter((e) => e.type === 'quality_change')).toEqual([
        expect.objectContaining({ data: { width: 640, height: 360 } }),
      ]);
    });

    // Fix wave item 5 — the SECOND way an integration can fail to
    // subscribe: not by throwing, but by returning `false` from `attach()`
    // (the documented signal for "this instance doesn't look like the
    // library it claims to be", e.g. hls.ts/shaka.ts's own duck-type
    // guards). Same degrade-to-native contract as the throwing case above:
    // best-effort detach, and element-derived source_change resumes instead
    // of the player staying permanently silent under a `library: 'hls.js'`
    // label.
    it('degrades to native when attach() returns false (wrong-instance duck-type check), and native source_change resumes', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start();
      const v = document.getElementById('v') as HTMLVideoElement;
      let detachCalls = 0;
      const wrongInstanceIntegration: PlayerIntegration = {
        library: 'hls.js',
        attach() {
          return false; // e.g. the object has no .on/.off methods
        },
        detach() {
          detachCalls++;
        },
      };

      adapter!.trackPlayer(v, { integration: wrongInstanceIntegration });

      expect(detachCalls).toBe(1); // best-effort cleanup, same as the throwing case

      stubCurrentSrc(v, 'https://example.com/a.mp4');
      v.dispatchEvent(new Event('loadstart'));
      expect(lifecycle.filter((e) => e.type === 'source_change')).toEqual([
        expect.objectContaining({ data: { src: 'https://example.com/a.mp4', protocol: 'progressive' } }),
      ]);
    });

    // Codex round-1 item 7 — the FIRST player_attach (emitted before
    // attach() runs) already claimed the requested library. Without a
    // correction, the session collects native facts while the admin card
    // still says 'hls.js' forever. A degraded integration must emit a
    // SECOND, corrected player_attach naming 'native'.
    it('emits a corrected native player_attach when attach() returns false (degraded integration)', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start();
      const v = document.getElementById('v') as HTMLVideoElement;
      const wrongInstanceIntegration: PlayerIntegration = {
        library: 'hls.js',
        attach() { return false; },
        detach() {},
      };

      adapter!.trackPlayer(v, { integration: wrongInstanceIntegration });

      expect(lifecycle.filter((e) => e.type === 'player_attach').map((e) => e.data?.library)).toEqual([
        'native', // start()'s initial auto-attach scan, before trackPlayer() upgrades it
        'hls.js', // the upgrade's initial, since-rejected claim
        'native', // codex round-1 item 7's correction
      ]);
    });

    it('emits a corrected native player_attach when attach() throws partway', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start();
      const v = document.getElementById('v') as HTMLVideoElement;
      const throwingIntegration: PlayerIntegration = {
        library: 'shaka',
        attach() { throw new Error('attach blew up partway through'); },
        detach() {},
      };

      adapter!.trackPlayer(v, { integration: throwingIntegration });

      expect(lifecycle.filter((e) => e.type === 'player_attach').map((e) => e.data?.library)).toEqual([
        'native', // start()'s initial auto-attach scan, before trackPlayer() upgrades it
        'shaka',
        'native',
      ]);
    });

    // Same correction on the upgrade path (an existing native player later
    // upgraded to a rejected integration), not just the fresh-bind path.
    it('emits a corrected native player_attach when an UPGRADE integration is degraded', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start();
      const v = document.getElementById('v') as HTMLVideoElement;
      adapter!.trackPlayer(v); // native bind first
      lifecycle.length = 0;

      const wrongInstanceIntegration: PlayerIntegration = {
        library: 'hls.js',
        attach() { return false; },
        detach() {},
      };
      adapter!.trackPlayer(v, { integration: wrongInstanceIntegration });

      expect(lifecycle.filter((e) => e.type === 'player_attach').map((e) => e.data?.library)).toEqual([
        'hls.js',
        'native',
      ]);
    });

    // Codex round-2 item 5 — `integration.library`/`.version` are read
    // BEFORE the guarded `attach()` ever runs (they're needed for the
    // `player_attach` this function emits regardless of whether attach()
    // succeeds), so a throwing metadata GETTER used to escape straight out
    // of `bind()`/`upgrade()` with the element's state already inserted and
    // `s.integration` already set — permanently suppressing native
    // source/resize collection with no `attach()` ever having run to
    // trigger the existing degrade-and-correct path. This asserts the fix
    // on the fresh-bind path: exactly one `player_attach`, naming 'native',
    // and native source_change resumes immediately.
    it('degrades to native when an integration metadata getter throws, and native source_change resumes', () => {
      const a = start();
      const v = document.createElement('video'); // never inserted — outside the auto-attach scan, so trackPlayer below is a genuinely FRESH bind()
      let detachCalls = 0;
      const poisoned: PlayerIntegration = {
        get library(): string { throw new Error('metadata boom'); },
        attach() { return true; },
        detach() { detachCalls++; },
      };

      const id = a.trackPlayer(v, { integration: poisoned });

      expect(id).toBe('p1');
      // attach() must never have run — the poisoned metadata read happens
      // before it — but the best-effort cleanup still fires, same as every
      // other degrade path in this file.
      expect(detachCalls).toBe(1);
      expect(lifecycle.filter((e) => e.type === 'player_attach')).toEqual([
        expect.objectContaining({ data: { tag: 'video', library: 'native' } }),
      ]);

      stubCurrentSrc(v, 'https://example.com/a.mp4');
      v.dispatchEvent(new Event('loadstart'));
      expect(lifecycle.filter((e) => e.type === 'source_change')).toEqual([
        expect.objectContaining({ data: { src: 'https://example.com/a.mp4', protocol: 'progressive' } }),
      ]);
    });

    // Same defensive read on the UPGRADE path (an existing native player
    // later upgraded to a poisoned integration), not just fresh-bind.
    it('degrades to native when an UPGRADE integration\'s metadata getter throws', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start();
      const v = document.getElementById('v') as HTMLVideoElement;
      adapter!.trackPlayer(v); // native bind first
      lifecycle.length = 0;

      const poisoned: PlayerIntegration = {
        get version(): string { throw new Error('metadata boom'); },
        library: 'hls.js',
        attach() { return true; },
        detach() {},
      };
      adapter!.trackPlayer(v, { integration: poisoned });

      expect(lifecycle.filter((e) => e.type === 'player_attach').map((e) => e.data?.library)).toEqual(['native']);
    });

    // Codex round-2 item 11 — `library`/`libraryVersion` are foreign,
    // integration-supplied strings with no length limit of their own; the
    // spec caps `library` at 32 chars. An oversized value would otherwise
    // inflate every `player_attach` and, via the recent ring, every
    // enriched report until it expires.
    it('coerces and caps integration library/version at the documented 32-char limit', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start();
      const v = document.getElementById('v') as HTMLVideoElement;
      const longLibrary = 'l'.repeat(100);
      const longVersion = 'v'.repeat(100);
      adapter!.trackPlayer(v, {
        integration: { library: longLibrary, version: longVersion, attach: () => true, detach() {} },
      });
      const attachEvent = lifecycle.find((e) => e.type === 'player_attach' && e.data?.library !== 'native');
      expect(attachEvent?.data?.library).toBe('l'.repeat(MAX_PLAYER_LIBRARY_LENGTH));
      expect(attachEvent?.data?.libraryVersion).toBe('v'.repeat(MAX_PLAYER_LIBRARY_LENGTH));
    });

    it('suppresses element-level source_change while an integration is attached and sanitises the integration\'s own source_change', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start();
      const v = document.getElementById('v') as HTMLVideoElement;
      const integ = fakeIntegration();
      adapter!.trackPlayer(v, { integration: integ });
      stubCurrentSrc(v, 'blob:https://app/xyz');
      v.dispatchEvent(new Event('loadstart'));
      integ.ctx()!.emit('source_change', { src: 'https://cdn.example.com/m.m3u8?sig=1', protocol: 'hls', live: true });
      expect(lifecycle.filter((e) => e.type === 'source_change')).toEqual([
        expect.objectContaining({ playerId: 'p1', data: { src: 'https://cdn.example.com/m.m3u8', protocol: 'hls', live: true } }),
      ]);
    });

    it('merges integration.startupTimings() into the startup event', () => {
      let clock = 1000;
      document.body.innerHTML = '<video id="v"></video>';
      start(() => clock);
      const v = document.getElementById('v') as HTMLVideoElement;
      adapter!.trackPlayer(v, { integration: fakeIntegration({ startupTimings: () => ({ manifestMs: 80, firstFragmentMs: 300 }) }) });
      v.dispatchEvent(new Event('loadstart'));
      clock = 1500;
      v.dispatchEvent(new Event('playing'));
      expect(events.find((e) => e.type === 'startup')?.data).toEqual({ ttffMs: 500, manifestMs: 80, firstFragmentMs: 300 });
    });

    it('caps non-fatal integration errors at 10 per minute per player; fatal ones always pass', () => {
      let clock = 0;
      document.body.innerHTML = '<video id="v"></video>';
      start(() => clock);
      const v = document.getElementById('v') as HTMLVideoElement;
      const integ = fakeIntegration();
      adapter!.trackPlayer(v, { integration: integ });
      for (let i = 0; i < 15; i++) integ.ctx()!.emit('error', { message: 'frag retry', fatal: false });
      integ.ctx()!.emit('error', { message: 'boom', fatal: true });
      clock = 61_000;
      integ.ctx()!.emit('error', { message: 'later', fatal: false });
      const errs = events.filter((e) => e.type === 'error');
      expect(errs).toHaveLength(12);
      expect(errs[10]?.data?.fatal).toBe(true);
      expect(errs[11]?.data?.message).toBe('later');
    });

    // Fix round finding 1 — `PlayerEmit`'s `data` is `Record<string,
    // unknown>`, so an integration that omits `fatal` entirely (rather than
    // setting it false) must still be rate-limited: unlabelled is the same
    // as non-fatal, both as the safe default and as what the field means.
    // Before the fix (`data?.fatal === false`), an omitted key bypassed the
    // cap outright — exactly the unbounded-flood the cap exists to prevent.
    it('rate-limits an integration error with no fatal key at all, same as an explicit fatal: false', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start();
      const v = document.getElementById('v') as HTMLVideoElement;
      const integ = fakeIntegration();
      adapter!.trackPlayer(v, { integration: integ });
      for (let i = 0; i < 15; i++) integ.ctx()!.emit('error', { message: 'frag retry' }); // no `fatal` key
      const errs = events.filter((e) => e.type === 'error');
      expect(errs).toHaveLength(10);
    });

    // Codex round-2 item 1 — the sharpest finding of the round: a real Shaka
    // HTTP failure (e.g. a licence request) embeds the FULL failing request
    // URL, tokenised query string included, verbatim in `detail.message`.
    // `shaka.ts` itself still passes that text through unchanged (fixing it
    // there would leave hls.js and every custom integration's error text
    // exposed) — the scrub lives at `integrationEmit`'s single funnel in
    // this file instead, so it protects ANY integration. This exercises the
    // REAL `shakaIntegration()` end to end (not the generic `fakeIntegration`
    // used elsewhere in this file) so the assertion covers the actual
    // message shape Shaka produces, not a hand-picked stand-in.
    it('scrubs a tokenised URL out of a realistic Shaka HTTP error message before it reaches the emitted payload', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start();
      const v = document.getElementById('v') as HTMLVideoElement;
      const handlers = new Map<string, Array<(event?: unknown) => void>>();
      const fakeShaka = {
        addEventListener(name: string, fn: (event?: unknown) => void) {
          handlers.set(name, [...(handlers.get(name) ?? []), fn]);
        },
        removeEventListener(name: string, fn: (event?: unknown) => void) {
          handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== fn));
        },
        getAssetUri: () => '', // skip the late-attach source_change replay — not what this test is about
      };
      adapter!.trackPlayer(v, { integration: shakaIntegration(fakeShaka) });
      const fire = (name: string, event?: unknown) => {
        for (const h of handlers.get(name) ?? []) h(event);
      };
      const TOKEN = 'SUPER-SECRET-VALUE';
      fire(SHAKA_EVENTS.ERROR, {
        detail: {
          message: `HTTP_ERROR: request to https://license.example.com/v1/widevine?ExpressPlayToken=${TOKEN} failed with status 403`,
          code: 1002,
          category: 7,
          severity: 2,
        },
      });
      const err = events.find((e) => e.type === 'error');
      expect(err?.data?.message).toBe('HTTP_ERROR: request to https://license.example.com/v1/widevine failed with status 403');
      expect(JSON.stringify(err)).not.toContain(TOKEN);
    });

    // Fix round finding 3 — `integrationEmit`'s returned closure is the only
    // foreign-code entry point in the file without its own `safeWrap`
    // (`on()`'s listeners, the MutationObserver callback, `sampleQuality`,
    // `stop`, and `reseed` all have one). It's called SYNCHRONOUSLY from
    // third-party library code (a real hls.js/Shaka event dispatch), so a
    // throwing `onEvent` must not escape back into that dispatch loop and
    // break playback on the host page. Tested end to end, in the same shape
    // the failure would actually arrive: a throwing `onEvent`, a real
    // integration calling `ctx.emit(...)`, asserting the throw never reaches
    // the caller of `emit`.
    it('does not let a throwing onEvent escape through the integration boundary', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        document.body.innerHTML = '<video id="v"></video>';
        const integ = fakeIntegration();
        adapter = attachPlayerVitals({
          onEvent: (e) => {
            if (e.type === 'drm') throw new Error('onEvent blew up');
          },
        });
        const v = document.getElementById('v') as HTMLVideoElement;
        adapter.trackPlayer(v, { integration: integ });

        expect(() => integ.ctx()!.emit('drm', { keySystem: 'com.widevine.alpha' })).not.toThrow();
      } finally {
        consoleError.mockRestore();
      }
    });

    // Codex round-3 item 2 — the MutationObserver used to rebind an added
    // element with a bare `bind(element)`, consulting the registry only at
    // `attachPlayerVitals` construction time. Moving a registered element
    // between containers detached its integration and reattached it as
    // unnamed `native`, silencing library telemetry until an explicit
    // `trackPlayer()` call. `deps.registrationFor` (wired to the registry's
    // new `lookup()` in `vitals/index.ts`) is consulted on every scan-driven
    // bind now, so the reattach gets the same name/integration back.
    it('reattaches a reparented registered element with its name and integration, not unnamed native', async () => {
      document.body.innerHTML = '<div id="w1"></div><div id="w2"></div>';
      const w1 = document.getElementById('w1')!;
      const w2 = document.getElementById('w2')!;
      const v = document.createElement('video');
      w1.appendChild(v);
      const integ = fakeIntegration();
      const registration = { element: v, name: 'main', integration: integ };
      start(undefined, {
        registered: [registration],
        registrationFor: (el) => (el === v ? registration : undefined),
      });
      lifecycle.length = 0; all.length = 0; events.length = 0;

      // Reparent — the observer sees this as a removal from w1 followed by
      // an addition to w2.
      w1.removeChild(v);
      w2.appendChild(v);
      await flush();

      expect(lifecycle.filter((e) => e.type === 'player_attach')).toEqual([
        expect.objectContaining({ data: { name: 'main', tag: 'video', library: 'fake', libraryVersion: '9.9' } }),
      ]);
      expect(integ.ctx()?.element).toBe(v);
    });

    // Same defect, the other trigger named in the finding: unmounting and
    // remounting the SAME element (not moved to a different container).
    it('reattaches an unmounted-then-remounted registered element with its name and integration', async () => {
      document.body.innerHTML = '<div id="w"></div>';
      const w = document.getElementById('w')!;
      const v = document.createElement('video');
      w.appendChild(v);
      const integ = fakeIntegration();
      const registration = { element: v, name: 'main', integration: integ };
      start(undefined, {
        registered: [registration],
        registrationFor: (el) => (el === v ? registration : undefined),
      });
      lifecycle.length = 0; all.length = 0; events.length = 0;

      w.removeChild(v);
      await flush();
      w.appendChild(v);
      await flush();

      expect(lifecycle.filter((e) => e.type === 'player_attach')).toEqual([
        expect.objectContaining({ data: { name: 'main', tag: 'video', library: 'fake', libraryVersion: '9.9' } }),
      ]);
      expect(integ.ctx()?.element).toBe(v);
    });

    it('emits player_detach and calls integration.detach() on unbind; untrackPlayer prevents auto-rebind on the next scan', async () => {
      document.body.innerHTML = '<div id="w"><video id="v"></video></div>';
      start();
      const v = document.getElementById('v') as HTMLVideoElement;
      const integ = fakeIntegration();
      adapter!.trackPlayer(v, { integration: integ });
      adapter!.untrackPlayer(v);
      expect(lifecycle.at(-1)).toEqual(expect.objectContaining({ type: 'player_detach', playerId: 'p1' }));
      expect(integ.detached).toBe(1);
      const w = document.getElementById('w')!;
      w.removeChild(v); w.appendChild(v);
      await flush();
      v.dispatchEvent(new Event('play'));
      expect(events.filter((e) => e.type === 'play')).toEqual([]);
      adapter!.trackPlayer(v); // explicit call re-arms it
      v.dispatchEvent(new Event('play'));
      expect(events.filter((e) => e.type === 'play')).toHaveLength(1);
    });

    it('reseed re-emits player_attach, the cached source_change and drm, then the open play/buffer state', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start();
      const v = document.getElementById('v') as HTMLVideoElement;
      const integ = fakeIntegration();
      adapter!.trackPlayer(v, { integration: integ });
      integ.ctx()!.emit('source_change', { src: 'https://c/x.m3u8', protocol: 'hls' });
      integ.ctx()!.emit('drm', { keySystem: 'com.widevine.alpha' });
      v.dispatchEvent(new Event('play'));
      all.length = 0; lifecycle.length = 0; events.length = 0;
      adapter!.reseed();
      expect(all.map((e) => e.type)).toEqual(['player_attach', 'source_change', 'drm', 'play']);
      expect(all[1]?.data).toEqual({ src: 'https://c/x.m3u8', protocol: 'hls' });
    });

    // Codex round-1 item 3 — REVERSES the earlier "fix round finding 2"
    // ruling pinned by this test. `collector.ts` fires `onRotate` (->
    // reseed()) synchronously AFTER the triggering entry is recorded (see
    // packages/sdk-core/src/vitals/collector.ts's `addEntry`), so when a
    // `source_change` itself trips an idle/max-age rotation, a nested
    // `reseed()` runs INSIDE that same emit call. Emit-before-cache (the
    // earlier fix) made that nested reseed replay the STALE OLD source —
    // the new session ends up with `[new, old]`, and the admin's last-wins
    // fold reports the WRONG, stale source on the player card. Assign-
    // before-emit trades that for a harmless identical-looking replay
    // (`[new, new]`): `lastSource`/`lastDrm` are snapshots folded last-wins,
    // not spans that accumulate, so a repeated identical entry costs
    // nothing while a stale final value is a visibly wrong player card.
    it('a source_change that triggers a nested reseed() replays the CURRENT source, not a stale one', () => {
      document.body.innerHTML = '<video id="v"></video>';
      const integ = fakeIntegration();
      let rotated = false;
      const seen: Emitted[] = [];
      adapter = attachPlayerVitals({
        onEvent: (e) => {
          seen.push(e);
          // Stand-in for collector.ts's onRotate -> reseed(), fired
          // synchronously from inside recordPlayerEvent/addEntry for the
          // SAME entry that is currently being recorded — exactly the
          // reentrancy this test targets.
          if (e.type === 'source_change' && e.data?.src === 'https://c/b.m3u8' && !rotated) {
            rotated = true;
            adapter!.reseed();
          }
        },
      });
      const v = document.getElementById('v') as HTMLVideoElement;
      adapter.trackPlayer(v, { integration: integ });
      integ.ctx()!.emit('source_change', { src: 'https://c/a.m3u8', protocol: 'hls' });
      seen.length = 0;

      integ.ctx()!.emit('source_change', { src: 'https://c/b.m3u8', protocol: 'hls' });

      const sourceChanges = seen.filter((e) => e.type === 'source_change');
      expect(sourceChanges.map((e) => e.data?.src)).toEqual([
        'https://c/b.m3u8', // the in-flight entry itself
        'https://c/b.m3u8', // reseed's replay of the CURRENT (assign-before-emit) source — a harmless duplicate, not the stale 'a'
      ]);
    });

    // Fix round finding 4 — `drm` (and the generic fallthrough) now copy the
    // integration's payload object instead of forwarding the SAME reference
    // into both the adapter's cache and the emitted event. Pins real
    // immutability: mutate the object the integration still holds AFTER
    // emitting it, and assert the entry `onEvent` already captured — plus
    // the cached value `reseed()` will replay later — are both unaffected.
    it('copies the integration drm payload — a later mutation cannot rewrite an already-emitted entry or the reseed cache', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start();
      const v = document.getElementById('v') as HTMLVideoElement;
      const integ = fakeIntegration();
      adapter!.trackPlayer(v, { integration: integ });

      const payload: Record<string, unknown> = { keySystem: 'com.widevine.alpha' };
      integ.ctx()!.emit('drm', payload);
      const captured = lifecycle.find((e) => e.type === 'drm')!;

      // Mutate the object the integration still holds a reference to.
      payload.keySystem = 'mutated-after-emit';

      expect(captured.data).toEqual({ keySystem: 'com.widevine.alpha' });

      // The reseed cache must be equally unaffected — it copied at emit
      // time, not a shared reference to `payload`.
      all.length = 0; lifecycle.length = 0; events.length = 0;
      adapter!.reseed();
      const replayed = all.find((e) => e.type === 'drm');
      expect(replayed?.data).toEqual({ keySystem: 'com.widevine.alpha' });
    });

    // Same fix, the generic fallthrough site (every integration event type
    // OTHER than source_change/drm, e.g. bitrate_change) — not awkward to
    // reach, so covered alongside drm rather than left to inspection alone.
    it('copies the integration payload for the generic fallthrough event type too', () => {
      document.body.innerHTML = '<video id="v"></video>';
      start();
      const v = document.getElementById('v') as HTMLVideoElement;
      const integ = fakeIntegration();
      adapter!.trackPlayer(v, { integration: integ });

      const payload: Record<string, unknown> = { bitrate: 1_000_000 };
      integ.ctx()!.emit('bitrate_change', payload);
      const captured = events.find((e) => e.type === 'bitrate_change')!;

      payload.bitrate = 1; // mutate after the fact

      expect(captured.data).toEqual({ bitrate: 1_000_000 });
    });

    it('stop() emits player_detach for every bound player', () => {
      document.body.innerHTML = '<video></video><audio></audio>';
      start();
      adapter!.stop();
      expect(lifecycle.filter((e) => e.type === 'player_detach').map((e) => e.playerId)).toEqual(['p1', 'p2']);
      adapter = undefined;
    });
  });
});
