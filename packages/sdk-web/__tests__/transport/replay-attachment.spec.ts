// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// REPLAY-03 — submitted envelope carries exactly one session-replay ref.
// Turned RED→GREEN in plan 20-04.
//
// Contract (RESEARCH §"REPLAY-03", protocol seam shipped in 20-01):
//   - the submitted envelope carries EXACTLY ONE attachment with
//     kind:'session-replay', format:'rrweb', and a numeric durationMs.
import { describe, it, expect } from 'vitest';
import { AttachmentRef } from '@everframe/protocol';
import { draftToEnvelope, type CaptureBundle } from '../../src/transport/draft-to-envelope.js';
import type { ReportDraft, ReplayCapture } from '@everframe/sdk-core';
import type { WebEverframeConfig } from '../../src/internal/types.js';

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

function replay(byteLen = 1024): ReplayCapture {
  return {
    format: 'rrweb',
    bytes: new Uint8Array(byteLen),
    durationMs: 30_000,
    contentType: 'application/octet-stream',
  };
}

describe('REPLAY-03 envelope replay attachment', () => {
  it('envelope carries exactly one kind:session-replay attachment', () => {
    const { envelope, attachments } = draftToEnvelope(
      draft,
      bundle({ replayCapture: replay(), replaySha256: 'b'.repeat(64) }),
      config,
      '0.0.0',
    );
    const replayRefs = envelope.attachments.filter((a) => a.kind === 'session-replay');
    expect(replayRefs).toHaveLength(1);
    expect(attachments.filter((a) => a.kind === 'session-replay')).toHaveLength(1);
  });

  it("the replay ref has format:'rrweb' and a numeric durationMs and validates", () => {
    const { envelope } = draftToEnvelope(
      draft,
      bundle({ replayCapture: replay(), replaySha256: 'c'.repeat(64) }),
      config,
      '0.0.0',
    );
    const ref = envelope.attachments.find((a) => a.kind === 'session-replay')!;
    expect(ref.format).toBe('rrweb');
    expect(ref.durationMs).toBe(30_000);
    expect(ref.partName).toBe('session-replay');
    expect(ref.byteLength).toBe(1024);
    expect(AttachmentRef.safeParse(ref).success).toBe(true);
  });

  it('no replay ref is added when no capture is present', () => {
    const { envelope } = draftToEnvelope(draft, bundle(), config, '0.0.0');
    expect(envelope.attachments.some((a) => a.kind === 'session-replay')).toBe(false);
  });

  it('no replay ref is added when replay is in excludedArtifacts', () => {
    const excludedDraft: ReportDraft = { ...draft, excludedArtifacts: ['replay'] };
    const { envelope } = draftToEnvelope(
      excludedDraft,
      bundle({ replayCapture: replay(), replaySha256: 'd'.repeat(64) }),
      config,
      '0.0.0',
    );
    expect(envelope.attachments.some((a) => a.kind === 'session-replay')).toBe(false);
  });

  it('an empty capture (0 bytes) emits no ref', () => {
    const { envelope } = draftToEnvelope(
      draft,
      bundle({ replayCapture: replay(0), replaySha256: 'e'.repeat(64) }),
      config,
      '0.0.0',
    );
    expect(envelope.attachments.some((a) => a.kind === 'session-replay')).toBe(false);
  });
});
