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

const sharedExposure = {
  exposureId: uuid, startedAt: timestamp, sdkVersion: text(64),
  loadedBuildId: text(200).nullable(), subject: z.literal('anonymous_exposure'),
};
const bundleIdentity = {
  loadedBuildId: text(200).nullable(),
  loadedBundleStatus: z.enum(['known', 'not_applicable', 'unknown']),
};
const bundleConsistent = (value: { loadedBuildId: string | null; loadedBundleStatus: string }) =>
  (value.loadedBundleStatus === 'known') === (value.loadedBuildId !== null);

/** Exact segment identity admitted before the OS context was armed. Never inferred on recovery. */
export const NativeExposurePointerSchema = z.object({
  exposureId: uuid, processLaunchId: uuid, startedAt: timestamp, nativeBuildId: text(200),
  ...bundleIdentity,
}).strict().refine(bundleConsistent, { message: 'Loaded bundle identity must match its status' })
  .meta({ id: 'NativeExposure', title: 'NativeExposure' });

/** An observation segment. This is neither a verified person nor a process outcome. */
// Parsed key order is part of stored record digests, so the web fields keep their original order.
export const WebReleaseHealthExposureSchema = z.object({
  exposureId: uuid, pageLaunchId: uuid, startedAt: timestamp, platform: z.literal('web'),
  sdkVersion: text(64), nativeRelease: z.literal('not_applicable'), loadedBuildId: text(200).nullable(),
  subject: z.literal('anonymous_exposure'),
  coverage: z.object({
    policy: z.literal('web-page-v1'), sampleRate: z.literal(1),
    priorQueueLosses: z.number().int().min(0).max(2_147_483_647),
  }).strict(),
}).strict();
export const AndroidReleaseHealthExposureSchema = z.object({
  ...sharedExposure, processLaunchId: uuid, platform: z.literal('android'),
  nativeRelease: z.object({ buildId: text(200) }).strict(), ...bundleIdentity,
  coverage: z.object({
    policy: z.literal('android-sdk-segment-v1'), sampleRate: z.literal(1),
    priorQueueLosses: z.null(), queueLossAccounting: z.literal('unavailable'),
  }).strict(),
}).strict().refine(bundleConsistent, { message: 'Loaded bundle identity must match its status' });
export const IOSReleaseHealthExposureSchema = z.object({
  ...sharedExposure, processLaunchId: uuid, platform: z.literal('ios'),
  nativeRelease: z.object({ buildId: text(200) }).strict(), ...bundleIdentity,
  coverage: z.object({
    policy: z.literal('ios-sdk-segment-v1'), sampleRate: z.literal(1),
    priorQueueLosses: z.null(), queueLossAccounting: z.literal('unavailable'),
  }).strict(),
}).strict().refine(bundleConsistent, { message: 'Loaded bundle identity must match its status' });
export const ReleaseHealthExposureV1Schema = z.discriminatedUnion('platform', [
  WebReleaseHealthExposureSchema, AndroidReleaseHealthExposureSchema, IOSReleaseHealthExposureSchema,
]);

const common = {
  schemaVersion: z.literal(1), recordId: uuid, exposure: ReleaseHealthExposureV1Schema,
  capturedAt: timestamp,
};
/** `end` records an explicit boundary; missing/end records imply no crash or health outcome. */
export const ReleaseHealthRecordV1Schema = z.discriminatedUnion('phase', [
  z.object({ ...common, phase: z.literal('start'), sequence: z.literal(0), elapsedMs: z.literal(0) }).strict()
    .refine(value => value.capturedAt === value.exposure.startedAt, { message: 'Start must use its frozen timestamp' }),
  z.object({ ...common, phase: z.literal('end'), sequence: z.literal(1),
    elapsedMs: z.number().int().min(0).max(31 * 86_400_000),
    endReason: z.enum(['sdk_stop', 'page_hide']),
  }).strict().refine(value => value.exposure.platform === 'web' || value.endReason === 'sdk_stop',
    { message: 'Native segments cannot end at a web page boundary' }),
]);
/** Explicit launch-session accounting; supplied subjects are self-declared opaque IDs. */
export const ReleaseHealthSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('anonymous') }).strict(),
  z.object({ kind: z.literal('provided'), id: text(128) }).strict(),
]);
const session = { sessionPolicy: z.literal('launch-v1'), subject: ReleaseHealthSubjectSchema };
export const WebReleaseHealthExposureV2Schema = WebReleaseHealthExposureSchema.extend(session);
// Reapply bundle consistency to the new shape; keep the v1 shape and parse order intact.
export const AndroidReleaseHealthExposureV2Schema = z.object({ ...AndroidReleaseHealthExposureSchema.shape, ...session }).strict()
  .refine(bundleConsistent, { message: 'Loaded bundle identity must match its status' });
