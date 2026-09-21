// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// CrashPayload — additive `payload.crash` channel for unattended reports
// (spec 2026-07-18 crash/error reporting). Declared Zod immediately (unlike
// network-body.ts) because Android parity ships in the same release —
// Generated.kt / Generated.swift must carry these types from day one.
// `mechanism` is a plain string, NOT an enum: v2 adds values (e.g. 'signal')
// and older parsers must keep accepting them.
import { z } from 'zod';
import { CrashDetails } from './crash-details.js';
import { CrashCauseChain } from './crash-causes.js';

export const CrashFrame = z
  .object({
    /** Raw frame text exactly as the platform produced it. */
    raw: z.string().max(1024),
    file: z.string().max(1024).optional(),
    function: z.string().max(512).optional(),
    line: z.number().int().nonnegative().optional(),
    col: z.number().int().nonnegative().optional(),
  })
  .passthrough()
  .meta({ id: 'Frame', title: 'Frame' });

/** Exact loaded JS artifact identity; lengths are UTF-16 code units. */
export const JsBundleMetadata = z.object({
  engine: z.literal('hermes'),
  platform: z.enum(['android', 'ios']).meta({ title: 'JsBundlePlatform' }),
  buildId: z.string().min(1).max(200)
    .regex(/\S/u).regex(/^(?:[^\u0000\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u),
  bundleName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
});
export type JsBundleMetadata = z.infer<typeof JsBundleMetadata>;

export const JvmMappingId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$(?![\s\S])/);
export type JvmMappingId = z.infer<typeof JvmMappingId>;

export const JvmCause = z.object({
  exceptionType: z.string().max(256),
  message: z.string().max(4096),
  frames: z.array(CrashFrame).max(32),
  framesTruncated: z.boolean(),
}).meta({ id: 'JvmCause', title: 'JvmCause' });
export type JvmCause = z.infer<typeof JvmCause>;

export const JvmCrashMetadata = z.object({
  mappingId: JvmMappingId.optional(),
  causes: z.array(JvmCause).max(8),
  causesTruncated: z.boolean(),
}).meta({ id: 'JvmCrashMetadata', title: 'JvmCrashMetadata' });
export type JvmCrashMetadata = z.infer<typeof JvmCrashMetadata>;

export const CrashPayload = z
  .object({
    causeChain: CrashCauseChain.optional(),
    details: CrashDetails.optional(),
    jsBundle: JsBundleMetadata.optional(),
    jvm: JvmCrashMetadata.optional(),
    exceptionType: z.string().max(256),
    message: z.string().max(4096),
    /** Raw frames only — symbolication is v2. */
    frames: z.array(CrashFrame).max(256),
    threadName: z.string().max(256).optional(),
    /** onerror | unhandledrejection | captureException | errorutils | uncaught-exception-handler */
    mechanism: z.string().max(64),
    /** True when the host explicitly reports a caught exception. */
    handled: z.boolean(),
    /** Process termination, separate from handled. Absent on older SDKs. */
    fatal: z.boolean().optional(),
    /** Crash time — distinct from submittedAt (next launch on Android). */
    occurredAt: z.string().datetime(),
    /** Client grouping heuristic — 16 lowercase hex chars (see spec). */
    fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  })
  .passthrough();

export type CrashFrame = z.infer<typeof CrashFrame>;
export type CrashPayload = z.infer<typeof CrashPayload>;
