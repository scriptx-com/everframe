// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Breadcrumb — one entry in the unified, kind-tagged action-timeline stream
// (payload.breadcrumbs). The full chain of what happened before a report:
// navigation, taps, console, network, lifecycle, uncaught errors, and
// host-supplied custom markers, all on ONE shared clock (epoch ms `t`) that
// also stamps the session-replay timeline, so the dashboard aligns replay
// frames to crumbs by direct comparison.
//
// Spec: the public behavior contract
//
// Trim markers: when the SDK's importance-weighted trim drops entries of a
// kind, ONE synthetic crumb of that kind carries message "+<N> <kind> hidden"
// and data.droppedCount = N. Presence of data.droppedCount is the marker
// discriminator — consumers need no side-channel.
import { z } from 'zod';

export const BreadcrumbKind = z
  .enum(['navigation', 'tap', 'console', 'network', 'lifecycle', 'error', 'custom'])
  .meta({ $id: 'BreadcrumbKind' });

export const BreadcrumbLevel = z.enum(['debug', 'info', 'warn', 'error']);

export const Breadcrumb = z
  .object({
    /** Absolute epoch ms — the SHARED clock (aligns with the replay timeline). */
    t: z.number(),
    /** Monotonic per-session tiebreaker for same-ms ordering. */
    seq: z.number().int().nonnegative(),
    kind: BreadcrumbKind,
    /** Severity → viewer ranking + row color. */
    level: BreadcrumbLevel.optional(),
    // Ceiling sits above the 1 KB console splice cap (512 + splice marker +
    // 512 ≈ 1.05 KB) with headroom for custom crumbs; the SDK-side buffer
    // slices to this same constant at add-time.
    message: z.string().max(2048),
    /** Kind-specific payload (see spec §1). Capped by the SDK-side trim. */
    data: z.record(z.string(), z.unknown()).optional(),
    /** True when this entry's message was head+tail truncated. */
    truncated: z.boolean().optional(),
  })
  .passthrough()
  .meta({ $id: 'Breadcrumb' });

export type Breadcrumb = z.infer<typeof Breadcrumb>;
export type BreadcrumbKind = z.infer<typeof BreadcrumbKind>;
export type BreadcrumbLevel = z.infer<typeof BreadcrumbLevel>;