export const IOSReleaseHealthExposureV2Schema = z.object({ ...IOSReleaseHealthExposureSchema.shape, ...session }).strict()
  .refine(bundleConsistent, { message: 'Loaded bundle identity must match its status' });
export const ReleaseHealthExposureV2Schema = z.discriminatedUnion('platform', [
  WebReleaseHealthExposureV2Schema, AndroidReleaseHealthExposureV2Schema, IOSReleaseHealthExposureV2Schema,
]);
const commonV2 = { schemaVersion: z.literal(2), recordId: uuid,
  exposure: ReleaseHealthExposureV2Schema, capturedAt: timestamp };
export const ReleaseHealthRecordV2Schema = z.discriminatedUnion('phase', [
  z.object({ ...commonV2, phase: z.literal('start'), sequence: z.literal(0), elapsedMs: z.literal(0) }).strict()
    .refine(value => value.capturedAt === value.exposure.startedAt, { message: 'Start must use its frozen timestamp' }),
  z.object({ ...commonV2, phase: z.literal('end'), sequence: z.literal(1),
    elapsedMs: z.number().int().min(0).max(31 * 86_400_000), endReason: z.enum(['sdk_stop', 'page_hide']),
  }).strict().refine(value => value.exposure.platform === 'web' || value.endReason === 'sdk_stop',
    { message: 'Native segments cannot end at a web page boundary' }),
]);
/** A bounded native foreground monitoring session, not a claim about process termination. */
const foreground = { sessionPolicy: z.literal('foreground-v1'), subject: ReleaseHealthSubjectSchema };
export const AndroidReleaseHealthExposureV3Schema = z.object({ ...AndroidReleaseHealthExposureSchema.shape, ...foreground }).strict()
  .refine(bundleConsistent, { message: 'Loaded bundle identity must match its status' });
export const IOSReleaseHealthExposureV3Schema = z.object({ ...IOSReleaseHealthExposureSchema.shape, ...foreground }).strict()
  .refine(bundleConsistent, { message: 'Loaded bundle identity must match its status' });
export const ReleaseHealthExposureV3Schema = z.discriminatedUnion('platform', [
  AndroidReleaseHealthExposureV3Schema, IOSReleaseHealthExposureV3Schema,
]);
const commonV3 = { schemaVersion: z.literal(3), recordId: uuid, exposure: ReleaseHealthExposureV3Schema, capturedAt: timestamp };
export const ReleaseHealthRecordV3Schema = z.discriminatedUnion('phase', [
  z.object({ ...commonV3, phase: z.literal('start'), sequence: z.literal(0), elapsedMs: z.literal(0) }).strict()
    .refine(value => value.capturedAt === value.exposure.startedAt, { message: 'Start must use its frozen timestamp' }),
  z.object({ ...commonV3, phase: z.literal('end'), sequence: z.literal(1), outcome: z.literal('completed'),
    elapsedMs: z.number().int().min(0).max(31 * 86_400_000), endReason: z.enum(['sdk_stop', 'background']),
  }).strict().refine(value => value.capturedAt >= value.exposure.startedAt,
    { message: 'A completed session cannot end before its start' }),
]);
export type AndroidReleaseHealthExposureV3 = z.infer<typeof AndroidReleaseHealthExposureV3Schema>;
export type IOSReleaseHealthExposureV3 = z.infer<typeof IOSReleaseHealthExposureV3Schema>;
export const ReleaseHealthExposureSchema = z.union([ReleaseHealthExposureV1Schema, ReleaseHealthExposureV2Schema, ReleaseHealthExposureV3Schema]);
export const ReleaseHealthRecordSchema = z.union([ReleaseHealthRecordV1Schema, ReleaseHealthRecordV2Schema, ReleaseHealthRecordV3Schema]);
export type WebReleaseHealthExposureV2 = z.infer<typeof WebReleaseHealthExposureV2Schema>;
export type AndroidReleaseHealthExposureV2 = z.infer<typeof AndroidReleaseHealthExposureV2Schema>;
export type IOSReleaseHealthExposureV2 = z.infer<typeof IOSReleaseHealthExposureV2Schema>;
export type ReleaseHealthRecord = z.infer<typeof ReleaseHealthRecordSchema>;
export type ReleaseHealthExposure = z.infer<typeof ReleaseHealthExposureSchema>;
export type NativeExposurePointer = z.infer<typeof NativeExposurePointerSchema>;
export type WebReleaseHealthExposure = z.infer<typeof WebReleaseHealthExposureSchema>;
export type AndroidReleaseHealthExposure = z.infer<typeof AndroidReleaseHealthExposureSchema>;
export type IOSReleaseHealthExposure = z.infer<typeof IOSReleaseHealthExposureSchema>;
