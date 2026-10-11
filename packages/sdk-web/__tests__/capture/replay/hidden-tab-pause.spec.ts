// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Spec 2026-10-11, "New automatic pauses" (web): nothing records while the tab
// is hidden. A pause invalidates the rolling window, as every replay pause
// does, and recording resumes with a fresh full snapshot.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReplayRecorder, type PageVisibility } from '../../../src/capture/replay/recorder.js';

const FULL = 2;
const INCR = 3;

function page(initiallyHidden: boolean) {
  let hidden = initiallyHidden;
  const listeners = new Set<() => void>();
  const visibility: PageVisibility = {
    hidden: () => hidden,
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  };
  return {
    visibility,
    listeners,
    set(next: boolean): void {
      hidden = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

function harness(initiallyHidden = false) {
  const p = page(initiallyHidden);
  const state = {
    recordCalls: 0,
    stops: 0,
    emit: undefined as ((e: unknown, isCheckout?: boolean) => void) | undefined,
  };
  const rec = createReplayRecorder({
    importRrweb: async () => ({
      record: (o: Record<string, unknown>) => {
        state.recordCalls += 1;
        state.emit = o['emit'] as typeof state.emit;
        return () => {
          state.stops += 1;
        };
      },
    }),
    now: () => 0,
    freezeNow: () => 100_000,
    gzip: async (bytes) => bytes,
    visibility: p.visibility,
    yieldToHost: () => Promise.resolve(),
  });
  return { rec, page: p, state };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hidden-tab pause', () => {
  it('stops recording and drops the window when the tab is hidden', async () => {
    const h = harness();
    h.rec.start(30);
    await flush();
    h.state.emit!({ type: FULL, timestamp: 90_000 }, true);
    h.page.set(true);
    expect(h.state.stops).toBe(1);
    expect(h.rec.__size).toBe(0);
    expect(h.rec.__diagnostics()).toMatchObject({ recording: false, pausedHidden: true });
    // A late emit from the stopped rrweb is ignored.
    h.state.emit!({ type: INCR, timestamp: 91_000 });
    expect(h.rec.__size).toBe(0);
    expect(await h.rec.snapshot()).toBeNull();
  });

  it('resumes with a fresh full snapshot when the tab is shown again', async () => {
    const h = harness();
    h.rec.start(30);
    await flush();
    h.state.emit!({ type: FULL, timestamp: 80_000 }, true);
    h.state.emit!({ type: INCR, timestamp: 85_000 });
    h.page.set(true);
    h.page.set(false);
    await flush();
    expect(h.state.recordCalls).toBe(2); // a new record(): rrweb emits Meta + FullSnapshot
    expect(h.rec.__diagnostics()).toMatchObject({ recording: true, pausedHidden: false });
    expect(h.rec.__size).toBe(0);
    h.state.emit!({ type: INCR, timestamp: 95_000 });
    expect(await h.rec.snapshot()).toBeNull();
    h.state.emit!({ type: 4, timestamp: 96_000 });
    h.state.emit!({ type: FULL, timestamp: 96_000 }, true);
    h.state.emit!({ type: INCR, timestamp: 99_000 });
    const capture = await h.rec.snapshot();
    expect(JSON.parse(new TextDecoder().decode(capture!.bytes)).map((e: { timestamp: number }) => e.timestamp))
      .toEqual([96_000, 96_000, 99_000]);
  });

  it('rejects old rrweb emissions even after recording resumes', async () => {
    const h = harness();
    h.rec.start(30);
    await flush();
    const oldEmit = h.state.emit!;
    oldEmit({ type: FULL, timestamp: 80_000 }, true);
    h.page.set(true);
    h.page.set(false);
    await flush();
    oldEmit({ type: FULL, timestamp: 90_000 }, true);
    oldEmit({ type: INCR, timestamp: 91_000 });
    expect(h.rec.__size).toBe(0);
    expect(await h.rec.snapshot()).toBeNull();
    h.state.emit!({ type: FULL, timestamp: 96_000 }, true);
    h.state.emit!({ type: INCR, timestamp: 99_000 });
    const capture = await h.rec.snapshot();
    expect(JSON.parse(new TextDecoder().decode(capture!.bytes)).map((e: { timestamp: number }) => e.timestamp))
      .toEqual([96_000, 99_000]);
  });

  it('cancels a pending rrweb import while hidden and starts only the visible generation', async () => {
    const p = page(false);
    let load!: (mod: { record: () => () => void }) => void;
    const importing = new Promise<{ record: () => () => void }>((resolve) => { load = resolve; });
    let recordCalls = 0;
    const rec = createReplayRecorder({ importRrweb: () => importing, visibility: p.visibility });
    rec.start(30);
    p.set(true);
    load({ record: () => { recordCalls++; return () => undefined; } });
    await flush();
    expect(recordCalls).toBe(0);
    expect(rec.__diagnostics()).toMatchObject({ recording: false, pausedHidden: true, frames: 0 });
    p.set(false);
    await flush();
    expect(recordCalls).toBe(1);
    rec.stop();
  });

  it('unsubscribes after a buffer overflow self-disables recording', async () => {
    const h = harness();
    h.rec.start(30);
    await flush();
    h.state.emit!({ type: FULL, timestamp: 90_000, data: { pad: 'x'.repeat(5 * 1024 * 1024) } }, true);
    expect(h.rec.disabled).toBe(true);
    expect(h.page.listeners.size).toBe(0);
    h.page.set(true);
    h.page.set(false);
    await flush();
    expect(h.state.recordCalls).toBe(1);
  });

  it('does not start recording while the tab is hidden', async () => {
    const h = harness(true);
    h.rec.start(30);
    await flush();
    expect(h.state.recordCalls).toBe(0);
    expect(h.rec.__diagnostics().pausedHidden).toBe(true);
    h.page.set(false);
    await flush();
    expect(h.state.recordCalls).toBe(1);
  });

  it('leaves a window a bug report has frozen alone', async () => {
    const h = harness();
    h.rec.start(30);
    await flush();
    h.state.emit!({ type: FULL, timestamp: 90_000 }, true);
    h.rec.freeze();
    h.page.set(true);
    h.page.set(false);
    await flush();
    expect(h.state.recordCalls).toBe(1);
    expect(await h.rec.takeFrozen()).not.toBeNull();
  });

  it('stops listening on stop() and on kill()', async () => {
    const h = harness();
    h.rec.start(30);
    expect(h.page.listeners.size).toBe(1);
    h.rec.stop();
    expect(h.page.listeners.size).toBe(0);
    h.rec.start(30);
    expect(h.page.listeners.size).toBe(1);
    h.rec.kill();
    expect(h.page.listeners.size).toBe(0);
  });

  it('follows the real document visibility by default', async () => {
    let recordCalls = 0;
    const rec = createReplayRecorder({
      importRrweb: async () => ({
        record: () => {
          recordCalls += 1;
          return () => undefined;
        },
      }),
      gzip: async (bytes) => bytes,
    });
    rec.start(30);
    await flush();
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(rec.__diagnostics().pausedHidden).toBe(true);
    state.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(recordCalls).toBe(2);
    rec.stop();
  });
});
