// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';

export const AppleDiagnosticFrame = z.object({
  binaryUUID: z.string().uuid(),
  binaryName: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.+-]+$/),
  address: z.string().regex(/^0x[0-9a-f]{1,16}$/),
  offset: z.string().regex(/^0x[0-9a-f]{1,16}$/),
}).strict().meta({ title: 'AppleDiagnosticFrame' });
export const AppleHang = z.object({
  durationMs: z.number().positive().max(86_400_000),
  stack: z.object({
    status: z.enum(['available', 'unavailable', 'malformed', 'oversized']).meta({ title: 'AppleDiagnosticStackStatus' }),
    truncated: z.boolean(), frames: z.array(AppleDiagnosticFrame).max(64),
  }).strict(),
}).strict().superRefine((v, ctx) => {
  if ((v.stack.status === 'available') !== (v.stack.frames.length > 0)) {
    ctx.addIssue({ code: 'custom', path: ['stack'], message: 'Available stack requires frames; unavailable stack cannot contain frames' });
  }
}).meta({ title: 'AppleHang' });
export const AppleExitCount = z.object({
  state: z.enum(['foreground', 'background']).meta({ title: 'AppleExitState' }),
  reason: z.enum(['normal', 'memory_resource_limit', 'bad_access', 'abnormal', 'illegal_instruction',
    'watchdog', 'cpu_resource_limit', 'memory_pressure', 'suspended_locked_file', 'background_task_timeout'])
    .meta({ title: 'AppleExitReason' }),
  count: z.number().int().min(1).max(2147483647),
}).strict().meta({ title: 'AppleExitCount' });
/** MetricKit periods and aggregate counts are not individually timed process exits. */
export const AppleDiagnosticEvidence = z.object({
  version: z.literal(1), evidenceId: z.string().uuid(), ownershipId: z.string().uuid(),
  kind: z.enum(['hang_batch', 'app_exit_summary']).meta({ title: 'AppleDiagnosticKind' }),
  provenance: z.literal('apple_metrickit'), scope: z.literal('reporting_interval'), outcome: z.literal('unknown'),
  interval: z.object({ begin: z.string().datetime(), end: z.string().datetime() }).strict(),
  collectedAt: z.string().datetime(),
  attribution: z.object({ process: z.literal('unavailable'), release: z.literal('frozen'),
    session: z.literal('unavailable'), webExposure: z.literal('unavailable') }).strict(),
  apple: z.object({ applicationVersion: z.string().min(1).max(128), applicationBuild: z.string().min(1).max(128),
    osVersion: z.string().min(1).max(128) }).strict(),
  truncated: z.boolean(), hangs: z.array(AppleHang).min(1).max(8).optional(),
  exits: z.array(AppleExitCount).min(1).max(16).optional(),
}).strict().superRefine((v, ctx) => {
  const issue = (path: PropertyKey[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const begin = Date.parse(v.interval.begin), end = Date.parse(v.interval.end);
  if (begin > end || end > Date.parse(v.collectedAt) || end - begin > 86_400_000) issue(['interval'], 'Invalid reporting interval');
  if (v.kind === 'hang_batch' ? (!v.hangs || !!v.exits) : (!v.exits || !!v.hangs)) issue(['kind'], 'Evidence must contain exactly its declared kind');
  const keys = new Set<string>();
  for (const entry of v.exits ?? []) {
    const key = `${entry.state}/${entry.reason}`;
    if (keys.has(key)) issue(['exits'], 'Duplicate aggregate bucket');
    keys.add(key);
    if (entry.state === 'foreground' && ['cpu_resource_limit', 'memory_pressure', 'suspended_locked_file', 'background_task_timeout'].includes(entry.reason)) {
      issue(['exits'], 'Background-only reason cannot describe foreground exits');
    }
  }
}).meta({ id: 'AppleDiagnosticEvidence', title: 'AppleDiagnosticEvidence' });
export type AppleDiagnosticEvidence = z.infer<typeof AppleDiagnosticEvidence>;
export type AppleDiagnosticFrame = z.infer<typeof AppleDiagnosticFrame>;
export type AppleHang = z.infer<typeof AppleHang>;
export type AppleExitCount = z.infer<typeof AppleExitCount>;
