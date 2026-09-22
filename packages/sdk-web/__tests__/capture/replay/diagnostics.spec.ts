// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// The recorder's contribution to the replay flight recorder. `takeFrozen()` has
// four distinct ways to hand back null and the field could not tell them apart —
// each one now names itself in the trace, and `__diagnostics()` reports the live
// state a CDP probe can read off a device.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  __enableReplayTrace,
  __getReplayTrace,
  __resetReplayTrace,
} from '@traceitx/sdk-core';
import { createReplayRecorder } from '../../../src/capture/replay/recorder.js';

const FULL = 2;
const INCR = 3;

const testGzip = async (input: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(gzipSync(Buffer.from(input)));

function recorderWithEmit(freezeAt = 1_000_000) {
  let emit: ((e: unknown, isCheckout?: boolean) => void) | undefined;
  const fakeRrweb = {
    record: (options: Record<string, unknown>) => {
      emit = options['emit'] as (e: unknown, isCheckout?: boolean) => void;
      return () => undefined;
    },
  };
  const rec = createReplayRecorder({
    importRrweb: async () => fakeRrweb,
    now: () => 0,
    freezeNow: () => freezeAt,
    gzip: testGzip,
  });
  return { rec, getEmit: () => emit! };
}

const find = (ev: string): Record<string, unknown> | undefined =>
  __getReplayTrace().find((e) => e.ev === ev);

describe('replay recorder diagnostics', () => {
  beforeEach(() => {
    __resetReplayTrace();
    __enableReplayTrace(true);
  });
  afterEach(() => {
    __resetReplayTrace();
  });

  it('reports an idle recorder as not recording', () => {
    const { rec } = recorderWithEmit();
    expect(rec.__diagnostics()).toMatchObject({ disabled: false, recording: false, frames: 0 });
  });

  it('reports the live frame count once rrweb emits', async () => {
    const { rec, getEmit } = recorderWithEmit();
    rec.start(30);
    await Promise.resolve();
    getEmit()({ type: FULL, timestamp: 1 }, true);
    getEmit()({ type: INCR, timestamp: 2 });
    expect(rec.__diagnostics()).toMatchObject({ frames: 2, hasAnchor: true, recording: true });
  });

  it('reports a buffer holding no full-snapshot anchor', async () => {
    const { rec, getEmit } = recorderWithEmit();
    rec.start(30);
    await Promise.resolve();
    getEmit()({ type: INCR, timestamp: 1 });
    expect(rec.__diagnostics()).toMatchObject({ frames: 1, hasAnchor: false });
  });

  it('traces an rrweb start that was skipped because freeze landed first', async () => {
    const { rec } = recorderWithEmit();
    rec.start(30);
    rec.freeze(); // freeze wins the race against the async import
    await Promise.resolve();
    await Promise.resolve();
    expect(find('recorder.rrwebSkipped')).toMatchObject({ reason: 'frozen' });
  });

  it('traces a successful rrweb start', async () => {
    const { rec } = recorderWithEmit();
    rec.start(30);
    await Promise.resolve();
    expect(find('recorder.rrwebStarted')).toBeDefined();
  });

  it('names an empty buffer as the reason takeFrozen returned null', async () => {
    const { rec } = recorderWithEmit();
    rec.start(30);
    await Promise.resolve();
    rec.freeze();
    expect(await rec.takeFrozen()).toBeNull();
    expect(find('recorder.takeFrozen')).toMatchObject({ result: 'empty' });
  });

  it('names a missing anchor as the reason takeFrozen returned null', async () => {
    const { rec, getEmit } = recorderWithEmit();
    rec.start(30);
    await Promise.resolve();
    getEmit()({ type: INCR, timestamp: 1 });
    rec.freeze();
    expect(await rec.takeFrozen()).toBeNull();
    expect(find('recorder.takeFrozen')).toMatchObject({ result: 'no_anchor', frames: 1 });
  });

  it('names a freeze cutoff that trimmed every frame', async () => {
    const { rec, getEmit } = recorderWithEmit(0); // freeze instant precedes every frame
    rec.start(30);
    await Promise.resolve();
    getEmit()({ type: FULL, timestamp: 5 }, true);
    rec.freeze();
    expect(await rec.takeFrozen()).toBeNull();
    expect(find('recorder.takeFrozen')).toMatchObject({ result: 'trimmed_empty' });
  });

  it('traces a successful take with its kept-frame count', async () => {
    const { rec, getEmit } = recorderWithEmit();
    rec.start(30);
    await Promise.resolve();
    getEmit()({ type: FULL, timestamp: 1 }, true);
    getEmit()({ type: INCR, timestamp: 2 });
    rec.freeze();
    expect(await rec.takeFrozen()).not.toBeNull();
    expect(find('recorder.takeFrozen')).toMatchObject({ result: 'ok', kept: 2 });
  });

  it('traces a self-disable with the reason that caused it', async () => {
    let emit: ((e: unknown, isCheckout?: boolean) => void) | undefined;
    const rec = createReplayRecorder({
      importRrweb: async () => ({
        record: (options: Record<string, unknown>) => {
          emit = options['emit'] as (e: unknown, isCheckout?: boolean) => void;
          return () => undefined;
        },
      }),
      now: () => 0,
      gzip: testGzip,
    });
    rec.start(30);
    await Promise.resolve();
    // No takeFullSnapshot on the fake module ⇒ a cap breach cannot re-anchor.
    emit!({ type: FULL, timestamp: 1, data: { pad: 'x'.repeat(5 * 1024 * 1024) } }, true);
    expect(rec.disabled).toBe(true);
    expect(find('recorder.selfDisable')).toMatchObject({ reason: 'overflow_no_reanchor' });
  });
});
