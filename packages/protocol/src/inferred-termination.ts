// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';
import { NativeExposurePointerSchema } from './release-health.js';

export const INFERRED_TERMINATION_MECHANISM = 'apple-termination-inference';
export const INFERRED_TERMINATION_STALL_MS = 5000;
export const INFERRED_TERMINATION_EXCEPTION_TYPES = {
  low_memory: 'Low memory kill', unresponsive: 'Unresponsive termination', unexplained: 'Abnormal foreground termination',
} as const;
/** sha256(`${exceptionType}|apple_inferred_${cause}`)[:16]; deliberately not Android's OS-confirmed low-memory group. */
export const INFERRED_TERMINATION_FINGERPRINTS = {
  low_memory: '165254e7d389a4b6', unresponsive: 'a96ea84123b3e05f', unexplained: '07f0b3e86836c84e',
} as const;

// Values shared with Android's DiagnosticEvidence stay plain literals so quicktype merges them into the
// existing generated enums (EverframeDiagnosticKind, EverframeOutcome, EverframeScope, EverframeRelease,
// EverframeSession). Titling them would rename those public types. Apple-only values carry a title.
const one = <T extends string>(value: T, title: string) => z.enum([value]).meta({ title });
const kib = z.number().int().min(0).max(1_000_000_000);
export const InferredTerminationCause = z.enum(['low_memory', 'unresponsive', 'unexplained']).meta({ title: 'InferredTerminationCause' });
export type InferredTerminationCause = z.infer<typeof InferredTerminationCause>;

/**
 * Next-launch SDK inference, never OS evidence: iOS and tvOS deliver jetsam and watchdog kills as
 * SIGKILL, which no in-process handler observes. The SDK infers the kill from its own run record.
 */
export const InferredTerminationEvidence = z.object({
  version: z.literal(1), evidenceId: z.string().uuid(), processLaunchId: z.string().uuid(),
  nativeExposure: NativeExposurePointerSchema.optional(),
  kind: z.literal('process_exit'),
  provenance: one('apple_next_launch_inference', 'InferredTerminationProvenance'),
  scope: z.literal('os_process'), outcome: z.literal('terminated'),
  rules: one('apple-foreground-v1', 'InferredTerminationRules'),
  cause: InferredTerminationCause,
  /** The last recorded wall time of the process, at most one 5 s sample before the kill. */
  lastSeenAt: z.string().datetime(), collectedAt: z.string().datetime(),
  attribution: z.object({
    process: one('sdk_run_record', 'InferredTerminationProcess'), release: z.literal('frozen'),
    session: z.literal('unavailable'), webExposure: z.literal('unavailable'),
  }).strict().meta({ title: 'InferredTerminationAttribution' }),
  apple: z.object({
    appState: z.enum(['active', 'inactive', 'launching']).meta({ title: 'InferredTerminationAppState' }),
    /** Physical footprint and os_proc_available_memory at the last sample, in KiB. Absent when not sampled. */
    footprintKb: kib.optional(), availableKb: kib.optional(), memorySampledAt: z.string().datetime().optional(),
    memoryWarnings: z.number().int().min(0).max(1_000_000), lastMemoryWarningAt: z.string().datetime().optional(),
    memoryPressure: z.enum(['normal', 'warning', 'critical']).meta({ title: 'InferredTerminationPressure' }),
    mainThreadStallMs: z.number().int().min(0).max(86_400_000).optional(),
    thermalState: z.enum(['nominal', 'fair', 'serious', 'critical']).meta({ title: 'InferredTerminationThermalState' }),
  }).strict().meta({ title: 'InferredTerminationApple' }),
}).strict().superRefine((value, ctx) => {
  const issue = (path: PropertyKey[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  if (Date.parse(value.lastSeenAt) > Date.parse(value.collectedAt)) issue(['collectedAt'], 'Collection precedes the last-seen time');
  if (value.nativeExposure && value.nativeExposure.processLaunchId !== value.processLaunchId) {
    issue(['nativeExposure', 'processLaunchId'], 'Exposure must belong to the inferred process');
  }
  // A hung main thread cannot deliver willResignActive, so its recorded state may be stale.
  const stalled = (value.apple.mainThreadStallMs ?? 0) >= INFERRED_TERMINATION_STALL_MS;
  if (value.apple.appState !== 'active' && !stalled) issue(['apple', 'appState'], 'Only a stalled main thread admits an inactive process');
  if (value.cause === 'unresponsive' && !stalled) issue(['cause'], 'Unresponsive requires a recorded main-thread stall');
}).meta({ id: 'InferredTerminationEvidence', title: 'InferredTerminationEvidence' });
export type InferredTerminationEvidence = z.infer<typeof InferredTerminationEvidence>;
