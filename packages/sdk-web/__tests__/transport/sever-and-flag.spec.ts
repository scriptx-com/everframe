// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// RWEB-02 — 8 MB sever-and-flag (HIGHEST-LIABILITY GATE).
// Turned RED→GREEN in plan 20-04.
//
// Contract (RESEARCH §"Ingest recognition", §"Highest-Liability Gates"):
//   - when the compressed replay exceeds the 8 MB client budget, the replay is
//     DROPPED and `replayOmitted` is set — but the report STILL sends.
//   - the attachment bytes are COMPRESSED (never raw JSON).
//   - the server-side ingest cap (MAX_TOTAL_BYTES = 25 MB) is never raised.
import { describe, it, expect, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import {
  draftToEnvelope,
  REPLAY_BYTE_CAP,
  type CaptureBundle,
} from '../../src/transport/draft-to-envelope.js';
import { submitReportFromDraft } from '../../src/transport/submit.js';
import { createReplayRecorder } from '../../src/capture/replay/recorder.js';
import type { ReportDraft, ReplayCapture } from '@everframe/sdk-core';
import type { WebEverframeConfig } from '../../src/internal/types.js';
import { gzipSync } from 'node:zlib';

const config: WebEverframeConfig = { apiKey: 'txx_live_test', appName: 'a', appVersion: '1.0.0' };
const draft: ReportDraft = {
  title: 'X',
  description: 'Y',
  excludedArtifacts: [],
  annotations: [],
  redactions: [],
};

function bundle(over: Partial<CaptureBundle> = {}): CaptureBundle {
  return {
    screenshotBlob: null,
    screenshotSha256: null,
    screenshotWidth: 0,
    screenshotHeight: 0,
    focused: null,
    logs: [],
    network: [],
    metadata: null,
    ...over,
  };
}

const testGzip = async (input: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(gzipSync(Buffer.from(input)));

describe('RWEB-02 sever-and-flag over budget', () => {
  it('the 8 MB client cap is the documented budget', () => {
    expect(REPLAY_BYTE_CAP).toBe(8_000_000);
  });

  it('drops replay + sets replayOmitted when compressed bytes exceed 8 MB', () => {
    const oversized: ReplayCapture = {
      format: 'rrweb',
      bytes: new Uint8Array(REPLAY_BYTE_CAP + 1),
      durationMs: 30_000,
      contentType: 'application/octet-stream',
    };
    const { envelope, attachments } = draftToEnvelope(
      draft,
      bundle({ replayCapture: oversized, replaySha256: 'f'.repeat(64) }),
      config,
      '0.0.0',
    );
    expect(envelope.attachments.some((a) => a.kind === 'session-replay')).toBe(false);
    expect(attachments.some((a) => a.kind === 'session-replay')).toBe(false);
    expect((envelope.captureControl as { replayOmitted?: boolean }).replayOmitted).toBe(true);
  });

  it('the report still sends when the replay is severed (delivery never blocked)', async () => {
    const oversized: ReplayCapture = {
      format: 'rrweb',
      bytes: new Uint8Array(REPLAY_BYTE_CAP + 1),
      durationMs: 30_000,
      contentType: 'application/octet-stream',
    };
    const fakeFetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const outcome = await submitReportFromDraft({
      config,
      sdkVersion: '0.0.0',
      draft,
      bundle: bundle({ replayCapture: oversized, replaySha256: 'a'.repeat(64) }),
      outbox: undefined,
      fetch: fakeFetch as unknown as typeof fetch,
    });
    expect(outcome.ok).toBe(true);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('an in-budget replay attaches and its bytes are compressed (not raw JSON)', async () => {
    // Build a real capture through the recorder so the bytes are genuinely gzipped.
    let emit: ((e: unknown, isCheckout?: boolean) => void) | undefined;
    const rec = createReplayRecorder({
      importRrweb: async () => ({
        record: (o: Record<string, unknown>) => {
          emit = o['emit'] as typeof emit;
          return () => undefined;
        },
      }),
      now: () => 0,
      gzip: testGzip,
    });
    rec.start(30);
    await Promise.resolve();
    await Promise.resolve();
    const rawEvents = [
      { type: 2, timestamp: 0, data: { node: { id: 1, tag: 'div' } } },
      { type: 3, timestamp: 10, data: { source: 2 } },
    ];
    emit!(rawEvents[0], true);
    emit!(rawEvents[1], false);
    rec.freeze();
    const capture = await rec.takeFrozen();
    expect(capture).not.toBeNull();
    // Bytes are gzip-compressed (round-trip to JSON, and a gzip magic header).
    const decompressed = gunzipSync(Buffer.from(capture!.bytes)).toString('utf8');
    expect(JSON.parse(decompressed)).toBeInstanceOf(Array);
    expect(capture!.bytes[0]).toBe(0x1f); // gzip magic byte 1
    expect(capture!.bytes[1]).toBe(0x8b); // gzip magic byte 2

    // And it attaches as exactly one in-budget ref.
    const { envelope } = draftToEnvelope(
      draft,
      bundle({ replayCapture: capture, replaySha256: 'b'.repeat(64) }),
      config,
      '0.0.0',
    );
    expect(envelope.attachments.filter((a) => a.kind === 'session-replay')).toHaveLength(1);
    expect((envelope.captureControl as { replayOmitted?: boolean }).replayOmitted).toBeUndefined();
  });
});
