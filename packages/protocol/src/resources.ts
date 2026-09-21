// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report Resource Window — CPU and memory samples over the last N seconds
// before a report or crash is submitted. Attached to the envelope as
// `payload.resources`; never uploaded on its own.
//
// DELIBERATELY SEPARATE from vitals.ts's `VitalsSample`, despite the similar
// shape. Membership in the `VitalsEntry` discriminated union would couple
// this to that union's versioning and inherit its deploy-order hazard (a
// phase-4 SDK emitting an entry an older API's narrower union rejects causes
// the WHOLE report to be dropped). These two evolve independently.
//
// Spec: the public behavior contract
import { z } from 'zod';

/**
 * Ceiling on `payload.resources` entries in a single ReportEnvelope, shared
 * with envelope.ts's `.max()` on that field so the schema cap and every
 * SDK-side stamp site can never drift apart. A stamp site that emits more
 * makes the server reject the WHOLE report (400, non-retryable), not merely
 * drop the resources block — the same all-or-nothing failure
 * MAX_ENVELOPE_VITALS_ENTRIES guards against.
 *
 * The worst legal config is 120s / 2s = 60 samples, so 256 is generous
 * headroom while still bounding a hostile or buggy client.
 */
export const MAX_RESOURCE_SAMPLES = 256;

/**
 * Fixed sample cadence on every platform. NOT configurable — one knob
 * (window length) is enough to explain, and 60s / 2s = 30 points is a real
 * graph. Native SDKs mirror this as a named constant; all three must agree
 * or the cap arithmetic above stops holding.
 */
export const RESOURCE_SAMPLE_INTERVAL_MS = 2_000;

/** The only window lengths the admin segmented control offers, in seconds. */
export const RESOURCE_WINDOW_PRESETS = [30, 60, 120] as const;

/** Mirrors the `apps.resource_window_sec` column default. */
export const DEFAULT_RESOURCE_WINDOW_SEC = 60;

/**
 * Upper bound on `cpu`. Fractions of ONE core, so >1 is legal and expected on
 * multicore — but a mis-computed delta (e.g. a CPU-time delta taken across a
 * suspended app) can produce an absurd number, and one such sample would
 * flatten the admin chart's entire y-axis. Bounded here so it 400s at the
 * schema boundary instead.
 */
const MAX_CPU_CORES = 1024;

export const ResourceSample = z.object({
  /** Epoch ms — same shared clock as breadcrumbs. */
  t: z.number(),
  /**
   * Fraction of ONE core (0–n; >1 legal on multicore).
   *
   * ABSENT ON WEB, permanently — no browser CPU API exists. Web sessions
   * carry `extras.longTaskMs` / `extras.loopLagMs` as responsiveness proxies
   * instead. Every consumer must render correctly without this field.
   */
  cpu: z.number().min(0).max(MAX_CPU_CORES).optional(),
  /**
   * Bytes. iOS: `task_vm_info.phys_footprint`. Android: `Debug.MemoryInfo`
   * total PSS. Web: `performance.memory.usedJSHeapSize`, 0 when unavailable
   * (Chrome-only API).
   */
  mem: z.number().nonnegative(),
  /** Platform extras — web sends `{ longTaskMs, loopLagMs }`. */
  extras: z.record(z.string(), z.number()).optional(),
}).meta({ $id: 'ResourceSample' });

export type ResourceSampleT = z.infer<typeof ResourceSample>;
