// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';
import { WebRuntimePlatformSchema } from './web-runtime-platform.js';

export const RELEASE_HEALTH_MAX_AGE_MS = 30 * 86_400_000;
export const RELEASE_HEALTH_CLOCK_SKEW_MS = 5 * 60_000;
export const RELEASE_HEALTH_BODY_LIMIT = 8 * 1024;
/** Native wire version. Retired versions 1–4 remain rejected. */
export const RELEASE_HEALTH_SCHEMA_VERSION = 5;
/** UTF-16 units allowed in an app version or build. */
export const RELEASE_HEALTH_APP_TEXT_MAX = 64;
const text = (maximum: number) => z.string().min(1).max(maximum)
  .refine(value => value.trim().length > 0 && !/[\u0000-\u001f\ud800-\udfff]/u.test(value));
const uuid = z.string().uuid().refine(value => value === value.toLowerCase());
const timestamp = z.iso.datetime({ precision: 3 });

const bundleIdentity = {
  loadedBuildId: text(200).nullable(),
  loadedBundleStatus: z.enum(['known', 'not_applicable', 'unknown']),
};
const bundleConsistent = (value: { loadedBuildId: string | null; loadedBundleStatus: string }) =>
  (value.loadedBundleStatus === 'known') === (value.loadedBuildId !== null);
const bundleMessage = { message: 'Loaded bundle identity must match its status' };

/**
 * The app release the SDK read itself: Android `versionName` (else `versionCode` as text) and
 * `versionCode`; iOS `CFBundleShortVersionString` (else `CFBundleVersion`) and `CFBundleVersion`.
 * `build` is always present and null when there is none, so the pointer's bytes never depend on
 * an encoder dropping null keys. Named for codegen: `App` already names the envelope's `context.app`.
 */
export const ReleaseHealthAppSchema = z.object({
  version: text(RELEASE_HEALTH_APP_TEXT_MAX),
  build: text(RELEASE_HEALTH_APP_TEXT_MAX).nullable(),
  /** True for a debug or development build. Part of the digest, so it is always present. */
  debug: z.boolean(),
}).strict().meta({ id: 'NativeExposureApp', title: 'NativeExposureApp' });

/** Exact segment identity admitted before the OS context was armed. Never inferred on recovery. */
export const NativeExposurePointerSchema = z.object({
  exposureId: uuid, processLaunchId: uuid, startedAt: timestamp, app: ReleaseHealthAppSchema,
  ...bundleIdentity,
}).strict().refine(bundleConsistent, bundleMessage)
  .meta({ id: 'NativeExposure', title: 'NativeExposure' });

/** Supplied subjects are self-declared opaque account IDs, never verified people. */
export const ReleaseHealthSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('anonymous') }).strict(),
  z.object({ kind: z.literal('provided'), id: text(128) }).strict(),
]);

/** One foreground monitoring session, not a claim about process termination. */
const foregroundSession = { subject: ReleaseHealthSubjectSchema, sessionPolicy: z.literal('foreground-v1') };
const segmentCoverage = <Policy extends string>(policy: Policy) => z.object({
  policy: z.literal(policy), sampleRate: z.literal(1),
  priorQueueLosses: z.null(), queueLossAccounting: z.literal('unavailable'),
}).strict();
// Receivers digest JSON.stringify(parsed): the shape's key order is part of the wire contract.
export const AndroidReleaseHealthExposureSchema = z.object({
  exposureId: uuid, processLaunchId: uuid, startedAt: timestamp, platform: z.literal('android'),
  sdkVersion: text(64), app: ReleaseHealthAppSchema, ...bundleIdentity, ...foregroundSession,
  coverage: segmentCoverage('android-sdk-segment-v1'),
}).strict().refine(bundleConsistent, bundleMessage);
export const IOSReleaseHealthExposureSchema = z.object({
  exposureId: uuid, processLaunchId: uuid, startedAt: timestamp, platform: z.literal('ios'),
  sdkVersion: text(64), app: ReleaseHealthAppSchema, ...bundleIdentity, ...foregroundSession,
  coverage: segmentCoverage('ios-sdk-segment-v1'),
}).strict().refine(bundleConsistent, bundleMessage);
export const NativeReleaseHealthExposureSchema = z.discriminatedUnion('platform', [
  AndroidReleaseHealthExposureSchema, IOSReleaseHealthExposureSchema,
]);

