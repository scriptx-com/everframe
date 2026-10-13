// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Replays on errors (spec 2026-10-11): the outbox holds JSON only, so a queued
// error's replay waits in memory and every drain consults it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sha256BytesHex,
  type OutboxAdapter,
  type OutboxItem,
  type ReplayCapture,
} from '@everframe/sdk-core';
import {
  discardEnqueuedReport,
  drainOutbox,
  drainOutboxWhileOwned,
  recordEnqueuedIdentitySubject,
} from '../../src/transport/submit.js';
import {
  ERROR_REPLAY_PART,
  applyErrorReplay,
  __resetErrorReplayPartsForTesting,
  isErrorReplayPending,
  markErrorReplayPending,
  settleErrorReplay,
  revokeErrorReplays,
} from '../../src/transport/error-replay-parts.js';
import { readBlobArrayBuffer } from '../../src/internal/blob.js';

const REPLAY: ReplayCapture = {
  format: 'rrweb',
  bytes: new Uint8Array([1, 2, 3, 4]),
  durationMs: 2_500,
  contentType: 'application/octet-stream',
};

function outboxOf(items: OutboxItem[]): OutboxAdapter & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async enqueue() {},
    async list() {
      return items.filter((item) => !deleted.includes(item.reportId));
    },
    async delete(reportId: string) {
      deleted.push(reportId);
    },
  };
}

function errorItem(reportId: string): OutboxItem {
  const envelope = {
    reportId,
    source: 'error',
    captureControl: { included: [], excluded: [] },
    attachments: [],
  };
  return {
    reportId,
    enqueuedAt: 1,
    attempts: 0,
    payload: new TextEncoder().encode(JSON.stringify(envelope)),
    metadata: { url: 'https://ingest.example.com/api/ingest', sdkKey: 'key-A' },
  };
}

type Sent = {
  envelope: Record<string, any>;
  replay: Uint8Array | null;
  headers: Record<string, string>;
};

function server(statuses: number[]) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: { body?: unknown; headers?: unknown }) => {
    const body = init?.body as FormData;
    const envelope = JSON.parse(await (body.get('envelope') as Blob).text()) as Record<string, any>;
    const part = body.get(ERROR_REPLAY_PART) as Blob | null;
    sent.push({
      envelope,
      replay: part ? new Uint8Array(await readBlobArrayBuffer(part)) : null,
      headers: init?.headers as Record<string, string>,
    });
    return new Response(JSON.stringify({ status: 'received' }), {
      status: statuses.shift() ?? 200,
    });
  });
  return { sent, fetch };
}

const drain = (outbox: OutboxAdapter, fetch: unknown) =>
  drainOutbox({
    outbox,
    config: { sdkKey: 'key-A' } as never,
    sdkVersion: 'test',
    fetch: fetch as never,
    retryScheduleMs: [],
  });

afterEach(() => __resetErrorReplayPartsForTesting());

