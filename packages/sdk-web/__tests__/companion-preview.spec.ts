// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Web device-side preview loop + shot stash (plan 2026-08-12, Task 9).
//
// Each test asks: would this fail against a stub?
//   - the overlap test holds one capture unresolved across two ticks, so a
//     naive setInterval that fires captures regardless would fail it
//   - the time-cap test asserts the STOP FRAME goes out, not merely that the
//     interval cleared — a device that goes quiet without saying so leaves
//     the phone showing a frozen frame it believes is live
//   - the re-crop test asserts capture is called ONCE across two requests
//     for the same shot_id; that is the entire point of the stash
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreviewLoop } from '../src/companion/preview-loop.js';
import { createShotStash } from '../src/companion/shot-stash.js';
import {
  handleCompanionPreviewStart,
  handleCompanionPreviewStop,
  handleCompanionPeerLost,
  handleCompanionReportCancelled,
  handleCompanionReportRequest,
  handleCompanionShotBinaryMarker,
  handleCompanionSubmitBinary,
  handleCompanionSubmitText,
  __companionPreviewRunning,
  __resetCompanionSubmitFramingForTests,
} from '../src/companion/capture-bridge.js';

const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

function harness() {
  const sent: unknown[] = [];
  const binaries: ArrayBuffer[] = [];
  return {
    sent,
    binaries,
    send: (m: unknown) => sent.push(m),
    sendBinary: (b: ArrayBuffer) => binaries.push(b),
    frames: () => sent.filter((m) => (m as { type?: string }).type === 'preview.frame'),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Never leak a running loop (module-level singleton) across tests.
  handleCompanionPeerLost();
  vi.useRealTimers();
});

describe('createPreviewLoop', () => {
  it('emits a header and a binary per tick', async () => {
    const h = harness();
    const loop = createPreviewLoop({
      intervalMs: 500,
      maxDurationMs: 120_000,
      capture: async () => ({ bytes: bytes('f'), width: 854, height: 480 }),
      send: h.send,
      sendBinary: h.sendBinary,
    });

    loop.start('c1');
    await vi.advanceTimersByTimeAsync(1_100);
    loop.stop('user');

    expect(h.frames().length).toBeGreaterThanOrEqual(2);
    expect(h.binaries.length).toBe(h.frames().length);
    expect(h.frames()[0]).toMatchObject({ type: 'preview.frame', correlation_id: 'c1', seq: 0 });
  });

  it('never runs two captures at once', async () => {
    const h = harness();
    let inFlight = 0;
    let maxInFlight = 0;
    const loop = createPreviewLoop({
      intervalMs: 100,
      maxDurationMs: 120_000,
      capture: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 350));
        inFlight -= 1;
        return { bytes: bytes('f'), width: 8, height: 4 };
      },
      send: h.send,
      sendBinary: h.sendBinary,
    });

    loop.start('c1');
    await vi.advanceTimersByTimeAsync(1_000);
    loop.stop('user');

    expect(maxInFlight).toBe(1);
  });

  it('stops itself at the time cap and says so on the wire', async () => {
    const h = harness();
    const loop = createPreviewLoop({
      intervalMs: 500,
      maxDurationMs: 2_000,
      capture: async () => ({ bytes: bytes('f'), width: 8, height: 4 }),
      send: h.send,
      sendBinary: h.sendBinary,
    });

    loop.start('c1');
    await vi.advanceTimersByTimeAsync(3_000);

    expect(loop.running).toBe(false);
    expect(h.sent).toContainEqual(
      expect.objectContaining({ type: 'preview.stop', reason: 'time_cap' }),
    );
  });

  it('stops with capture_unavailable when the capture source dies', async () => {
    const h = harness();
    const loop = createPreviewLoop({
      intervalMs: 100,
      maxDurationMs: 120_000,
      capture: async () => {
        throw new Error('no surface');
      },
      send: h.send,
      sendBinary: h.sendBinary,
    });

    loop.start('c1');
    await vi.advanceTimersByTimeAsync(500);

    expect(loop.running).toBe(false);
    expect(h.sent).toContainEqual(
      expect.objectContaining({ type: 'preview.stop', reason: 'capture_unavailable' }),
    );
  });

  it('is idempotent — a second start does not open a second interval', async () => {
    const h = harness();
    const loop = createPreviewLoop({
      intervalMs: 500,
      maxDurationMs: 120_000,
      capture: async () => ({ bytes: bytes('f'), width: 8, height: 4 }),
      send: h.send,
      sendBinary: h.sendBinary,
    });

    loop.start('c1');
    loop.start('c1');
    await vi.advanceTimersByTimeAsync(1_100);
    loop.stop('user');

    expect(h.frames().length).toBeLessThanOrEqual(3);
  });

  it('stopSilently clears the timers without an outbound frame', async () => {
    const h = harness();
    const loop = createPreviewLoop({
      intervalMs: 500,
      maxDurationMs: 120_000,
      capture: async () => ({ bytes: bytes('f'), width: 8, height: 4 }),
      send: h.send,
      sendBinary: h.sendBinary,
    });

    loop.start('c1');
    await vi.advanceTimersByTimeAsync(600);
    loop.stopSilently();

    expect(loop.running).toBe(false);
    expect(h.sent.some((m) => (m as { type?: string }).type === 'preview.stop')).toBe(false);
  });
});