const record = {
  schemaVersion: z.literal(RELEASE_HEALTH_SCHEMA_VERSION), recordId: uuid,
  exposure: NativeReleaseHealthExposureSchema, capturedAt: timestamp,
};
/** A start, and the explicit completed end of the same session. A missing end is an unknown outcome. */
export const NativeReleaseHealthRecordSchema = z.discriminatedUnion('phase', [
  z.object({ ...record, phase: z.literal('start'), sequence: z.literal(0), elapsedMs: z.literal(0) }).strict()
    .refine(value => value.capturedAt === value.exposure.startedAt, { message: 'Start must use its frozen timestamp' }),
  z.object({ ...record, phase: z.literal('end'), sequence: z.literal(1), outcome: z.literal('completed'),
    elapsedMs: z.number().int().min(0).max(31 * 86_400_000), endReason: z.enum(['sdk_stop', 'background']),
  }).strict().refine(value => value.capturedAt >= value.exposure.startedAt,
    { message: 'A completed session cannot end before its start' }),
]);
export type ReleaseHealthApp = z.infer<typeof ReleaseHealthAppSchema>;
export type NativeExposurePointer = z.infer<typeof NativeExposurePointerSchema>;
export type ReleaseHealthSubject = z.infer<typeof ReleaseHealthSubjectSchema>;
export type AndroidReleaseHealthExposure = z.infer<typeof AndroidReleaseHealthExposureSchema>;
export type IOSReleaseHealthExposure = z.infer<typeof IOSReleaseHealthExposureSchema>;
export const WEB_RELEASE_HEALTH_SCHEMA_VERSION = 6;
export const WebReleaseHealthExposureSchema = z.object({
  exposureId: uuid, pageLaunchId: uuid, startedAt: timestamp, platform: WebRuntimePlatformSchema,
  sdkVersion: text(64), app: ReleaseHealthAppSchema.extend({ debug: z.literal(false) }),
  subject: ReleaseHealthSubjectSchema, sessionPolicy: z.literal('page-v1'),
}).strict();
const webRecord = {
  schemaVersion: z.literal(WEB_RELEASE_HEALTH_SCHEMA_VERSION), recordId: uuid,
  exposure: WebReleaseHealthExposureSchema, capturedAt: timestamp,
};
const elapsedMs = z.number().int().min(0).max(31 * 86_400_000);
export const WebReleaseHealthRecordSchema = z.discriminatedUnion('phase', [
  z.object({ ...webRecord, phase: z.literal('start'), sequence: z.literal(0), elapsedMs: z.literal(0) }).strict()
    .refine(value => value.capturedAt === value.exposure.startedAt, { message: 'Start must use its frozen timestamp' }),
  z.object({ ...webRecord, phase: z.literal('end'), sequence: z.literal(1), outcome: z.literal('completed'),
    elapsedMs, endReason: z.literal('pagehide') }).strict(),
  z.object({ ...webRecord, phase: z.literal('failure'), sequence: z.literal(2), outcome: z.literal('crashed'),
    elapsedMs, mechanism: z.enum(['onerror', 'unhandledrejection']) }).strict(),
]).refine(value => value.capturedAt >= value.exposure.startedAt, { message: 'Observation cannot predate start' });
export const ReleaseHealthExposureSchema = z.union([NativeReleaseHealthExposureSchema, WebReleaseHealthExposureSchema]);
export const ReleaseHealthRecordSchema = z.union([NativeReleaseHealthRecordSchema, WebReleaseHealthRecordSchema]);
export type NativeReleaseHealthRecord = z.infer<typeof NativeReleaseHealthRecordSchema>;
export type NativeReleaseHealthExposure = z.infer<typeof NativeReleaseHealthExposureSchema>;
export type WebReleaseHealthRecord = z.infer<typeof WebReleaseHealthRecordSchema>;
export type WebReleaseHealthExposure = z.infer<typeof WebReleaseHealthExposureSchema>;
export type ReleaseHealthExposure = z.infer<typeof ReleaseHealthExposureSchema>;
export type ReleaseHealthRecord = z.infer<typeof ReleaseHealthRecordSchema>;
