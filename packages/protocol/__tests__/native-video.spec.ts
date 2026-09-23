// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { AttachmentRef } from '../src/attachments.js';

const video = {
  partName: 'replay', kind: 'session-replay', format: 'everframe-video-v1',
  contentType: 'video/mp4', byteLength: 100, sha256: 'a'.repeat(64),
  width: 394, height: 854, durationMs: 10000, replayStartEpochMs: 1000,
};

describe('native video attachment', () => {
  it.each(['traceitx-video-v1', 'everframe-video-v1'] as const)(
    'accepts persisted %s MP4 replay metadata',
    (format) => {
      const input = { ...video, format };
      const parsed = AttachmentRef.parse(input);
      expect(parsed).toEqual(input);
    },
  );

  it('uses the Everframe discriminator for a newly constructed video attachment', () => {
    expect(video.format).toBe('everframe-video-v1');
  });

  it.each(['width', 'height', 'durationMs', 'replayStartEpochMs'])('requires %s', (field) => {
    expect(AttachmentRef.safeParse({ ...video, [field]: undefined }).success).toBe(false);
  });

  it.each([
    { kind: 'video' }, { contentType: 'application/gzip' },
    { width: 0 }, { height: -1 }, { width: 1.5 },
    { durationMs: -1 }, { durationMs: Infinity },
    { replayStartEpochMs: -1 }, { replayStartEpochMs: NaN },
  ])('rejects invalid video metadata %j', (patch) => {
    expect(AttachmentRef.safeParse({ ...video, ...patch }).success).toBe(false);
  });

  it.each(['rrweb', 'traceitx-vtree-v1'])('preserves %s attachment decoding', (format) => {
    expect(AttachmentRef.safeParse({
      partName: 'replay', kind: 'session-replay', format,
      contentType: 'application/gzip', byteLength: 100, sha256: 'a'.repeat(64),
    }).success).toBe(true);
  });
});
