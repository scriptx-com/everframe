// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// NetworkBodyEntry — one item in the additive `payload.networkBodies[]` channel
// (spec 2026-07-18 §6). Bodies live HERE, not on the network breadcrumb, so the
// parity-locked crumbCost/trimBreadcrumbs byte budget is never perturbed. Each
// entry is joined to its `kind='network'` breadcrumb by `ref === crumb.data.reqId`.
//
// Native parity has landed (spec 2026-08-01 §7): the shape below is now
// formalized as a Zod schema (`NetworkBodyEntrySchema`) and wired into
// `payload.networkBodies` on the envelope. Web + native emissions are
// validated against this schema, and it is the source of truth for the
// generated Swift/Kotlin types — quicktype names the generated element type
// `NetworkBody` (singular of the array field name, not `NetworkBodyEntry`) in
// both Generated.swift and Generated.kt.
import { z } from 'zod';

/** Why a body direction was not captured. */
export const NETWORK_BODY_SKIP_REASONS = ['content-type', 'unsupported', 'error'] as const;
export type NetworkBodySkipReason = (typeof NETWORK_BODY_SKIP_REASONS)[number];

export interface NetworkBodyEntry {
  /** Join key — matches the network breadcrumb's `data.reqId`. */
  ref: number;
  /** Epoch ms of the request; shared crumb clock; oldest-shed ordering key. */
  t: number;
  reqBody?: string;
  resBody?: string;
  reqBodyTruncated?: boolean;
  resBodyTruncated?: boolean;
  reqBodyBytes?: number;
  resBodyBytes?: number;
  reqHeaders?: Record<string, string>;
  resHeaders?: Record<string, string>;
  reqBodySkipped?: NetworkBodySkipReason;
  /**
   * `'unsupported'` on Android means the response carried an app-applied
   * `Content-Encoding` (the host set its own `Accept-Encoding`, so OkHttp did
   * not transparently decode and the bytes are compressed). Android captures
   * response bodies via a bounded tee on the app's own read — see
   * packages/sdk-android/.../capture/NetworkBodyTee.kt and
   * the public behavior contract
   * The Android REQUEST direction is still unimplemented (that spec §14), so
   * `reqBodySkipped` is never set there.
   */
  resBodySkipped?: NetworkBodySkipReason;
}

/** Formal schema (spec 2026-08-01 §7) — native parity has landed; web + native
 *  emissions are validated against this. Keep field-for-field identical to the
 *  NetworkBodyEntry interface above. */
export const NetworkBodyEntrySchema = z
  .object({
    ref: z.number(),
    t: z.number(),
    reqBody: z.string().optional(),
    resBody: z.string().optional(),
    reqBodyTruncated: z.boolean().optional(),
    resBodyTruncated: z.boolean().optional(),
    reqBodyBytes: z.number().optional(),
    resBodyBytes: z.number().optional(),
    reqHeaders: z.record(z.string(), z.string()).optional(),
    resHeaders: z.record(z.string(), z.string()).optional(),
    reqBodySkipped: z.enum(NETWORK_BODY_SKIP_REASONS).optional(),
    resBodySkipped: z.enum(NETWORK_BODY_SKIP_REASONS).optional(),
  })
  .passthrough();
