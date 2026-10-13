// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Replays on errors (spec 2026-10-11, "Snapshot, not freeze"): the recorder's
// non-destructive snapshot of the rolling window. It never stops, freezes,
// clears or rotates the recorder, so a later error or bug report keeps its
// full history.
import { describe, it, expect, vi } from 'vitest';
import { Replayer } from 'rrweb';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createReplayRecorder, windowFromAnchor } from '../../../src/capture/replay/recorder.js';

const META = 4;
const FULL = 2;
const INCR = 3;

const testGzip = async (input: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(gzipSync(Buffer.from(input)));
const decode = (bytes: Uint8Array) =>
  JSON.parse(gunzipSync(Buffer.from(bytes)).toString('utf8')) as Array<{
    type: number;
    timestamp: number;
  }>;

function harness(
  opts: {
    now?: number;
    gzip?: (input: Uint8Array) => Promise<Uint8Array>;
    yieldToHost?: () => Promise<void>;
    mirror?: { getNode(id: number): Node | null };
  } = {},
) {
  let emit: ((e: unknown, isCheckout?: boolean) => void) | undefined;
  let clock = opts.now ?? 100_000;
  const rec = createReplayRecorder({
    importRrweb: async () => ({
      record: Object.assign(
        (o: Record<string, unknown>) => {
          emit = o['emit'] as typeof emit;
          return () => undefined;
        },
        opts.mirror ? { mirror: opts.mirror } : {},
      ),
    }),
    now: () => 0,
    freezeNow: () => clock,
    gzip: opts.gzip ?? testGzip,
    yieldToHost: opts.yieldToHost ?? (() => Promise.resolve()),
  });
  return {
    rec,
    emit: (type: number, timestamp: number, data: unknown = {}) =>
      emit!({ type, timestamp, data }, type === FULL),
    setNow: (t: number) => {
      clock = t;
    },
  };
}

async function started(h: ReturnType<typeof harness>): Promise<void> {
  h.rec.start(30);
  await Promise.resolve();
  await Promise.resolve();
}

describe('replay snapshot (non-destructive)', () => {
  it('returns the window and leaves the recorder recording with its full history', async () => {
    const h = harness();
    await started(h);
    h.emit(META, 80_000);
    h.emit(FULL, 80_000);
    h.emit(INCR, 90_000);
    const capture = await h.rec.snapshot();
    expect(capture).toMatchObject({
      format: 'rrweb',
      durationMs: 20_000,
      contentType: 'application/octet-stream',
    });
    expect(decode(capture!.bytes).map((e) => e.timestamp)).toEqual([
      80_000, 80_000, 90_000, 100_000,
    ]);
    expect(h.rec.__diagnostics()).toMatchObject({ recording: true, frozen: false, frames: 3 });
    h.emit(INCR, 95_000);
    expect(h.rec.__size).toBe(4);
    // A later bug report still gets everything, the snapshot's frames included.
    h.rec.freeze();
    expect(decode((await h.rec.takeFrozen())!.bytes).map((e) => e.timestamp)).toEqual([
      80_000, 80_000, 90_000, 95_000,
    ]);
  });

  it('real Replayer retains a full-snapshot-only idle tail and isolates a later report', async () => {
    const h = harness();
    await started(h);
    h.emit(META, 80_000, { href: 'https://example.test', width: 800, height: 600 });
    h.emit(FULL, 80_000, {
      node: {
        type: 0,
        id: 1,
        childNodes: [
          {
            type: 2,
            id: 2,
            tagName: 'html',
            attributes: {},
            childNodes: [
              { type: 2, id: 3, tagName: 'head', attributes: {}, childNodes: [] },
              { type: 2, id: 4, tagName: 'body', attributes: {}, childNodes: [] },
            ],
          },
        ],
      },
      initialOffset: { top: 0, left: 0 },
    });
    const pending = h.rec.snapshot();
    h.setNow(110_000);
    h.emit(5, 110_000, { tag: 'later-report', payload: {} });
    h.rec.freeze();
    const error = await pending;
    const report = await h.rec.takeFrozen();
    const events = decode(error!.bytes);
    expect(events.at(-1)).toMatchObject({ type: 5, timestamp: 100_000 });
    // jsdom omits iframe.sandbox; model its reflected token list without
    // bypassing rrweb's protected-document checks.
    const sandbox = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'sandbox');
    Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', {
      configurable: true,
      get() {
        return (this.getAttribute('sandbox') ?? '').split(/\s+/).filter(Boolean);
      },
    });
    const player = new Replayer(events as ConstructorParameters<typeof Replayer>[0], {
      root: document.body,
    });
    const later = new Replayer(decode(report!.bytes) as ConstructorParameters<typeof Replayer>[0], {
      root: document.body,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(player.getMetaData()).toMatchObject({
        startTime: 80_000,
        endTime: 100_000,
        totalTime: 20_000,
      });
      player.pause(20_000);
      expect(player.getCurrentTime()).toBe(20_000);
      expect(later.getMetaData()).toMatchObject({ endTime: 110_000, totalTime: 30_000 });
      expect(decode(report!.bytes).filter((e) => e.timestamp === 100_000)).toEqual([]);
    } finally {
      player.destroy();
      later.destroy();
      h.rec.kill();
      if (sandbox) Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', sandbox);
      else Reflect.deleteProperty(HTMLIFrameElement.prototype, 'sandbox');
    }
  });

  it('exports seekable movement after removing sensitive-only batches and preserving mixed timing', async () => {
    document.body.innerHTML =
      '<p id="safe">Public</p><div data-everframe-sensitive><span id="private">Private</span></div>';
    const h = harness({
      mirror: {
        getNode: (id) =>
          id === 5
            ? document.querySelector('#safe')
            : id === 6
              ? document.querySelector('#private')
              : null,
      },
    });
    await started(h);
    h.emit(META, 80_000, { href: 'https://example.test', width: 800, height: 600 });
    h.emit(FULL, 80_000, {
      node: {
        type: 0,
        id: 1,
        childNodes: [
          {
            type: 2,
            id: 2,
            tagName: 'html',
            attributes: {},
            childNodes: [
              { type: 2, id: 3, tagName: 'head', attributes: {}, childNodes: [] },
              {
                type: 2,
                id: 4,
                tagName: 'body',
                attributes: {},
                childNodes: [
                  { type: 2, id: 5, tagName: 'p', attributes: { id: 'safe' }, childNodes: [] },
                ],
              },
            ],
          },
        ],
      },
      initialOffset: { top: 0, left: 0 },
    });
    h.emit(INCR, 90_000, { source: 1, positions: [{ id: 6, x: 12, y: 20, timeOffset: -100 }] });
    const publicPosition = { id: 5, x: 25, y: 30, timeOffset: -50 };
    h.emit(INCR, 95_000, {
      source: 1,
      positions: [{ id: 6, x: 13, y: 20, timeOffset: -100 }, publicPosition],
    });
    const capture = (await h.rec.snapshot())!;
    const events = decode(capture.bytes);
    const sandbox = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'sandbox');
    Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', {
      configurable: true,
      get() {
        return (this.getAttribute('sandbox') ?? '').split(/\s+/).filter(Boolean);
      },
    });
    const player = new Replayer(events as ConstructorParameters<typeof Replayer>[0], {
      root: document.body,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(() => player.pause(20_000)).not.toThrow();
      // Replayer mutates its input with internal delay bookkeeping; inspect
      // the original encoded bytes for the exact surviving timestamp/offset.
      expect(decode(capture.bytes).filter((event) => event.type === INCR)).toEqual([
        { type: INCR, timestamp: 95_000, data: { source: 1, positions: [publicPosition] } },
      ]);
      expect(player.getCurrentTime()).toBe(20_000);
    } finally {
      player.destroy();
      h.rec.kill();
      document.body.innerHTML = '';
      if (sandbox) Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', sandbox);
      else Reflect.deleteProperty(HTMLIFrameElement.prototype, 'sandbox');
    }
  });

  it('plays only the configured window after a long idle, with the held DOM at its start', async () => {
    let now = 1_000_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    document.body.innerHTML =
      '<p id="held">Initial</p><div id="scrolled" style="overflow:scroll;height:20px"><div style="height:1000px">Visible lower content</div></div>';
    window.eval(
      readFileSync(
        new NodeURL('../../../../../node_modules/rrweb/umd/rrweb.js', import.meta.url),
        'utf8',
      ),
    );
    const rec = createReplayRecorder({
      importRrweb: async () => (window as any).rrweb,
      gzip: testGzip,
    });
    const sandbox = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'sandbox');
    Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', {
      configurable: true,
      get() {
        return (this.getAttribute('sandbox') ?? '').split(/\s+/).filter(Boolean);
      },
    });
    let player: Replayer | undefined;
    try {
      rec.start(30);
      await vi.waitFor(() => expect(rec.__diagnostics().recording).toBe(true));
      now += 1_000;
      vi.setSystemTime(now);
      document.querySelector('#held')!.firstChild!.textContent = 'Held before cutoff';
      const scrolled = document.querySelector('#scrolled')!;
      scrolled.scrollTop = 240;
      scrolled.scrollLeft = 12;
      scrolled.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      now += 3_600_000;
      vi.setSystemTime(now);
      const pending = rec.snapshot();
      now += 1_000;
      vi.setSystemTime(now);
      document.querySelector('#held')!.firstChild!.textContent = 'Later report only';
      await new Promise((resolve) => setTimeout(resolve, 0));
      rec.freeze();
      const capture = (await pending)!;
      expect(capture.durationMs).toBe(30_000);
      const events = decode(capture.bytes);
      expect(events[0]!.timestamp).toBe(now - 31_000);
      expect(JSON.stringify(events)).not.toContain('Later report only');
      const report = decode((await rec.takeFrozen())!.bytes);
      expect(JSON.stringify(report)).toContain('Later report only');
      expect(report.some((e) => e.timestamp === 1_001_000)).toBe(true);
      player = new Replayer(events as ConstructorParameters<typeof Replayer>[0], {
        root: document.body,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      player.pause(0);
      expect(player.getMetaData().totalTime).toBe(30_000);
      expect(player.iframe.contentDocument!.querySelector('#held')!.textContent).toBe(
        'Held before cutoff',
      );
      expect(player.iframe.contentDocument!.querySelector('#scrolled')!.scrollTop).toBe(240);
      expect(player.iframe.contentDocument!.querySelector('#scrolled')!.scrollLeft).toBe(12);
      player.pause(30_000);
      expect(player.iframe.contentDocument!.querySelector('#held')!.textContent).toBe(
        'Held before cutoff',
      );
    } finally {
      player?.destroy();
      rec.kill();
      vi.useRealTimers();
      vi.restoreAllMocks();
      document.body.innerHTML = '';
      if (sandbox) Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', sandbox);
      else Reflect.deleteProperty(HTMLIFrameElement.prototype, 'sandbox');
    }
  });

  it('starts at the newest full snapshot that still covers the window', async () => {
    const h = harness({ now: 100_000 });
    await started(h);
    h.emit(META, 50_000);
    h.emit(FULL, 50_000);
    h.emit(INCR, 60_000);
    h.emit(META, 72_000);
    h.emit(FULL, 72_000);
    h.emit(INCR, 95_000);
    // 30 s ending at 100 000 starts at 70 000: the snapshot at 50 000 covers it.
    expect(decode((await h.rec.snapshot())!.bytes).map((e) => e.timestamp)).toEqual([
      70_000, 70_000, 70_000, 72_000, 72_000, 95_000, 100_000,
    ]);
    // 30 s ending at 110 000 starts at 80 000: the snapshot at 72 000 covers it.
    h.setNow(110_000);
    expect(decode((await h.rec.snapshot())!.bytes).map((e) => e.timestamp)).toEqual([
      80_000, 80_000, 95_000, 110_000,
    ]);
    expect(h.rec.__size).toBe(6); // the buffer itself was not pruned
  });

  it('copies at the call: frames emitted while it encodes are not in it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ yieldToHost: () => gate });
    await started(h);
    h.emit(FULL, 90_000);
    const pending = h.rec.snapshot();
    h.emit(INCR, 99_000);
    release();
    expect(decode((await pending)!.bytes).map((e) => e.timestamp)).toEqual([90_000, 100_000]);
  });

  it('keeps an independent copy while a bug report freezes and exports the full history', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let encodingStarted!: () => void;
    const encoding = new Promise<void>((resolve) => {
      encodingStarted = resolve;
    });
    let exports = 0;
    const h = harness({
      gzip: async (bytes) => {
        if (++exports === 1) {
          encodingStarted();
          await gate;
        }
        return testGzip(bytes);
      },
    });
    await started(h);
    h.emit(META, 80_000);
    h.emit(FULL, 80_000);
    h.emit(INCR, 90_000);
    const pending = h.rec.snapshot();
    await encoding;
    h.emit(INCR, 95_000);
    h.rec.freeze();
    const report = await h.rec.takeFrozen();
    expect(decode(report!.bytes).map((e) => e.timestamp)).toEqual([80_000, 80_000, 90_000, 95_000]);
    expect(h.rec.__diagnostics()).toMatchObject({ frozen: true, frames: 4 });
    release();
    expect(decode((await pending)!.bytes).map((e) => e.timestamp)).toEqual([
      80_000, 80_000, 90_000, 100_000,
    ]);
    expect(h.rec.__diagnostics()).toMatchObject({ frozen: true, frames: 4 });
  });

  it('yields to the page before scrubbing and compressing', async () => {
    const gzip = vi.fn(testGzip);
    let release!: () => void;
    const h = harness({
      gzip,
      yieldToHost: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    await started(h);
    h.emit(FULL, 90_000);
    const pending = h.rec.snapshot();
    await Promise.resolve();
    expect(gzip).not.toHaveBeenCalled();
    release();
    await pending;
    expect(gzip).toHaveBeenCalledTimes(1);
  });

  it('scrubs the snapshot exactly like a bug report replay', async () => {
    const h = harness();
    await started(h);
    h.emit(FULL, 90_000, { node: { type: 3, textContent: 'card 4111111111111111', id: 1 } });
    const text = gunzipSync(Buffer.from((await h.rec.snapshot())!.bytes)).toString('utf8');
    expect(text).not.toContain('4111111111111111');
    expect(text).toContain('[REDACTED:CC]');
  });

  it('declines while a bug report has frozen the window, and leaves that window intact', async () => {
    const h = harness();
    await started(h);
    h.emit(FULL, 90_000);
    h.rec.freeze();
    expect(await h.rec.snapshot()).toBeNull();
    expect(decode((await h.rec.takeFrozen())!.bytes).map((e) => e.timestamp)).toEqual([90_000]);
  });

  it('declines without a full snapshot to anchor the window', async () => {
    const h = harness();
    await started(h);
    h.emit(INCR, 90_000);
    expect(await h.rec.snapshot()).toBeNull();
    expect(h.rec.__size).toBe(1);
  });

  it('declines once killed, and before start', async () => {
    const idle = harness();
    expect(await idle.rec.snapshot()).toBeNull();
    const h = harness();
    await started(h);
    h.emit(FULL, 90_000);
    h.rec.kill();
    expect(await h.rec.snapshot()).toBeNull();
  });

  it('windowFromAnchor keeps the Meta event that sizes the player', () => {
    const frames = [
      { type: META, timestamp: 10 },
      { type: FULL, timestamp: 10 },
      { type: INCR, timestamp: 20 },
    ];
    expect(windowFromAnchor(frames, 0)).toEqual(frames);
    expect(windowFromAnchor([{ type: INCR, timestamp: 1 }], 0)).toEqual([]);
  });
});
