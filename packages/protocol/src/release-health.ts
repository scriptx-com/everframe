// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';

export const RELEASE_HEALTH_MAX_AGE_MS = 30 * 86_400_000;
export const RELEASE_HEALTH_CLOCK_SKEW_MS = 5 * 60_000;
export const RELEASE_HEALTH_BODY_LIMIT = 8 * 1024;
const text = (maximum: number) => z.string().min(1).max(maximum)
  .refine(value => value.trim().length > 0 && !/[\u0000-\u001f\ud800-\udfff]/u.test(value));
const uuid = z.string().uuid().refine(value => value === value.toLowerCase());
const timestamp = z.iso.datetime({ precision: 3 });

/** An observation segment. This is neither a verified person nor a process outcome. */
export const ReleaseHealthExposureSchema = z.object({
  exposureId: uuid,
  pageLaunchId: uuid,
  startedAt: timestamp,
  platform: z.literal('web'),
  sdkVersion: text(64),
  nativeRelease: z.literal('not_applicable'),
  loadedBuildId: text(200).nullable(),
  subject: z.literal('anonymous_exposure'),
  coverage: z.object({
    policy: z.literal('web-page-v1'),
    sampleRate: z.literal(1),
    priorQueueLosses: z.number().int().min(0).max(2_147_483_647),
  }).strict(),
}).strict();

const common = {
  schemaVersion: z.literal(1), recordId: uuid, exposure: ReleaseHealthExposureSchema,
  capturedAt: timestamp,
};
/** `end` records an explicit boundary; missing/end records imply no crash or health outcome. */
export const ReleaseHealthRecordSchema = z.discriminatedUnion('phase', [
  z.object({ ...common, phase: z.literal('start'), sequence: z.literal(0), elapsedMs: z.literal(0) }).strict()
    .refine(value => value.capturedAt === value.exposure.startedAt, { message: 'Start must use its frozen timestamp' }),
  z.object({ ...common, phase: z.literal('end'), sequence: z.literal(1),
    elapsedMs: z.number().int().min(0).max(31 * 86_400_000),
    endReason: z.enum(['sdk_stop', 'page_hide']),
  }).strict(),
]);
export type ReleaseHealthRecord = z.infer<typeof ReleaseHealthRecordSchema>;
export type ReleaseHealthExposure = z.infer<typeof ReleaseHealthExposureSchema>;
