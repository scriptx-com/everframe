// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Codex round 2, finding 2. `start()` imports rrweb asynchronously and the
// callback only checked the CURRENT `disabled`/`frozen`. Two starts inside one
// import window (the chunk takes ~800ms on the TV) both called `record()`; the
// second overwrote `stopFn`, so the first recorder could never be stopped —
// a leaked set of DOM observers feeding duplicate frames into the buffer.
//
// The retry added for the 2026-08-27 replay-start fix makes this reachable in
// the boot window it previously could not occur in, so each start carries a
// generation and a superseded one stands down.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  __enableReplayTrace,
  __getReplayTrace,
  __resetReplayTrace,
} from '@traceitx/sdk-core';
import { createReplayRecorder } from '../../../src/capture/replay/recorder.js';

const testGzip = async (input: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(gzipSync(Buffer.from(input)));

/** rrweb whose import resolves only when the test releases it. */
function deferredRrweb() {
  let recordCalls = 0;
  const stops: number[] = [];
  const releases: Array<() => void> = [];
  const mod = {
    record: () => {
      const id = ++recordCalls;
      return () => stops.push(id);
    },
  };
  const importRrweb = (): Promise<typeof mod> =>
    new Promise((resolve) => releases.push(() => resolve(mod)));
  return {
    importRrweb,
    releaseAll: () => releases.splice(0).forEach((r) => r()),
    get recordCalls() {
      return recordCalls;
    },
    stops,
  };
}

describe('concurrent rrweb starts', () => {
  beforeEach(() => {
    __resetReplayTrace();
    __enableReplayTrace(true);
  });
  afterEach(() => __resetReplayTrace());

  it('runs only the newest start when two land in one import window', async () => {
    const rrweb = deferredRrweb();
    const rec = createReplayRecorder({ importRrweb: rrweb.importRrweb, gzip: testGzip });

    rec.start(30); // generation 1
    rec.start(30); // generation 2, before the first import resolves
    rrweb.releaseAll();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(rrweb.recordCalls).toBe(1);
  });

  it('traces the superseded start rather than dropping it silently', async () => {
    const rrweb = deferredRrweb();
    const rec = createReplayRecorder({ importRrweb: rrweb.importRrweb, gzip: testGzip });

    rec.start(30);
    rec.start(30);
    rrweb.releaseAll();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(__getReplayTrace().find((e) => e.ev === 'recorder.rrwebSkipped')).toMatchObject({
      reason: 'superseded',
    });
  });

  it('leaves a single start working normally', async () => {
    const rrweb = deferredRrweb();
    const rec = createReplayRecorder({ importRrweb: rrweb.importRrweb, gzip: testGzip });

    rec.start(30);
    rrweb.releaseAll();
    await Promise.resolve();
    await Promise.resolve();

    expect(rrweb.recordCalls).toBe(1);
    expect(rec.__diagnostics().recording).toBe(true);
  });

  it('does not start a recorder after stop() invalidated the pending import', async () => {
    const rrweb = deferredRrweb();
    const rec = createReplayRecorder({ importRrweb: rrweb.importRrweb, gzip: testGzip });

    rec.start(30);
    rec.stop();
    rrweb.releaseAll();
    await Promise.resolve();
    await Promise.resolve();

    expect(rrweb.recordCalls).toBe(0);
  });
});
