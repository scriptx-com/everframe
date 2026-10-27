// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';
import { ReleaseHealthPlatformSchema } from './web-runtime-platform.js';
import { RELEASE_HEALTH_APP_TEXT_MAX } from './release-health.js';

const text = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0 && !/[\u0000-\u001f\ud800-\udfff]/u.test(value));
const instant = z.iso.datetime({ precision: 3 });
const count = z.number().int().min(0).max(2_147_483_647);
const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * 86_400_000;

/** Event schema of `release_health.threshold_reached`; every other webhook event keeps 1.2. */
export const RELEASE_HEALTH_ALERT_SCHEMA_VERSION = '2.1';

/** What the dashboard shows a release under: every release-health platform, plus Xbox. */
export const ReleaseHealthTargetSchema = z.enum([...ReleaseHealthPlatformSchema.options, 'xbox']);
export type ReleaseHealthTarget = z.infer<typeof ReleaseHealthTargetSchema>;

/** A project rule's target: 50.0–99.9% crash-free sessions in 0.1 steps, and the resolved-session floor. */
export const ReleaseHealthAlertTargetSchema = z
  .object({
    basisPoints: z.number().int().min(5000).max(9990).multipleOf(10),
    minSessions: z.number().int().min(20).max(1_000_000),
  })
  .strict();

const resolved = (sessions: { completed: number; crashed: number }) =>
  sessions.completed + sessions.crashed;

const sessionCounts = () =>
  z.object({ total: count, completed: count, crashed: count, unknown: count }).strict();

const belowTarget = (
  sessions: { completed: number; crashed: number },
  target: { basisPoints: number },
) => sessions.completed * 10_000 < resolved(sessions) * target.basisPoints;

const sortedUnique = (values: readonly string[]) =>
  values.every((value, index) => index === 0 || values[index - 1]! < value);

/** One platform of the release that is below the target on its own. */
export const ReleaseHealthBelowTargetPlatformSchema = z
  .object({
    platform: ReleaseHealthTargetSchema,
    sessions: sessionCounts(),
    crashFreeSessions: z.number().min(0).max(1),
  })
  .strict();
export type ReleaseHealthBelowTargetPlatform = z.infer<
  typeof ReleaseHealthBelowTargetPlatformSchema
>;

/**
 * One release of one project (an app version, or a release group) over the last 7 days, where the
 * total or at least one platform is below the crash-free target.
 * The refinements restate the sender's integer test, so an event can only describe a real breach.
 */
export const ReleaseHealthThresholdEventSchema = z
  .object({
    id: z.uuid(),
    type: z.literal('release_health.threshold_reached'),
    schemaVersion: z.literal(RELEASE_HEALTH_ALERT_SCHEMA_VERSION),
    createdAt: instant,
    data: z
      .object({
        projectId: z.uuid(),
        ruleId: z.uuid(),
        version: text(RELEASE_HEALTH_APP_TEXT_MAX),
        platforms: z
          .array(ReleaseHealthTargetSchema)
          .min(1)
          .max(ReleaseHealthTargetSchema.options.length),
        belowTargetPlatforms: z
          .array(ReleaseHealthBelowTargetPlatformSchema)
          .max(ReleaseHealthTargetSchema.options.length),
        window: z.object({ days: z.literal(WINDOW_DAYS), from: instant, to: instant }).strict(),
        observedAt: instant,
        target: ReleaseHealthAlertTargetSchema,
        sessions: sessionCounts(),
        crashFreeSessions: z.number().min(0).max(1),
      })
      .strict()
      .refine(({ sessions: s }) => s.completed + s.crashed + s.unknown === s.total, {
        message: 'Completed, crashed and unknown sessions must add up to the total',
      })
      .refine(({ sessions, target }) => resolved(sessions) >= target.minSessions, {
        message: 'The version needs at least minSessions completed or crashed sessions',
      })
      .refine(
        ({ sessions, target, belowTargetPlatforms }) =>
          belowTarget(sessions, target) || belowTargetPlatforms.length > 0,
        { message: 'The total or at least one platform must be below the target' },
      )
      .refine(
        ({ belowTargetPlatforms }) =>
          sortedUnique(belowTargetPlatforms.map((entry) => entry.platform)),
        { message: 'belowTargetPlatforms must be sorted and unique by platform' },
      )
      .refine(
        ({ belowTargetPlatforms, platforms }) =>
          belowTargetPlatforms.every((entry) => platforms.includes(entry.platform)),
        { message: 'Every below-target platform must be listed in platforms' },
      )
      .refine(
        ({ belowTargetPlatforms: entries }) =>
          entries.every(
            (e) =>
              e.sessions.completed + e.sessions.crashed + e.sessions.unknown === e.sessions.total,
          ),
        {
          message: "A platform's completed, crashed and unknown sessions must add up to its total",
        },
      )
      .refine(
        ({ belowTargetPlatforms, target }) =>
          belowTargetPlatforms.every((entry) => resolved(entry.sessions) >= target.minSessions),
        { message: 'A platform needs at least minSessions completed or crashed sessions' },
      )
      .refine(
        ({ belowTargetPlatforms, target }) =>
          belowTargetPlatforms.every((entry) => belowTarget(entry.sessions, target)),
        { message: 'Every listed platform must be below the target' },
      )
      .refine(
        ({ belowTargetPlatforms }) =>
          belowTargetPlatforms.every(
            (entry) =>
              entry.crashFreeSessions === entry.sessions.completed / resolved(entry.sessions),
          ),
        { message: "A platform's crashFreeSessions must equal completed / (completed + crashed)" },
      )
      .refine(
        ({ sessions, crashFreeSessions }) =>
          crashFreeSessions === sessions.completed / resolved(sessions),
        { message: 'crashFreeSessions must equal completed / (completed + crashed)' },
      )
      .refine(
        ({ window, observedAt }) =>
          Date.parse(window.to) - Date.parse(window.from) === WINDOW_MS && window.to === observedAt,
        { message: 'The window must be the 7 days ending at observedAt' },
      )
      .refine(({ platforms }) => sortedUnique(platforms), {
        message: 'Platforms must be sorted and unique',
      }),
  })
  .strict();
export type ReleaseHealthAlertTarget = z.infer<typeof ReleaseHealthAlertTargetSchema>;
export type ReleaseHealthThresholdEvent = z.infer<typeof ReleaseHealthThresholdEventSchema>;
