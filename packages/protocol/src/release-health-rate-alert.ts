// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';
import { ReleaseHealthAlertCohortSchema } from './release-health-alert.js';
const count = z.number().int().min(0).max(2_147_483_647);
const instant = z.iso.datetime({ precision: 3 });
export const ReleaseHealthRateMetricSchema = z.enum(['foreground_crash_free_sessions', 'foreground_crash_free_users']);
/** Minima use the metric's selected unit: foreground sessions or identified users. */
export const ReleaseHealthRatePolicySchema = z.object({
  minObserved: z.number().int().min(20).max(1_000_000),
  minFatal: z.number().int().min(3).max(100_000),
  targetBasisPoints: z.number().int().min(1).max(10_000),
  minOutcomeCoverageBasisPoints: z.number().int().min(8_000).max(10_000),
}).strict();
export const ReleaseHealthRateCountsSchema = z.object({
  observed: count, completed: count, fatal: count, unknown: count,
  observedSessions: count, identifiedSessions: count, conflictingSessions: count,
}).strict().refine(c => c.completed + c.fatal + c.unknown === c.observed
  && c.identifiedSessions <= c.observedSessions && c.conflictingSessions <= c.observedSessions);
/** Aggregate-only evidence. Unknown outcomes are treated as healthy for the breach decision. */
export const ReleaseHealthRateThresholdEventSchema = z.object({
  id: z.uuid(), type: z.literal('release_health.rate_threshold_reached'), schemaVersion: z.literal('1.2'), createdAt: instant,
  data: z.object({
    appId: z.uuid(), projectId: z.uuid(), ruleId: z.uuid(), metric: ReleaseHealthRateMetricSchema,
    cohort: ReleaseHealthAlertCohortSchema,
    window: z.object({ days: z.union([z.literal(7), z.literal(30)]), from: instant, to: instant }).strict(),
    observedAt: instant,
    thresholds: ReleaseHealthRatePolicySchema.extend({ minIdentityCoverageBasisPoints: z.union([z.literal(0), z.literal(8_000)]) }),
    counts: ReleaseHealthRateCountsSchema,
    bounds: z.object({ lower: z.number().min(0).max(1), upper: z.number().min(0).max(1) }).strict(),
    coverage: z.object({ policy: z.literal('foreground-v1'), population: z.literal('unknown'),
      accounting: z.literal('current_retained_evidence') }).strict(),
  }).strict().refine(({ counts: c, thresholds: t, metric, bounds, window: w, observedAt }) => {
    const users = metric === 'foreground_crash_free_users';
    return c.observed >= t.minObserved && c.fatal >= t.minFatal && c.conflictingSessions === 0
      && (users ? c.observed <= c.identifiedSessions : c.observed === c.observedSessions)
      && t.minIdentityCoverageBasisPoints === (users ? 8_000 : 0)
      && c.identifiedSessions * 10_000 >= c.observedSessions * t.minIdentityCoverageBasisPoints
      && (c.completed + c.fatal) * 10_000 >= c.observed * t.minOutcomeCoverageBasisPoints
      && (c.completed + c.unknown) * 10_000 < c.observed * t.targetBasisPoints
      && bounds.lower === c.completed / c.observed && bounds.upper === (c.completed + c.unknown) / c.observed
      && Date.parse(w.to) - Date.parse(w.from) === w.days * 86_400_000 && w.to === observedAt;
  }),
}).strict();
export type ReleaseHealthRateMetric = z.infer<typeof ReleaseHealthRateMetricSchema>;
export type ReleaseHealthRatePolicy = z.infer<typeof ReleaseHealthRatePolicySchema>;
export type ReleaseHealthRateCounts = z.infer<typeof ReleaseHealthRateCountsSchema>;
export type ReleaseHealthRateThresholdEvent = z.infer<typeof ReleaseHealthRateThresholdEventSchema>;
