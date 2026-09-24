// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';

// $id pins quicktype's generated type name — without it a future field-name
// collision can silently rename this public generated type (it happened when
// Breadcrumb.kind arrived: anonymous "Kind" became "AttachmentKind").
export const AttachmentKind = z
  .enum([
    'screenshot',
    'annotated-screenshot',
    'video',
    'audio',
    'session-replay',
    'other',
  ])
  .meta({ $id: 'AttachmentKind' });

// Keep vtree until the Android capture replacement is complete.
export const ReplayFormat = z.enum([
  'rrweb',
  'everframe-vtree-v1',
  'everframe-video-v1',
  'traceitx-vtree-v1',
  'traceitx-video-v1',
]);
export type ReplayFormat = z.infer<typeof ReplayFormat>;

export const AttachmentRef = z.object({
  partName: z.string(),
  kind: AttachmentKind,
  contentType: z.string(),
  byteLength: z.number(),
  sha256: z.string(), // hex-encoded sha256
  width: z.number().optional(),
  height: z.number().optional(),
  // Present iff kind === 'session-replay'. Optional + additive — backward
  // compatible with every existing attachment ref (PAY-01).
  format: ReplayFormat.optional(),
  durationMs: z.number().optional(),
  replayStartEpochMs: z.number().nonnegative().optional(),
}).superRefine((attachment, ctx) => {
  if (attachment.format !== 'everframe-video-v1' && attachment.format !== 'traceitx-video-v1') return;
  const reject = (field: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [field], message });
  if (attachment.kind !== 'session-replay') reject('kind', 'Video replay must be a session-replay attachment');
  if (attachment.contentType !== 'video/mp4') reject('contentType', 'Video replay must contain MP4');
  for (const field of ['width', 'height'] as const) {
    const value = attachment[field];
    if (value === undefined || !Number.isSafeInteger(value) || value <= 0)
      reject(field, 'Video replay requires a positive integer dimension');
  }
  for (const field of ['durationMs', 'replayStartEpochMs'] as const) {
    const value = attachment[field];
    if (value === undefined || !Number.isFinite(value) || value < 0)
      reject(field, 'Video replay requires a nonnegative finite timestamp or duration');
  }
});

export type AttachmentRef = z.infer<typeof AttachmentRef>;
