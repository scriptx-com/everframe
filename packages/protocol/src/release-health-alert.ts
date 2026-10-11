// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';
import { RELEASE_HEALTH_APP_TEXT_MAX } from './release-health.js';

const text = (maximum: number) => z.string().min(1).max(maximum)
  .refine(value => value.trim().length > 0 && !/[\u0000-\u001f\ud800-\udfff]/u.test(value));
const instant = z.iso.datetime({ precision: 3 });
const count = z.number().int().min(0).max(2_147_483_647);
const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * 86_400_000;

/** Event schema of `release_health.threshold_reached`; every other webhook event keeps 1.2. */
export const RELEASE_HEALTH_ALERT_SCHEMA_VERSION = '2.0';

/** A project rule's target: 50.0–99.9% crash-free sessions in 0.1 steps, and the resolved-session floor. */
export const ReleaseHealthAlertTargetSchema = z.object({
  basisPoints: z.number().int().min(5000).max(9990).multipleOf(10),
  minSessions: z.number().int().min(20).max(1_000_000),
}).strict();

const resolved = (sessions: { completed: number; crashed: number }) => sessions.completed + sessions.crashed;

/**
 * One app version of one project below its crash-free target over the last 7 days, all platforms.
 * The refinements restate the sender's integer test, so an event can only describe a real breach.
 */
export const ReleaseHealthThresholdEventSchema = z.object({
  id: z.uuid(), type: z.literal('release_health.threshold_reached'),
  schemaVersion: z.literal(RELEASE_HEALTH_ALERT_SCHEMA_VERSION), createdAt: instant,
  data: z.object({
    projectId: z.uuid(), ruleId: z.uuid(), version: text(RELEASE_HEALTH_APP_TEXT_MAX),
    platforms: z.array(z.enum(['android', 'ios'])).min(1).max(2),
    window: z.object({ days: z.literal(WINDOW_DAYS), from: instant, to: instant }).strict(),
    observedAt: instant,
    target: ReleaseHealthAlertTargetSchema,
    sessions: z.object({ total: count, completed: count, crashed: count, unknown: count }).strict(),
    crashFreeSessions: z.number().min(0).max(1),
  }).strict()
    .refine(({ sessions: s }) => s.completed + s.crashed + s.unknown === s.total,
      { message: 'Completed, crashed and unknown sessions must add up to the total' })
    .refine(({ sessions, target }) => resolved(sessions) >= target.minSessions,
      { message: 'The version needs at least minSessions completed or crashed sessions' })
    .refine(({ sessions, target }) => sessions.completed * 10_000 < resolved(sessions) * target.basisPoints,
      { message: 'The version must be below its target' })
    .refine(({ sessions, crashFreeSessions }) => crashFreeSessions === sessions.completed / resolved(sessions),
      { message: 'crashFreeSessions must equal completed / (completed + crashed)' })
    .refine(({ window, observedAt }) => Date.parse(window.to) - Date.parse(window.from) === WINDOW_MS && window.to === observedAt,
      { message: 'The window must be the 7 days ending at observedAt' })
    .refine(({ platforms }) => platforms.every((platform, index) => index === 0 || platforms[index - 1]! < platform),
      { message: 'Platforms must be sorted and unique' }),
}).strict();
export type ReleaseHealthAlertTarget = z.infer<typeof ReleaseHealthAlertTargetSchema>;
export type ReleaseHealthThresholdEvent = z.infer<typeof ReleaseHealthThresholdEventSchema>;