describe('createShotStash', () => {
  it('captures once and answers a re-crop from the stash', async () => {
    const h = harness();
    const capture = vi.fn(async () => ({
      bytes: bytes('full'),
      mime: 'image/webp' as const,
      width: 1000,
      height: 500,
    }));
    const crop = vi.fn(
      async (_source: unknown, r: { x: number; y: number; w: number; h: number }) => ({
        bytes: bytes('cropped'),
        mime: 'image/webp' as const,
        width: r.w,
        height: r.h,
      }),
    );

    const stash = createShotStash({
      correlationId: 'c1',
      capture,
      crop,
      send: h.send,
      sendBinary: h.sendBinary,
    });

    await stash.handle({ shotId: 's1' });
    await stash.handle({ shotId: 's1', rect: { x: 0, y: 0, w: 0.5, h: 0.5 } });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(crop).toHaveBeenCalledTimes(1);
    expect(h.sent.filter((m) => (m as { type?: string }).type === 'shot.assembled')).toHaveLength(2);
    // Crop rect arrives in PIXELS of the stashed frame, not normalized units.
    expect(crop).toHaveBeenCalledWith(expect.anything(), { x: 0, y: 0, w: 500, h: 250 });
  });

  it('clamps a crop whose far edge exceeds the source frame', async () => {
    const h = harness();
    const crop = vi.fn(async (_s: unknown, r: { x: number; y: number; w: number; h: number }) => ({
      bytes: bytes('c'),
      mime: 'image/webp' as const,
      width: r.w,
      height: r.h,
    }));
    const stash = createShotStash({
      correlationId: 'c1',
      capture: async () => ({ bytes: bytes('full'), mime: 'image/webp' as const, width: 1000, height: 500 }),
      crop,
      send: h.send,
      sendBinary: h.sendBinary,
    });

    // Each field is within 0-1 but x+w = 1.3 — schema-valid, out of frame.
    await stash.handle({ shotId: 's1', rect: { x: 0.8, y: 0, w: 0.5, h: 0.5 } });

    expect(crop).toHaveBeenCalledWith(expect.anything(), { x: 800, y: 0, w: 200, h: 250 });
  });

  it('evicts the oldest stashed shot past the cap instead of growing unbounded', async () => {
    const h = harness();
    const capture = vi.fn(async () => ({
      bytes: bytes('full'),
      mime: 'image/webp' as const,
      width: 10,
      height: 10,
    }));
    const stash = createShotStash({
      correlationId: 'c1',
      capture,
      crop: async (s) => s,
      send: h.send,
      sendBinary: h.sendBinary,
    });

    for (let i = 0; i < 13; i++) await stash.handle({ shotId: `s${i}` });
    expect(capture).toHaveBeenCalledTimes(13);
    // s12 survived the cap: re-crop comes from the stash, no fresh capture.
    await stash.handle({ shotId: 's12' });
    expect(capture).toHaveBeenCalledTimes(13);
    // s0 was evicted: touching it again re-captures.
    await stash.handle({ shotId: 's0' });
    expect(capture).toHaveBeenCalledTimes(14);
  });

  it('concurrent requests for the same new shot_id share one capture', async () => {
    const h = harness();
    let release: (() => void) | undefined;
    const capture = vi.fn(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return { bytes: bytes('full'), mime: 'image/webp' as const, width: 10, height: 10 };
    });
    const stash = createShotStash({
      correlationId: 'c1',
      capture,
      crop: async (s) => s,
      send: h.send,
      sendBinary: h.sendBinary,
    });

    const a = stash.handle({ shotId: 's1' });
    const b = stash.handle({ shotId: 's1', rect: { x: 0, y: 0, w: 0.5, h: 0.5 } });
    release!();
    await Promise.all([a, b]);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(h.sent.filter((m) => (m as { type?: string }).type === 'shot.assembled')).toHaveLength(2);
  });

  it('bounds concurrent captures by the cap, failing the overflow shots', async () => {
    const h = harness();
    let releases: Array<() => void> = [];
    const capture = vi.fn(
      () =>
        new Promise<{ bytes: ArrayBuffer; mime: 'image/webp'; width: number; height: number }>(
          (r) => {
            releases.push(() =>
              r({ bytes: bytes('full'), mime: 'image/webp', width: 10, height: 10 }),
            );
          },
        ),
    );
    const stash = createShotStash({
      correlationId: 'c1',
      capture,
      crop: async (s) => s,
      send: h.send,
      sendBinary: h.sendBinary,
    });

    const all = Promise.all(
      Array.from({ length: 20 }, (_, i) => stash.handle({ shotId: `s${i}` })),
    );
    // Only the first 12 may have started captures; the rest fail fast.
    expect(capture).toHaveBeenCalledTimes(12);
    releases.forEach((r) => r());
    await all;

    expect(h.sent.filter((m) => (m as { type?: string }).type === 'shot.failed')).toHaveLength(8);
    expect(h.sent.filter((m) => (m as { type?: string }).type === 'shot.assembled')).toHaveLength(12);
  });

  it('makes an in-flight capture inert when cleared mid-flight', async () => {
    const h = harness();
    let release: (() => void) | undefined;
    const stash = createShotStash({
      correlationId: 'c1',
      capture: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return { bytes: bytes('late'), mime: 'image/webp' as const, width: 8, height: 4 };
      },
      crop: async (s) => s,
      send: h.send,
      sendBinary: h.sendBinary,
    });

    const pending = stash.handle({ shotId: 's1' });
    stash.clear(); // report.cancelled / peer lost while the capture runs
    release!();
    await pending;

    expect(h.sent).toHaveLength(0);
    expect(h.binaries).toHaveLength(0);
  });

  it('reports shot.failed for that shot alone when capture fails', async () => {
    const h = harness();
    const stash = createShotStash({
      correlationId: 'c1',
      capture: async () => {
        throw new Error('no_surface');
      },
      crop: async () => ({ bytes: bytes('x'), mime: 'image/webp' as const, width: 1, height: 1 }),
      send: h.send,
      sendBinary: h.sendBinary,
    });

    await stash.handle({ shotId: 's1' });

    expect(h.sent).toContainEqual(expect.objectContaining({ type: 'shot.failed', shot_id: 's1' }));
    expect(h.sent.some((m) => (m as { type?: string }).type === 'report.failed')).toBe(false);
  });
});

