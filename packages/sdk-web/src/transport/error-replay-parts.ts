// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
//
// Replays on errors (spec 2026-10-11): the replay half of a queued error.
//
// The outbox holds JSON only (localStorage, 5 MB for every queued report), so
// an error's replay cannot ride IN its queued item. The error is queued first,
// replay-free, exactly as before, so a closed tab still delivers it on the next
// load. Its replay waits here, in memory, keyed by reportId, and every drain
// consults this table:
//   - pending: waiting for export or its 3 s deadline. The drain skips the
//     item; the crash sink drains again once that bounded wait settles.
//   - attach:  the drain sends the replay as the `session-replay` part, with
//     the attachment ref a bug report's replay carries.
//   - omitted: over the size limit or past the deadline. The drain sends the
//     error flagged `captureControl.replayOmitted`, as bug reports do.
// An entry goes when its item does (sent, rejected, discarded). Nothing here
// survives a reload: an error that outlives its page ships without a replay.
import type { AttachmentRef, ReportEnvelope } from '@everframe/protocol';
import type { OutboxItem, ReplayCapture } from '@everframe/sdk-core';
import { ERROR_REPLAY_DEADLINE_MS } from '../capture/replay/error-replay.js';
import type { ErrorReplayOutcome } from '../capture/replay/error-replay.js';

/** The part name bug-report replays use; multipart.ts maps it to kind `session-replay`. */
export const ERROR_REPLAY_PART = 'session-replay';

type Entry = { owner?: object; sdkKey?: string } & (
  | { state: 'pending' }
  | { state: 'attach'; capture: ReplayCapture }
  | { state: 'omitted' }
);

const entries = new Map<string, Entry>();
const pageOwner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function markErrorReplayPending(
  reportId: string,
  ownership: { owner: object; sdkKey: string } | undefined = undefined,
): Record<string, string> {
  entries.set(reportId, { state: 'pending', ...ownership });
  return {
    errorReplayOwner: pageOwner,
    errorReplayUntil: String(Date.now() + ERROR_REPLAY_DEADLINE_MS),
  };
}

/** Tiny persisted lease: reloads retain its original deadline, never its bytes. */
export function errorReplayHoldMs(item: OutboxItem): number {
  if (item.metadata?.['errorReplayOwner'] === pageOwner) return 0;
  const deadline = Number(item.metadata?.['errorReplayUntil']);
  if (!Number.isFinite(deadline) || deadline > item.enqueuedAt + ERROR_REPLAY_DEADLINE_MS) return 0;
  return Math.max(0, Math.min(ERROR_REPLAY_DEADLINE_MS, deadline - Date.now()));
}

/** Record how the export ended. Ignored when the report was discarded meanwhile. */
export function settleErrorReplay(reportId: string, outcome: ErrorReplayOutcome): void {
  const entry = entries.get(reportId);
  if (entry?.state !== 'pending') return;
  if (outcome.kind === 'attach')
    entries.set(reportId, { ...entry, state: 'attach', capture: outcome.capture });
  else if (outcome.kind === 'omitted') entries.set(reportId, { ...entry, state: 'omitted' });
  else entries.delete(reportId);
}

export function isErrorReplayPending(reportId: string): boolean {
  return entries.get(reportId)?.state === 'pending';
}

/** The server refused the error WITH its replay: send it without one, flagged. */
export function omitErrorReplay(reportId: string): void {
  if (entries.has(reportId)) entries.set(reportId, { state: 'omitted' });
}

export function forgetErrorReplay(reportId: string): void {
  entries.delete(reportId);
}

/** Consent withdrawal only revokes the capturing client's bytes. */
export function revokeErrorReplays(owner: object): void {
  for (const [reportId, entry] of entries) if (entry.owner === owner) entries.delete(reportId);
}

export function ownsErrorReplayBytes(reportId: string, bytes: Uint8Array): boolean {
  const entry = entries.get(reportId);
  return entry?.state === 'attach' && entry.capture.bytes === bytes;
}

/**
 * Apply this report's settled replay to the envelope a drain is about to send,
 * and return the multipart attachments to send with it. The ref is a seed:
 * buildMultipart restamps contentType, byteLength and sha256 from the bytes and
 * keeps format and durationMs (sdk-core transport/multipart.ts), so the digest
 * is computed once, at send time, as for every report attachment.
 */
export function applyErrorReplay(
  reportId: string,
  envelope: ReportEnvelope,
): Array<{ name: string; bytes: Uint8Array; contentType: string }> {
  const entry = entries.get(reportId);
  if (entry?.state === 'omitted') {
    (envelope.captureControl as { replayOmitted?: boolean }).replayOmitted = true;
    return [];
  }
  if (entry?.state !== 'attach') return [];
  const { capture } = entry;
  const seed: AttachmentRef = {
    partName: ERROR_REPLAY_PART,
    kind: 'session-replay',
    contentType: capture.contentType,
    byteLength: capture.bytes.byteLength,
    sha256: '', // restamped by buildMultipart
    format: capture.format,
    durationMs: capture.durationMs,
  };
  envelope.attachments = [
    ...(envelope.attachments ?? []).filter((a) => a.partName !== ERROR_REPLAY_PART),
    seed,
  ];
  return [{ name: ERROR_REPLAY_PART, bytes: capture.bytes, contentType: capture.contentType }];
}

/** Test seam. */
export function __resetErrorReplayPartsForTesting(): void {
  entries.clear();
}
