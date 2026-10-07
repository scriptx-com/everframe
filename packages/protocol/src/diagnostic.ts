// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';

/** The OS reason is authoritative; traces and SIGKILL alone cannot establish ANR/OOM. */
export function androidExitCause(reason: number): DiagnosticCause {
  if (reason === 6) return 'anr';
  if (reason === 5) return 'native_crash';
  if (reason === 4) return 'java_crash';
  if (reason === 3) return 'system_low_memory';
  if (reason === 10 || reason === 11) return 'user_requested';
  if ([1, 7, 8, 9, 12, 13, 14, 15, 16].includes(reason)) return 'system_other';
  return 'unknown';
}
export const DiagnosticCause = z.enum([
  'anr', 'native_crash', 'java_crash', 'system_low_memory', 'user_requested', 'system_other', 'unknown',
]).meta({ title: 'DiagnosticCause' });
export type DiagnosticCause = z.infer<typeof DiagnosticCause>;
export const DiagnosticFrame = z.object({
  function: z.string().min(1).max(256).regex(/^[A-Za-z0-9_.$<>]+$/),
  file: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.$-]+$/).optional(),
  line: z.number().int().min(1).max(2147483647).optional(),
}).strict().meta({ title: 'DiagnosticFrame' });
export type DiagnosticFrame = z.infer<typeof DiagnosticFrame>;

/** OS-process evidence is not a web exposure or a crash-free metric input. */
export const DiagnosticEvidence = z.object({
  version: z.literal(1), evidenceId: z.string().uuid(), processLaunchId: z.string().uuid(),
  kind: z.literal('process_exit'), provenance: z.literal('android_application_exit_info'),
  scope: z.literal('os_process'), outcome: z.literal('terminated'), cause: DiagnosticCause,
  occurredAt: z.string().datetime(), collectedAt: z.string().datetime(),
  attribution: z.object({
    process: z.literal('exact_os_token'), release: z.literal('frozen'),
    session: z.literal('unavailable'), webExposure: z.literal('unavailable'),
  }).strict(),
  android: z.object({
    apiLevel: z.number().int().min(30).max(1000), reason: z.number().int().min(0).max(2147483647),
    pid: z.number().int().min(1).max(2147483647),
  }).strict(),
  trace: z.object({
    status: z.enum(['available', 'unavailable', 'malformed', 'unsupported', 'not_requested']).meta({ title: 'DiagnosticTraceStatus' }),
    format: z.enum(['none', 'android_anr_text', 'android_tombstone']).meta({ title: 'DiagnosticTraceFormat' }),
    truncated: z.boolean(), frames: z.array(DiagnosticFrame).max(64),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const issue = (path: PropertyKey[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  if (value.cause !== androidExitCause(value.android.reason)) issue(['cause'], 'Cause must match the OS exit reason');
  if (Date.parse(value.occurredAt) > Date.parse(value.collectedAt)) issue(['collectedAt'], 'Collection precedes process exit');
  const trace = value.trace;
  if (trace.status !== 'available' && (trace.format !== 'none' || trace.frames.length > 0)) {
    issue(['trace'], 'Unavailable trace must not claim a format or stack');
  }
  if (trace.status === 'available') {
    if (trace.format === 'android_anr_text') {
      if (value.cause !== 'anr' || trace.frames.length === 0) issue(['trace'], 'ANR stack requires an ANR exit and frames');
    } else if (trace.format === 'android_tombstone') {
      if (value.cause !== 'native_crash' || value.android.apiLevel < 31 || trace.frames.length !== 0) {
        issue(['trace'], 'Native tombstone requires API31+ native exit; frames belong to crash metadata');
      }
    } else issue(['trace', 'format'], 'Available trace requires a supported format');
  }
}).meta({ id: 'DiagnosticEvidence', title: 'DiagnosticEvidence' });
export type DiagnosticEvidence = z.infer<typeof DiagnosticEvidence>;
