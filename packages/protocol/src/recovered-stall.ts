// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';

/** An executed probe proves its own recovery, never an OS ANR or process outcome. */
export const RecoveredStallEvidence = z.object({
  version: z.literal(1), evidenceId: z.string().uuid(),
  kind: z.literal('recovered_main_thread_stall'), provenance: z.literal('android_main_looper_probe'),
  outcome: z.literal('recovered'), scope: z.literal('main_looper'),
  queuedAt: z.string().datetime(), recoveredAt: z.string().datetime(),
  probeDelayMs: z.number().int().min(5000).max(60000),
  thresholdMs: z.literal(5000), sampleIntervalMs: z.literal(1000), clock: z.literal('uptime'),
  eligibility: z.literal('foreground-debugger-checked-v1'), trace: z.literal('not_collected'),
  attribution: z.object({
    release: z.literal('frozen'), session: z.literal('unavailable'),
    webExposure: z.literal('unavailable'), nativeExposure: z.literal('unavailable'),
  }).strict(),
  android: z.object({ apiLevel: z.number().int().min(24).max(1000) }).strict(),
}).strict().superRefine((value, ctx) => {
  const wallDelay = Date.parse(value.recoveredAt) - Date.parse(value.queuedAt);
  if (wallDelay < 0 || Math.abs(wallDelay - value.probeDelayMs) > 1000) {
    ctx.addIssue({ code: 'custom', path: ['recoveredAt'], message: 'Probe clocks disagree or recovery precedes queueing' });
  }
}).meta({ id: 'RecoveredStallEvidence', title: 'RecoveredStallEvidence' });
export type RecoveredStallEvidence = z.infer<typeof RecoveredStallEvidence>;
