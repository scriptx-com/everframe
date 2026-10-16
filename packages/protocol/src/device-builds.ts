// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';
import { BuildVcsSchema } from './build-artifacts.js';

export const DevicePlatformSchema = z.enum(['ios', 'tvos', 'android', 'android-tv', 'roku']);
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

const VersionStringSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0);

/** Filename checks guide callers; the server must verify actual content and MIME. */
export const DeviceBuildUploadInputSchema = z
  .object({
    platform: DevicePlatformSchema,
    version: VersionStringSchema,
    buildNumber: VersionStringSchema,
    commit: BuildVcsSchema.shape.commit.optional(),
    filename: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^/\\\u0000-\u001f\u007f]+$/),
    sizeBytes: z.number().int().min(1).max(524288000),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine((value, context) => {
    const android = value.platform === 'android' || value.platform === 'android-tv';
    if ((android ? /\.apk$/i : /\.zip$/i).test(value.filename)) return;
    const message = android
      ? 'Upload an APK for Android or Android TV; AAB store packages cannot run on a device.'
      : value.platform === 'roku'
        ? 'Upload a Roku sideload .zip package.'
        : 'Upload a simulator .app bundled in a .zip archive; IPA store packages cannot run in a simulator.';
    context.addIssue({ code: 'custom', path: ['filename'], message });
  });
export type DeviceBuildUploadInput = z.infer<typeof DeviceBuildUploadInputSchema>;

export const DeviceBuildUploadStateSchema = z.enum([
  'receiving',
  'queued',
  'uploading',
  'retrying',
  'ready',
  'failed',
  'expired',
]);
export type DeviceBuildUploadState = z.infer<typeof DeviceBuildUploadStateSchema>;

// Producers must supply safe, user-facing messages, never raw provider or HTTP responses.
const DeviceBuildUploadErrorSchema = z
  .object({
    code: z.enum([
      'invalid_format',
      'invalid_content',
      'upload_too_large',
      'upload_expired',
      'provider_unavailable',
      'retry_exhausted',
    ]),
    message: z.string().min(1).max(512),
  })
  .strict();

const UuidSchema = z.uuid();
const TimestampSchema = z.iso.datetime({ offset: true });
const StatusFields = {
  uploadId: UuidSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  retryAt: TimestampSchema.optional(),
  error: DeviceBuildUploadErrorSchema.optional(),
};

/** Runnable build identity is an Everframe UUID, independent of symbol identity. */
export const DeviceBuildUploadStatusSchema = z.discriminatedUnion('state', [
  z.object({ ...StatusFields, state: z.literal('ready'), buildId: UuidSchema }).strict(),
  z
    .object({
      ...StatusFields,
      state: DeviceBuildUploadStateSchema.exclude(['ready']),
      buildId: z.never().optional(),
    })
    .strict(),
]);
export type DeviceBuildUploadStatus = z.infer<typeof DeviceBuildUploadStatusSchema>;

function uploadPathIds(path: string, content: boolean): { appId: string; uploadId: string } | null {
  const pattern = content
    ? /^\/api\/v1\/apps\/([^/]+)\/device-builds\/([^/]+)\/content$/
    : /^\/api\/v1\/apps\/([^/]+)\/device-builds\/([^/]+)$/;
  const match = pattern.exec(path);
  if (
    !match ||
    !UuidSchema.safeParse(match[1]).success ||
    !UuidSchema.safeParse(match[2]).success
  ) {
    return null;
  }
  return { appId: match[1]!.toLowerCase(), uploadId: match[2]!.toLowerCase() };
}

/** Callers must also bind paths to their expected app and configured Everframe origin. */
export const DeviceBuildUploadReceiptSchema = z
  .object({
    uploadId: UuidSchema,
    state: z.literal('receiving'),
    contentPath: z.string(),
    statusPath: z.string(),
    expiresAt: TimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const content = uploadPathIds(value.contentPath, true);
    const status = uploadPathIds(value.statusPath, false);
    for (const [field, ids] of [
      ['contentPath', content],
      ['statusPath', status],
    ] as const) {
      if (!ids || ids.uploadId !== value.uploadId.toLowerCase()) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Expected a relative path for this app upload.',
        });
      }
    }
    if (content && status && content.appId !== status.appId) {
      context.addIssue({
        code: 'custom',
        path: ['contentPath'],
        message: 'Upload paths must belong to the same app.',
      });
    }
  });
export type DeviceBuildUploadReceipt = z.infer<typeof DeviceBuildUploadReceiptSchema>;

export const DeviceBuildUploadReservationSchema = z.union([
  DeviceBuildUploadReceiptSchema,
  DeviceBuildUploadStatusSchema,
]);
export type DeviceBuildUploadReservation = z.infer<typeof DeviceBuildUploadReservationSchema>;
