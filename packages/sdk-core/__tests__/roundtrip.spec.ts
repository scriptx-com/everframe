// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { ReportEnvelope } from '@everframe/protocol';
import { buildEnvelope } from '../src/envelope-builder.js';
import { applyRedaction } from '../src/redaction/engine.js';
import { buildMultipart } from '../src/transport/multipart.js';
import { createFakePlatformAdapter } from '../src/__test-helpers__/fake-platform-adapter.js';

describe('Phase 1 success criterion #2: round-trip envelope-build → redact → multipart → parse-back', () => {
  it.each(['traceitx-video-v1', 'everframe-video-v1'] as const)(
    'serializes %s input as the canonical Everframe video discriminator',
    (format) => {
      const envelope = buildEnvelope({
        reportId: '01939c34-7b8f-7000-8000-000000000777',
        submittedAt: '2026-04-29T16:00:00.000Z',
        sdk: { name: 'everframe-web', version: '0.9.0', platform: 'web', formFactor: 'desktop' },
        reporter: { title: 'Video', description: 'Compatibility' },
        draft: {
          title: 'Video', description: 'Compatibility', excludedArtifacts: [],
          annotations: [], redactions: [],
        },
        device: {
          os: 'macOS', osVersion: '14', screenSize: { width: 1, height: 1 },
          pixelRatio: 1, locale: 'en-US', timezone: 'UTC',
        },
        app: { name: 'video-app', version: '1.0.0' },
        attachments: [{
          partName: 'replay', kind: 'session-replay', format,
          contentType: 'video/mp4', byteLength: 100, sha256: 'a'.repeat(64),
          width: 394, height: 854, durationMs: 10_000, replayStartEpochMs: 1_000,
        }],
      });

      expect(envelope.attachments[0]?.format).toBe('everframe-video-v1');
      expect(JSON.stringify(envelope)).not.toContain('traceitx-video-v1');
    },
  );

  it('hand-crafted envelope survives the full pipeline with reportId preserved', async () => {
    const adapter = createFakePlatformAdapter();
    // Drive the adapter with non-trivial data so each pipeline stage has something to do.
    adapter.__setLogs([
      { level: 'info', message: 'roundtrip log entry', timestamp: 1000 },
    ]);
    adapter.__setNetwork([
      {
        method: 'GET',
        url: 'https://api.example.com/health',
        status: 200,
        startedAt: 999,
        headers: { 'content-type': 'application/json' },
      },
    ]);

    const focus = adapter.captureFocusedNode();
    const logs = adapter.captureRecentLogs();
    const network = adapter.captureRecentNetwork();
    const device = adapter.getDeviceMetadata();

    const draft = {
      title: 'Roundtrip test',
      description: 'Testing the full pipeline',
      excludedArtifacts: [],
      annotations: [],
      redactions: [],
    };

    const envelope = buildEnvelope({
      reportId: '01939c34-7b8f-7000-8000-000000000123',
      submittedAt: '2026-04-29T16:00:00.000Z',
      sdk: { name: 'everframe-react', version: '0.0.0', platform: 'web', formFactor: 'desktop' },
      reporter: { title: draft.title, description: draft.description },
      draft,
      focus,
      logs,
      network,
      device,
      app: { name: 'roundtrip-app', version: '1.0.0' },
      attachments: [],
    });

    // Stage 1: built envelope conforms to schema
    expect(ReportEnvelope.safeParse(envelope).success).toBe(true);

    // Stage 2: redaction
    const { envelope: redacted } = applyRedaction(envelope, {});
    expect(ReportEnvelope.safeParse(redacted).success).toBe(true);

    // Stage 3: multipart
    const { body } = await buildMultipart({ envelope: redacted, attachments: [] });

    // Stage 4: parse-back from FormData envelope blob
    const envelopeBlob = body.get('envelope') as Blob;
    const buf = new Uint8Array(await envelopeBlob.arrayBuffer());
    const text = new TextDecoder().decode(buf);
    const parsed = JSON.parse(text);
    const reparseResult = ReportEnvelope.safeParse(parsed);
    expect(reparseResult.success).toBe(true);
    if (reparseResult.success) {
      expect(reparseResult.data.reportId).toBe('01939c34-7b8f-7000-8000-000000000123');
      expect(reparseResult.data.protocolVersion).toBe('1.0');
    }
  });

  it('draft.extra (from setExtra) lands in payload.extra, and an over-cap value is omitted rather than sliced', () => {
    const base = {
      reportId: '01939c34-7b8f-7000-8000-000000000456',
      submittedAt: '2026-04-29T16:00:00.000Z',
      sdk: { name: 'everframe-react', version: '0.0.0', platform: 'web', formFactor: 'desktop' } as const,
      device: {
        os: 'macOS',
        osVersion: '14',
        screenSize: { width: 1, height: 1 },
        pixelRatio: 1,
        locale: 'en-US',
        timezone: 'UTC',
      },
      app: { name: 'extra-app', version: '1.0.0' },
      attachments: [],
    };
    const draftBase = { title: 't', description: 'd', excludedArtifacts: [], annotations: [], redactions: [] };

    // Present → copied through verbatim.
    const withExtra = buildEnvelope({
      ...base,
      reporter: { title: 't', description: 'd' },
      draft: { ...draftBase, extra: '{"orderId":"123"}' },
    });
    expect((withExtra.payload as { extra?: string }).extra).toBe('{"orderId":"123"}');
    expect(ReportEnvelope.safeParse(withExtra).success).toBe(true);

    // Over-cap → OMITTED, not sliced. Slicing serialized JSON produces a
    // fragment with no closing brace that nothing can parse — a missing
    // `extra` is recoverable, an unparseable one is not (see extra-budget.ts).
    const capped = buildEnvelope({
      ...base,
      reporter: { title: 't', description: 'd' },
      draft: { ...draftBase, extra: 'x'.repeat(20_000) },
    });
    expect('extra' in capped.payload).toBe(false);
    expect(ReportEnvelope.safeParse(capped).success).toBe(true);

    // Absent → no extra key emitted.
    const without = buildEnvelope({
      ...base,
      reporter: { title: 't', description: 'd' },
      draft: draftBase,
    });
    expect('extra' in without.payload).toBe(false);
  });
});
