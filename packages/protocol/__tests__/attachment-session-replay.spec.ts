// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { AttachmentRef, AttachmentKind, ReplayFormat } from '../src/index.js';

// REPLAY-03 contract (Phase 20): the protocol attachment seam carries
// session-replay refs. The change is purely additive — `format` + `durationMs`
// are optional, so every pre-Phase-20 attachment ref still parses (PAY-01).
describe('REPLAY-03 session-replay attachment ref', () => {
  it('accepts kind:session-replay with format:rrweb + durationMs', () => {
    const result = AttachmentRef.safeParse({
      partName: 'replay-0',
      kind: 'session-replay',
      contentType: 'application/octet-stream',
      byteLength: 12_345,
      sha256: 'a'.repeat(64),
      format: 'rrweb',
      durationMs: 30_000,
    });
    if (!result.success) console.error(JSON.stringify(result.error, null, 2));
    expect(result.success).toBe(true);
  });

  it('accepts the native vtree format value (forward-compat for phases 21–25)', () => {
    expect(ReplayFormat.safeParse('traceitx-vtree-v1').success).toBe(true);
    expect(ReplayFormat.safeParse('rrweb').success).toBe(true);
  });

  it('exposes session-replay on the AttachmentKind enum', () => {
    expect(AttachmentKind.safeParse('session-replay').success).toBe(true);
  });

  it('still parses an old-shape ref with no format/durationMs (additive-compat)', () => {
    const result = AttachmentRef.safeParse({
      partName: 'shot-0',
      kind: 'screenshot',
      contentType: 'image/png',
      byteLength: 999,
      sha256: 'b'.repeat(64),
      width: 100,
      height: 200,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.format).toBeUndefined();
      expect(result.data.durationMs).toBeUndefined();
    }
  });

  it('rejects an unknown format value', () => {
    expect(ReplayFormat.safeParse('mp4').success).toBe(false);
  });
});