describe('report.request cancelled mid-capture', () => {
  it('a cancel arriving during the initial capture aborts the stash and ship', async () => {
    const h = harness();
    let release: (() => void) | undefined;
    const host = {
      adapter: {
        captureScreenshot: () =>
          new Promise((r) => {
            release = () =>
              r({ blob: new Blob(['png'], { type: 'image/png' }), width: 8, height: 4, sha256: 'x' });
          }),
      },
    } as never;

    const pending = handleCompanionReportRequest('c1', { send: h.send, sendBinary: h.sendBinary } as never, host);
    // requestStash isn't populated yet — the cancel must still own c1
    // through the in-flight request marker (review round 3, finding 1).
    handleCompanionReportCancelled(null, 'c1');
    release!();
    await pending;

    expect(h.sent).toHaveLength(0);
    expect(h.binaries).toHaveLength(0);
  });
});

describe('submit framing with shot.binary markers', () => {
  const fakeWs = (h: ReturnType<typeof harness>) =>
    ({ send: h.send, sendBinary: h.sendBinary }) as never;
  const fakeCompanion = { __setState: () => {} } as never;
  // Null host: runCompanionSubmit answers report.failed(submit_unavailable)
  // the moment it RUNS — which makes it a precise probe for WHEN the framing
  // considers the submit complete.
  const submitMsg = (shots: Array<{ shot_id: string }>) =>
    ({ correlation_id: 'c1', annotations: [], shots }) as never;
  const ran = (h: ReturnType<typeof harness>) =>
    h.sent.filter((m) => (m as { type?: string }).type === 'report.failed').length;

  beforeEach(() => {
    __resetCompanionSubmitFramingForTests();
  });

  it('waits for every shots[] binary before launching the submit', () => {
    const h = harness();
    handleCompanionSubmitText(submitMsg([{ shot_id: 's1' }]), fakeWs(h), null, fakeCompanion);
    expect(ran(h)).toBe(0);
    handleCompanionSubmitBinary(bytes('primary'), fakeWs(h), null, fakeCompanion);
    expect(ran(h)).toBe(0); // primary alone is not enough — s1 still missing
    handleCompanionShotBinaryMarker({ correlation_id: 'c1', shot_id: 's1' });
    handleCompanionSubmitBinary(bytes('shot1'), fakeWs(h), null, fakeCompanion);
    expect(ran(h)).toBe(1);
  });

  it('routes a marker-bound binary to the shot, never to the primary slot', () => {
    const h = harness();
    handleCompanionSubmitText(submitMsg([{ shot_id: 's1' }]), fakeWs(h), null, fakeCompanion);
    // Marker FIRST — if this binary were mistaken for the primary, the
    // submit would launch here with only one of its two images.
    handleCompanionShotBinaryMarker({ correlation_id: 'c1', shot_id: 's1' });
    handleCompanionSubmitBinary(bytes('shot1'), fakeWs(h), null, fakeCompanion);
    expect(ran(h)).toBe(0);
    handleCompanionSubmitBinary(bytes('primary'), fakeWs(h), null, fakeCompanion);
    expect(ran(h)).toBe(1);
  });

  it('single-shot submits keep the legacy text+binary behavior', () => {
    const h = harness();
    handleCompanionSubmitText(submitMsg([]), fakeWs(h), null, fakeCompanion);
    handleCompanionSubmitBinary(bytes('primary'), fakeWs(h), null, fakeCompanion);
    expect(ran(h)).toBe(1);
  });

  it('ignores a marker for a shot_id the pending submit never announced', () => {
    const h = harness();
    handleCompanionSubmitText(submitMsg([{ shot_id: 's1' }]), fakeWs(h), null, fakeCompanion);
    // Unannounced id — must NOT arm the binding...
    handleCompanionShotBinaryMarker({ correlation_id: 'c1', shot_id: 'sEvil' });
    handleCompanionSubmitBinary(bytes('primary'), fakeWs(h), null, fakeCompanion);
    expect(ran(h)).toBe(0); // ...so this binary was the primary; s1 still missing
    handleCompanionShotBinaryMarker({ correlation_id: 'c1', shot_id: 's1' });
    handleCompanionSubmitBinary(bytes('shot1'), fakeWs(h), null, fakeCompanion);
    expect(ran(h)).toBe(1);
  });

  it('ignores a marker whose correlation does not match the pending submit', () => {
    const h = harness();
    handleCompanionSubmitText(submitMsg([]), fakeWs(h), null, fakeCompanion);
    handleCompanionShotBinaryMarker({ correlation_id: 'cStale', shot_id: 's1' });
    handleCompanionSubmitBinary(bytes('primary'), fakeWs(h), null, fakeCompanion);
    expect(ran(h)).toBe(1); // binary reached the primary slot, submit ran
  });

  it('peer loss disarms a dangling shot.binary binding', () => {
    const h = harness();
    // Phone dropped between the marker and its payload...
    handleCompanionShotBinaryMarker({ correlation_id: 'cOld', shot_id: 'sOld' });
    handleCompanionPeerLost();
    // ...the NEXT report's primary binary must not be routed into that
    // dead shot (iOS resetSubmitFraming's exact scenario).
    handleCompanionSubmitText(submitMsg([]), fakeWs(h), null, fakeCompanion);
    handleCompanionSubmitBinary(bytes('primary'), fakeWs(h), null, fakeCompanion);
    expect(ran(h)).toBe(1);
  });
});