describe('error replays in the outbox drain', () => {
  it('leaves an error whose replay is still exporting for its own drain', async () => {
    markErrorReplayPending('r-1');
    const outbox = outboxOf([errorItem('r-1')]);
    const { fetch } = server([]);
    const result = await drain(outbox, fetch);
    expect(fetch).not.toHaveBeenCalled();
    expect(outbox.deleted).toEqual([]);
    expect(result).toMatchObject({ submitted: 0, failed: 0 });
  });

  it('sends a settled replay as the session-replay part, with the bug-report ref', async () => {
    markErrorReplayPending('r-1');
    settleErrorReplay('r-1', { kind: 'attach', capture: REPLAY });
    const outbox = outboxOf([errorItem('r-1')]);
    const { sent, fetch } = server([]);
    await drain(outbox, fetch);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.replay).toEqual(REPLAY.bytes);
    expect(sent[0]!.envelope.attachments).toEqual([
      {
        partName: 'session-replay',
        kind: 'session-replay',
        contentType: 'application/octet-stream',
        byteLength: 4,
        sha256: sha256BytesHex(REPLAY.bytes),
        format: 'rrweb',
        durationMs: 2_500,
      },
    ]);
    expect(outbox.deleted).toEqual(['r-1']);
    expect(isErrorReplayPending('r-1')).toBe(false);
  });

  it('flags an omitted replay like a bug report and sends no part', async () => {
    markErrorReplayPending('r-1');
    settleErrorReplay('r-1', { kind: 'omitted', reason: 'deadline' });
    const { sent, fetch } = server([]);
    await drain(outboxOf([errorItem('r-1')]), fetch);
    expect(sent[0]!.replay).toBeNull();
    expect(sent[0]!.envelope.attachments).toEqual([]);
    expect(sent[0]!.envelope.captureControl.replayOmitted).toBe(true);
  });

  it('keeps the replay for the next drain after a transient failure', async () => {
    markErrorReplayPending('r-1');
    settleErrorReplay('r-1', { kind: 'attach', capture: REPLAY });
    const outbox = outboxOf([errorItem('r-1')]);
    const { sent, fetch } = server([503]);
    await drain(outbox, fetch);
    expect(outbox.deleted).toEqual([]);
    await drain(outbox, fetch);
    expect(sent.map((s) => s.replay !== null)).toEqual([true, true]);
    expect(outbox.deleted).toEqual(['r-1']);
  });

  it('revokes only the capturing owner and preserves another app replay', async () => {
    const ownerA = {},
      ownerB = {};
    markErrorReplayPending('r-1', { owner: ownerA, sdkKey: 'key-A' });
    markErrorReplayPending('r-2', { owner: ownerB, sdkKey: 'key-B' });
    settleErrorReplay('r-1', { kind: 'attach', capture: REPLAY });
    settleErrorReplay('r-2', { kind: 'attach', capture: REPLAY });
    revokeErrorReplays(ownerA);
    const itemB = errorItem('r-2');
    itemB.metadata!['sdkKey'] = 'key-B';
    const { sent, fetch } = server([]);
    await drain(outboxOf([errorItem('r-1'), itemB]), fetch);
    expect(sent.map((s) => s.replay !== null)).toEqual([false, true]);
    expect(sent[1]!.headers.Authorization).toBe('Bearer key-B');
  });

  it('resends once without the replay when the server refuses it, so the error is never lost', async () => {
    markErrorReplayPending('r-1');
    settleErrorReplay('r-1', { kind: 'attach', capture: REPLAY });
    const outbox = outboxOf([errorItem('r-1')]);
    const { sent, fetch } = server([400]);
    const result = await drain(outbox, fetch);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.replay).toBeNull();
    expect(sent[1]!.envelope.attachments).toEqual([]);
    expect(sent[1]!.envelope.captureControl.replayOmitted).toBe(true);
    expect(result.submitted).toBe(1);
    expect(outbox.deleted).toEqual(['r-1']);
  });

  it('forgets the replay when its queued error is discarded', async () => {
    markErrorReplayPending('r-1');
    settleErrorReplay('r-1', { kind: 'attach', capture: REPLAY });
    await discardEnqueuedReport(outboxOf([]), 'r-1');
    const { sent, fetch } = server([]);
    await drain(outboxOf([errorItem('r-1')]), fetch);
    expect(sent[0]!.replay).toBeNull();
  });
  it('lets other queued errors through while one replay is pending', async () => {
    markErrorReplayPending('r-1');
    const outbox = outboxOf([errorItem('r-1'), errorItem('r-2')]);
    const { sent, fetch } = server([]);
    await drain(outbox, fetch);
    expect(sent.map((s) => s.envelope.reportId)).toEqual(['r-2']);
    expect(outbox.deleted).toEqual(['r-2']);
  });

  it.each([200, 401, 400])(
    'cleans up settled replay state after terminal status %s',
    async (status) => {
      markErrorReplayPending('r-1');
      settleErrorReplay('r-1', { kind: 'attach', capture: REPLAY });
      const outbox = outboxOf([errorItem('r-1')]);
      const { fetch } = server([status, status]);
      await drain(outbox, fetch);
      expect(outbox.deleted).toEqual(['r-1']);
      const envelope = JSON.parse(new TextDecoder().decode(errorItem('r-1').payload));
      expect(applyErrorReplay('r-1', envelope)).toEqual([]);
      expect(envelope.captureControl.replayOmitted).toBeUndefined();
    },
  );

  it('does not resurrect a replay whose pending error was discarded', async () => {
    markErrorReplayPending('r-1');
    await discardEnqueuedReport(outboxOf([]), 'r-1');
    settleErrorReplay('r-1', { kind: 'attach', capture: REPLAY });
    const { sent, fetch } = server([]);
    await drain(outboxOf([errorItem('r-1')]), fetch);
    expect(sent[0]!.replay).toBeNull();
  });

  it.each([false, true])(
    'preserves per-item identity and consent on the fallback (foreign=%s)',
    async (foreign) => {
      const token = `${btoa(JSON.stringify({ alg: 'HS256' }))}.${btoa(JSON.stringify({ sub: 'alice', exp: 4_000_000_000 }))}.sig`;
      const deviceToken = `evr_${'a'.repeat(43)}`;
      markErrorReplayPending('r-1');
      settleErrorReplay('r-1', { kind: 'attach', capture: REPLAY });
      recordEnqueuedIdentitySubject('r-1', 'alice');
      const { sent, fetch } = server([400]);
      await drainOutbox({
        outbox: outboxOf([errorItem('r-1')]),
        config: { sdkKey: foreign ? 'key-B' : 'key-A', replies: { disabled: true } },
        sdkVersion: 'test',
        fetch: fetch as never,
        retryScheduleMs: [],
        identityToken: { get: async () => token },
        credentials: {
          load: async () => deviceToken,
          save: async () => {},
          clear: async () => {},
          randomBytes: (n: number) => new Uint8Array(n),
        },
      });
      expect(sent).toHaveLength(2);
      for (const attempt of sent) {
        expect(attempt.headers.Authorization).toBe('Bearer key-A');
        expect(attempt.headers['X-Everframe-Replies-Opt-Out']).toBe('1');
        expect(attempt.headers['X-Everframe-Device-Token']).toBe(foreign ? undefined : deviceToken);
        expect(attempt.headers['X-Everframe-Identity-Token']).toBe(foreign ? undefined : token);
      }
    },
  );

  it('stops before the fallback if capture ownership is released', async () => {
    markErrorReplayPending('r-1');
    settleErrorReplay('r-1', { kind: 'attach', capture: REPLAY });
    const outbox = outboxOf([errorItem('r-1')]);
    let owned = true;
    const fetch = vi.fn(async () => {
      owned = false;
      return new Response('{}', { status: 400 });
    });
    await drainOutboxWhileOwned(
      {
        outbox,
        config: { sdkKey: 'key-A' },
        sdkVersion: 'test',
        fetch,
        retryScheduleMs: [],
      },
      () => owned,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(outbox.deleted).toEqual([]);
    const { sent, fetch: retry } = server([]);
    await drain(outbox, retry);
    expect(sent[0]!.replay).toEqual(REPLAY.bytes);
  });

  it('retains the omitted flag for retry when the replay-free fallback is transient', async () => {
    markErrorReplayPending('r-1');
    settleErrorReplay('r-1', { kind: 'attach', capture: REPLAY });
    const outbox = outboxOf([errorItem('r-1')]);
    const { sent, fetch } = server([400, 503]);
    await drain(outbox, fetch);
    expect(outbox.deleted).toEqual([]);
    await drain(outbox, fetch);
    expect(sent.map((s) => s.replay !== null)).toEqual([true, false, false]);
    expect(sent[2]!.envelope.captureControl.replayOmitted).toBe(true);
    expect(outbox.deleted).toEqual(['r-1']);
  });

  it('cleans up replay state when an unroutable error is dropped', async () => {
    markErrorReplayPending('r-1');
    settleErrorReplay('r-1', { kind: 'attach', capture: REPLAY });
    const item = errorItem('r-1');
    delete item.metadata!['sdkKey'];
    const outbox = outboxOf([item]);
    const { fetch } = server([]);
    await drain(outbox, fetch);
    expect(fetch).not.toHaveBeenCalled();
    expect(outbox.deleted).toEqual(['r-1']);
    const envelope = JSON.parse(new TextDecoder().decode(item.payload));
    expect(applyErrorReplay('r-1', envelope)).toEqual([]);
  });
});
