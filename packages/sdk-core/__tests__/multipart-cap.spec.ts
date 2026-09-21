// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import {
  buildMultipart,
  PayloadTooLargeError,
  GZIP_THRESHOLD,
  HARD_CAP_BYTES,
} from '../src/transport/multipart.js';
import { buildSeededPIIEnvelope } from '../src/__test-helpers__/seeded-pii.js';

describe('PIPE-03: 25 MB hard cap', () => {
  it('throws PayloadTooLargeError when totalBytes exceeds HARD_CAP_BYTES', async () => {
    const env = buildSeededPIIEnvelope();
    const big = new Uint8Array(HARD_CAP_BYTES + 1);
    await expect(
      buildMultipart({
        envelope: env,
        attachments: [
          { name: 'huge', bytes: big, contentType: 'application/octet-stream' },
        ],
      })
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it('PayloadTooLargeError carries actual + limit', async () => {
    const env = buildSeededPIIEnvelope();
    const big = new Uint8Array(HARD_CAP_BYTES + 100);
    try {
      await buildMultipart({
        envelope: env,
        attachments: [
          { name: 'huge', bytes: big, contentType: 'application/octet-stream' },
        ],
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PayloadTooLargeError);
      const err = e as PayloadTooLargeError;
      expect(err.actual).toBeGreaterThan(HARD_CAP_BYTES);
      expect(err.limit).toBe(HARD_CAP_BYTES);
    }
  });
});

describe('multipart compression threshold', () => {
  it('does NOT compress when envelope JSON <= 8KB', async () => {
    const env = buildSeededPIIEnvelope();
    const result = await buildMultipart({ envelope: env, attachments: [] });
    expect(result.envelopeContentEncoding).toBeUndefined();
    // First byte of raw JSON envelope bytes is '{' (0x7B)
    expect(result.envelopeBytes[0]).toBe(0x7b);
  });

  it('compresses when envelope JSON > 8KB', async () => {
    const env = buildSeededPIIEnvelope();
    // Pad description to push envelope past 8KB
    (env as unknown as { reporter: { description: string } }).reporter.description =
      'X'.repeat(GZIP_THRESHOLD + 100);
    const result = await buildMultipart({ envelope: env, attachments: [] });
    expect(result.envelopeContentEncoding).toBe('gzip');
    expect(result.envelopeBytes[0]).toBe(0x1f);
    expect(result.envelopeBytes[1]).toBe(0x8b);
  });

  it('overwrites attachment.sha256 with computed hex (64 chars)', async () => {
    const env = buildSeededPIIEnvelope();
    const data = new Uint8Array([1, 2, 3, 4]);
    const result = await buildMultipart({
      envelope: env,
      attachments: [{ name: 'screenshot', bytes: data, contentType: 'image/png' }],
    });
    const envelopeBlob = result.body.get('envelope') as Blob;
    const buf = new Uint8Array(await envelopeBlob.arrayBuffer());
    const text = new TextDecoder().decode(buf);
    const parsed = JSON.parse(text);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.attachments[0].partName).toBe('screenshot');
    expect(parsed.attachments[0].kind).toBe('screenshot');
    expect(parsed.attachments[0].byteLength).toBe(4);
  });
});

describe('REPLAY-03: session-replay attachment discriminator preserved', () => {
  it('keeps kind=session-replay (not "other") and carries format + durationMs', async () => {
    const env = buildSeededPIIEnvelope();
    // draft-to-envelope sets these on the ref; buildMultipart rebuilds refs from
    // the binary parts, so it must preserve the replay discriminator + duration.
    (env as unknown as { attachments: unknown[] }).attachments = [
      {
        partName: 'session-replay',
        kind: 'session-replay',
        contentType: 'application/octet-stream',
        byteLength: 3,
        sha256: '0'.repeat(64),
        format: 'rrweb',
        durationMs: 30000,
      },
    ];
    const result = await buildMultipart({
      envelope: env,
      attachments: [
        {
          name: 'session-replay',
          bytes: new Uint8Array([1, 2, 3]),
          contentType: 'application/octet-stream',
        },
      ],
    });
    const envelopeBlob = result.body.get('envelope') as Blob;
    const parsed = JSON.parse(
      new TextDecoder().decode(new Uint8Array(await envelopeBlob.arrayBuffer())),
    );
    const replay = parsed.attachments.find(
      (a: { partName: string }) => a.partName === 'session-replay',
    );
    expect(replay).toBeDefined();
    expect(replay.kind).toBe('session-replay');
    expect(replay.format).toBe('rrweb');
    expect(replay.durationMs).toBe(30000);
  });
});
