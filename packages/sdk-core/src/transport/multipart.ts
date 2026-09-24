// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Multipart envelope builder — sha256 attachments + maybe-gzip envelope + 25 MB hard
// cap (PIPE-03). Envelope is gzipped when JSON byteLength > 8KB; servers detect via
// the gzip magic header on the envelope blob.
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { gzipBytes } from './compression.js';
import type { ReportEnvelope, AttachmentRef } from '@everframe/protocol';

export const HARD_CAP_BYTES = 25 * 1024 * 1024; // PIPE-03
export const GZIP_THRESHOLD = 8 * 1024; // CONTEXT.md locked

export interface MultipartParts {
  envelope: ReportEnvelope;
  attachments: Array<{ name: string; bytes: Uint8Array; contentType: string }>;
}

export class PayloadTooLargeError extends Error {
  public readonly actual: number;
  public readonly limit: number;
  constructor(actual: number, limit: number) {
    super(`Payload ${actual} bytes exceeds ${limit} byte cap (PIPE-03)`);
    this.name = 'PayloadTooLargeError';
    this.actual = actual;
    this.limit = limit;
  }
}

function classifyKind(name: string): AttachmentRef['kind'] {
  // Report-window overhaul: shot 1 keeps the bare names (backward compat);
  // shots 2..N ship as `screenshot-N` / `annotated-screenshot-N`. Both patterns
  // are fully anchored; the branch order is cosmetic, annotated first for
  // readability.
  if (name === 'annotated-screenshot' || /^annotated-screenshot-\d+$/.test(name)) {
    return 'annotated-screenshot';
  }
  if (name === 'screenshot' || /^screenshot-\d+$/.test(name)) return 'screenshot';
  // REPLAY-03 — the session-replay part is named 'session-replay' by
  // draft-to-envelope precisely so this re-derivation preserves the kind. Without
  // this case it falls through to 'other' and the admin Replay tab (which gates on
  // kind === 'session-replay') never renders.
  if (name === 'session-replay') return 'session-replay';
  return 'other';
}

export async function buildMultipart(parts: MultipartParts): Promise<{
  body: FormData;
  totalBytes: number;
  envelopeBytes: Uint8Array;
  envelopeContentEncoding?: 'gzip';
}> {
  // 1) sha256 + sizes for attachments; rebuild attachment refs
  const attachmentRefs: AttachmentRef[] = [];
  let totalBytes = 0;
  for (const att of parts.attachments) {
    const hashBytes = sha256(att.bytes);
    const hashHex = bytesToHex(hashBytes);
    const ref: AttachmentRef = {
      partName: att.name,
      kind: classifyKind(att.name),
      contentType: att.contentType,
      byteLength: att.bytes.byteLength,
      sha256: hashHex,
    };
    // Carry over width/height if the caller already had them in the envelope's
    // attachment list (e.g. screenshot dimensions).
    const existing = parts.envelope.attachments.find((a) => a.partName === att.name);
    if (existing?.width !== undefined) ref.width = existing.width;
    if (existing?.height !== undefined) ref.height = existing.height;
    // REPLAY-03 — preserve the session-replay discriminator + duration the
    // draft-to-envelope builder set; the rebuild above only restamps the
    // hashed/sized fields, so these would otherwise be dropped and the player
    // could not dispatch on `format` nor caption the poster with the duration.
    if (existing?.format !== undefined) ref.format = existing.format;
    if (existing?.durationMs !== undefined) ref.durationMs = existing.durationMs;
    attachmentRefs.push(ref);
    totalBytes += att.bytes.byteLength;
  }
  const finalEnvelope: ReportEnvelope = { ...parts.envelope, attachments: attachmentRefs };

  // 2) Serialize + maybe-gzip envelope
  const envelopeJson = new TextEncoder().encode(JSON.stringify(finalEnvelope));
  let envelopeBytes: Uint8Array = envelopeJson;
  let envelopeContentEncoding: 'gzip' | undefined;
  if (envelopeJson.byteLength > GZIP_THRESHOLD) {
    envelopeBytes = await gzipBytes(envelopeJson);
    envelopeContentEncoding = 'gzip';
  }
  totalBytes += envelopeBytes.byteLength;

  // 3) PIPE-03 hard cap
  if (totalBytes > HARD_CAP_BYTES) {
    throw new PayloadTooLargeError(totalBytes, HARD_CAP_BYTES);
  }

  // 4) Build FormData
  const fd = new FormData();
  const envelopeBlob = new Blob([envelopeBytes as BlobPart], { type: 'application/json' });
  fd.append('envelope', envelopeBlob, 'envelope.json');
  for (const att of parts.attachments) {
    const blob = new Blob([att.bytes as BlobPart], { type: att.contentType });
    fd.append(att.name, blob, att.name);
  }

  return {
    body: fd,
    totalBytes,
    envelopeBytes,
    ...(envelopeContentEncoding ? { envelopeContentEncoding } : {}),
  };
}
