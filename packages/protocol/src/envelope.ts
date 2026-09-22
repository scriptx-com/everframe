// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';
import { FocusedNode } from './focus.js';
import { AttachmentRef } from './attachments.js';
import { Breadcrumb } from './breadcrumb.js';
import { CrashPayload } from './crash.js';
import { NetworkBodyEntrySchema } from './network-body.js';
import { VitalsEntry, MAX_ENVELOPE_VITALS_ENTRIES } from './vitals.js';
import { ResourceSample, MAX_RESOURCE_SAMPLES } from './resources.js';
import { SDKPlatform, FormFactor } from './sdk-platform.js';
import { PROTOCOL_VERSION } from './version.js';

// Re-export for backward compatibility
export { SDKPlatform, FormFactor } from './sdk-platform.js';

export const ReportEnvelope = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    reportId: z.string().uuid(),
    submittedAt: z.string().datetime(),
    // Crash/error reporting (spec 2026-07-18): report provenance. Additive
    // optional — absent means 'manual' (all pre-crash-reporting envelopes).
    // 'crash' = process-terminating unhandled exception; 'error' = non-fatal
    // uncaught (web onerror/unhandledrejection, RN non-fatal).
    source: z.enum(['manual', 'crash', 'error']).optional(),
    // Session vitals (spec 2026-09-01): the always-on collector's session,
    // stamped when vitals were running at submit time. Additive optional —
    // absent on every pre-vitals envelope and whenever vitals are disabled.
    sessionId: z.string().uuid().optional(),
    sdk: z
      .object({
        // Which SDK produced this envelope. Widened AHEAD of SDK delivery,
        // the same way SDKPlatform reserved 'tizen'/'webos' for v1.1
        // (PLAT-04): a receiver must accept the value before any sender can
        // emit it. 'traceitx-web' is the framework-agnostic web SDK
        // (@traceitx/web — Vue, Svelte, Angular, plain HTML), distinct from
        // 'traceitx-react' so a report's host framework stays attributable.
        name: z.enum([
          'traceitx-react',
          'traceitx-web',
          'traceitx-react-native',
          'traceitx-ios',
          'traceitx-android',
        ]),
        version: z.string(),
        platform: SDKPlatform,
        formFactor: FormFactor,
      })
      .passthrough(),
    reporter: z
      .object({
        // Tightened to match every reporter UI surface (web modal, phone-
        // companion SPA, iOS UIKit, Android Compose). Single source of truth —
        // each UI also enforces the same cap at the input layer so the user
        // can't even type past it; the receiver rejects anything that slips
        // through (e.g. a third-party programmatic submit).
        title: z.string().max(200),
        description: z.string().max(600),
        // Self-declared recognition (spec 2026-08-12) — the UNVERIFIED tier.
        // Every field here is a HOST-SUPPLIED LABEL, and NONE of them carries
        // a format or length constraint ON PURPOSE.
        //
        // Before that spec nothing populated `reporter.user`, so the format
        // check that used to sit on `email` was dead code. Now every SDK
        // populates it verbatim from the host's `setUser({id,email,...})`, and
        // `setUser({ id: user.id, email: user.email ?? '' })` is an ordinary
        // host idiom. A constraint here is not a validation nicety: ingest
        // parses the envelope with `ReportEnvelopeStrict` and answers a Zod
        // failure with 400 `schema_validation_failed`
        // (the ingest API/src/ingest/parser.ts, the ingest API/src/ingest/route.ts), so
        // one blank or typo'd email would turn 100% of that app's reports
        // into rejections.
        //
        // A rejected envelope is a LOST BUG REPORT; an unusable email is just
        // an absent attribute. So the arbitration lives at ingest instead —
        // `EMAIL_RE` in the server self-declared identity contract, built
        // deliberately as "a shape check, not validation": it decides whether
        // an email is good enough to be a subject KEY, and anything it dislikes
        // is simply not stored. Recognition must never fail or delay a report.
        //
        // Do not add `.email()`, `.max()`, or `.min()` back here.
        user: z
          .object({
            id: z.string().optional(),
            email: z.string().optional(),
            displayName: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    captures: z
      .object({
        screenshot: z.boolean(),
        /** @deprecated UI-tree capture was removed (spec 2026-08-29). Every
         *  current producer hardcodes `false`. Kept REQUIRED — historical
         *  envelopes in storage carry it, and making it optional would not
         *  help them while dropping it outright would fail them on read. */
        uiTree: z.boolean(),
        focus: z.boolean(),
        logs: z.boolean(),
        network: z.boolean(),
        // Breadcrumbs (2026-07-07 spec): OPTIONAL — additive; pre-breadcrumb
        // envelopes carry only the original five booleans and must keep parsing.
        breadcrumbs: z.boolean().optional(),
      })
      .passthrough(),
    captureControl: z
      .object({
        included: z.array(z.string()),
        excluded: z.array(z.string()),
        degradedReason: z.string().optional(),
      })
      .passthrough(), // PAY-05
    payload: z
      .object({
        focus: FocusedNode.optional(),
        /** @deprecated Derived from `breadcrumbs` (kind=console) — read breadcrumbs instead. */
        logs: z.array(z.unknown()).optional(),
        /** @deprecated Derived from `breadcrumbs` (kind=network) — read breadcrumbs instead. */
        network: z.array(z.unknown()).optional(),
        // Unified kind-tagged action-timeline chain (2026-07-07 spec). Canonical
        // stream; payload.logs / payload.network above are derived from it during
        // the deprecation window. Additive optional — older parsers drop it
        // (.passthrough() preserved). Max 128 = maxCount 100 + headroom for the
        // (bounded, ≤7) per-kind trim markers.
        breadcrumbs: z.array(Breadcrumb).max(128).optional(),
        /** Bodies channel (spec 2026-07-18 §6 / 2026-08-01). Joined to network
         *  crumbs via ref === crumb.data.reqId. */
        networkBodies: z.array(NetworkBodyEntrySchema).optional(),
        // Last ~60 s of vitals entries at submit time (spec 2026-09-01 §2,
        // report enrichment). Bounded by the collector's ring, re-capped here.
        vitals: z.array(VitalsEntry).max(MAX_ENVELOPE_VITALS_ENTRIES).optional(),
        // Report Resource Window (spec 2026-09-05): CPU + memory samples over
        // the last `resource_window_sec` seconds at submit time. Bounded by
        // the SDK's ring, re-capped here — an over-cap block rejects the
        // WHOLE report, not just this field. Additive optional: absent on
        // every pre-2026-09-05 envelope and whenever the feature is off.
        // Independent of `vitals` above; the two never share a schema.
        resources: z.array(ResourceSample).max(MAX_RESOURCE_SAMPLES).optional(),
        annotations: z.array(z.unknown()).optional(), // PAY-04
        redactions: z.array(z.unknown()).optional(), // PAY-04
        // Phase 6 (D-08 — added 2026-05-11): host-supplied free-form
        // metadata. Single opaque string — callers JSON.stringify nested
        // data themselves. Capped at 16384 chars (16 KiB) — a deliberate
        // ceiling sized against its siblings (a single breadcrumb message is
        // 2048 chars), generous enough that hosts should not need to trim.
        // Schema enforces the same ceiling as the SDKs so over-cap envelopes
        // fail validation at the boundary.
        extra: z.string().max(16384).optional(),
        // Unattended-report exception details (spec 2026-07-18). Present iff
        // source is 'crash' or 'error'.
        crash: CrashPayload.optional(),
      })
      .passthrough(),
    context: z
      .object({
        app: z
          .object({
            name: z.string(),
            version: z.string(),
            build: z.string().optional(),
          })
          .passthrough(),
        device: z
          .object({
            os: z.string(),
            osVersion: z.string(),
            model: z.string().optional(),
            screenSize: z.object({ width: z.number(), height: z.number() }),
            pixelRatio: z.number(),
            locale: z.string(),
            timezone: z.string(),
            /**
             * Raw User-Agent. Web SDK fills this from `navigator.userAgent`;
             * native SDKs omit it. Helps triagers disambiguate browser engine
             * + version, in-app webviews, and UA overrides that the OS parser
             * doesn't catch. Schema cap defends against unbounded UA strings.
             */
            userAgent: z.string().max(1024).optional(),
          })
          .passthrough(),
        route: z.string().optional(),
      })
      .passthrough(),
    attachments: z.array(AttachmentRef),
  })
  .passthrough()
  .meta({
    // Draft 2020-12 keyword names: `$id` + `$schema`.
    $id: 'ReportEnvelope',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
  });

export type ReportEnvelope = z.infer<typeof ReportEnvelope>;
