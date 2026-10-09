// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';
const build = z.string().min(1).max(200).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\ud800-\udfff]/u.test(value));
const instant = z.iso.datetime({ precision: 3 });
const count = z.number().int().min(0).max(2_147_483_647);
export const ReleaseHealthAlertCohortSchema = z.object({
  platform: z.enum(['android', 'ios']), nativeBuildId: build,
  loadedBundleStatus: z.enum(['known', 'not_applicable']), loadedBuildId: build.nullable(),
}).strict().refine(value => (value.loadedBundleStatus === 'known') === (value.loadedBuildId !== null));
export const ReleaseHealthThresholdEventSchema = z.object({
  id: z.uuid(), type: z.literal('release_health.threshold_reached'), schemaVersion: z.literal('1.2'), createdAt: instant,
  data: z.object({
    appId: z.uuid(), projectId: z.uuid(), ruleId: z.uuid(), cohort: ReleaseHealthAlertCohortSchema,
    window: z.object({ days: z.union([z.literal(7), z.literal(30)]), from: instant, to: instant }).strict(),
    observedAt: instant,
    thresholds: z.object({ minObservedSessions: z.number().int().min(20).max(1_000_000),
      minFatalSessions: z.number().int().min(3).max(100_000) }).strict(),
    counts: z.object({ observedSessions: count, fatalSessions: count, noQualifiedExitSessions: count }).strict(),
    coverage: z.object({ status: z.literal('incomplete'), metric: z.literal('reported_fatal_sessions') }).strict(),
  }).strict().refine(({ counts: c, thresholds: t, window: w, observedAt }) =>
    c.fatalSessions <= c.observedSessions && c.noQualifiedExitSessions <= c.observedSessions - c.fatalSessions
    && c.observedSessions >= t.minObservedSessions && c.fatalSessions >= t.minFatalSessions
    && Date.parse(w.to) - Date.parse(w.from) === w.days * 86_400_000 && w.to === observedAt),
}).strict();
export type ReleaseHealthThresholdEvent = z.infer<typeof ReleaseHealthThresholdEventSchema>;
export type ReleaseHealthAlertCohort = z.infer<typeof ReleaseHealthAlertCohortSchema>;