describe('capture-bridge preview routing', () => {
  const fakeWs = (h: ReturnType<typeof harness>) =>
    ({ send: h.send, sendBinary: h.sendBinary }) as never;
  const fakeHost = {} as never; // capture is injected; the host is only a presence gate

  it('refuses with capture_unavailable when no host seam is mounted', () => {
    const h = harness();
    handleCompanionPreviewStart(null, fakeWs(h), 'c1');
    expect(h.sent).toContainEqual(
      expect.objectContaining({ type: 'preview.stop', reason: 'capture_unavailable' }),
    );
    expect(__companionPreviewRunning()).toBe(false);
  });

  it('refuses with capture_unavailable under the live profile — preview is off everywhere (product call 2026-08-27)', () => {
    const h = harness();
    handleCompanionPreviewStart(fakeHost, fakeWs(h), 'c1', async () => ({
      bytes: bytes('f'),
      width: 8,
      height: 4,
    }));
    expect(h.sent).toContainEqual(
      expect.objectContaining({ type: 'preview.stop', reason: 'capture_unavailable' }),
    );
    expect(__companionPreviewRunning()).toBe(false);
  });

  // The lifecycle tests below inject a permissive profile: the loop machinery
  // is kept for per-tier re-enablement, so its teardown wiring stays proven.
  const PREVIEW_ON = () => ({
    deadlineMs: 10_000,
    maxOutputEdgePx: null,
    fastClone: false,
    livePreview: true,
    preferWebP: true,
    viewportOnlyClone: false,
  });

  it('starts a loop when a host is present and stops on phone-side preview.stop', async () => {
    const h = harness();
    handleCompanionPreviewStart(
      fakeHost,
      fakeWs(h),
      'c1',
      async () => ({ bytes: bytes('f'), width: 8, height: 4 }),
      PREVIEW_ON,
    );
    await vi.advanceTimersByTimeAsync(1_100);
    expect(h.frames().length).toBeGreaterThanOrEqual(2);
    expect(__companionPreviewRunning()).toBe(true);

    handleCompanionPreviewStop();
    expect(__companionPreviewRunning()).toBe(false);
    // Phone asked for the stop — echoing preview.stop back is noise.
    expect(h.sent.some((m) => (m as { type?: string }).type === 'preview.stop')).toBe(false);
  });

  it('stops when the phone disconnects', async () => {
    const h = harness();
    handleCompanionPreviewStart(
      fakeHost,
      fakeWs(h),
      'c1',
      async () => ({ bytes: bytes('f'), width: 8, height: 4 }),
      PREVIEW_ON,
    );
    await vi.advanceTimersByTimeAsync(600);
    handleCompanionPeerLost();
    expect(__companionPreviewRunning()).toBe(false);
    expect(h.sent.some((m) => (m as { type?: string }).type === 'preview.stop')).toBe(false);
  });

  it('stops when the report is cancelled', async () => {
    const h = harness();
    handleCompanionPreviewStart(
      fakeHost,
      fakeWs(h),
      'c1',
      async () => ({ bytes: bytes('f'), width: 8, height: 4 }),
      PREVIEW_ON,
    );
    await vi.advanceTimersByTimeAsync(600);
    handleCompanionReportCancelled(null);
    expect(__companionPreviewRunning()).toBe(false);
  });

  it('a delayed cancel for another correlation leaves the live session alone', async () => {
    const h = harness();
    handleCompanionPreviewStart(
      fakeHost,
      fakeWs(h),
      'c2',
      async () => ({ bytes: bytes('f'), width: 8, height: 4 }),
      PREVIEW_ON,
    );
    await vi.advanceTimersByTimeAsync(600);
    // Cancel for the PREVIOUS report, arriving late — must not stop c2.
    handleCompanionReportCancelled(null, 'c1');
    expect(__companionPreviewRunning()).toBe(true);
    // Scoped cancel for the live report still works.
    handleCompanionReportCancelled(null, 'c2');
    expect(__companionPreviewRunning()).toBe(false);
  });
});
