// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { buildEnvelope, trimLogs } from '@traceitx/sdk-core';
import type {
  LogEntry,
  NetworkEntry,
  DeviceMetadata,
  ReportDraft,
  ReplayCapture,
  UserMetadata,
} from '@traceitx/sdk-core';
import type {
  FocusedNode,
  ReportEnvelope,
  AttachmentRef,
  Breadcrumb,
  NetworkBodyEntry,
} from '@traceitx/protocol';
import type { WebTraceItXConfig } from '../internal/types.js';
import { REACT_SDK_NAME, type HostSdkName } from '../internal/sdk-identity.js';
import { stampActiveVitals } from '../vitals/stamp-active-vitals.js';
import { stampResources } from '../resources/stamp.js';

/** One baked (or raw) screenshot shot bound for a single attachment (report-window overhaul). */
export interface BundleScreenshot {
  blob: Blob;
  sha256: string;
  width: number;
  height: number;
  /** True when this shot's bytes were baked (annotations present). */
  annotated: boolean;
}

/**
 * Bundle of capture results gathered by ReporterDialog at open time. The bundle is the
 * single struct passed from the dialog up to the Provider's onComplete handler so the
 * envelope-build path is purely functional and free of adapter coupling.
 */
export interface CaptureBundle {
  screenshotBlob: Blob | null;
  screenshotSha256: string | null;
  screenshotWidth: number;
  screenshotHeight: number;
  /** Multi-screenshot payload (report-window overhaul). When present, wins
   *  over the legacy screenshotBlob/… single-shot fields. Ordered: index 0
   *  is the primary shot (bare part names). */
  screenshots?: BundleScreenshot[];
  focused: FocusedNode | null;
  logs: LogEntry[];
  network: NetworkEntry[];
  metadata: DeviceMetadata | null;
  /** PAY-05: surfaced from adapter.__lastDegradedReason at capture time. */
  degradedReason?: string | undefined;
  /** PRE-03 row-level redactions from the reporter dialog. */
  redactedLogIndices?: ReadonlySet<number>;
  /**
   * REPLAY-03 — the frozen, scrubbed, compressed session-replay capture from
   * `adapter.replay.takeFrozen()` on submit. When present (and under the 8 MB
   * client budget) it rides as exactly ONE `kind:'session-replay'` attachment.
   * Over budget → severed (RWEB-02 sever-and-flag): dropped + `replayOmitted` set
   * on captureControl, report still sends.
   */
  replayCapture?: ReplayCapture | null;
  /** SHA-256 hex of `replayCapture.bytes`, precomputed by the provider (async). */
  replaySha256?: string | null;
  /**
   * The frozen breadcrumb chain from the sdk-core client buffer's takeFrozen()
   * on submit (Plan 2). buildEnvelope trims it (spec §4), flags
   * captures.breadcrumbs, and derives legacy logs/network only when those
   * inputs are absent — this bundle still passes explicit logs/network, which
   * win by design (richer, row-redactable sources during the deprecation window).
   */
  breadcrumbs?: Breadcrumb[];
  /** Server-driven trim overrides from adapter.__breadcrumbTrimOptions(). */
  breadcrumbTrim?: { byteBudget?: number; consoleEntryCap?: number };
  /**
   * The frozen network-body snapshot from the sdk-core client buffer's
   * takeFrozen() on submit (Task 8). Opt-in body channel (spec 2026-07-18
   * §6) — already redacted + capped at capture time. buildEnvelope itself
   * drops the channel when the reporter excluded 'network'.
   */
  networkBodies?: NetworkBodyEntry[];
}

/**
 * RWEB-02 — client-side sever-and-flag cap. A compressed replay larger than this
 * is DROPPED (never raises the 25 MB envelope cap); the report still sends with
 * `replayOmitted` flagged on captureControl.
 */
export const REPLAY_BYTE_CAP = 8_000_000;

/**
 * Map device.os → ReportEnvelope.sdk.formFactor enum. Best-effort; default 'desktop'.
 * Exported (spec 2026-07-18 crash-reporting task) so adapter.ts's crash-envelope
 * builder reuses the same inference instead of hardcoding 'desktop'.
 */
export function inferFormFactor(metadata: DeviceMetadata | null): 'phone' | 'tablet' | 'desktop' | 'tv' {
  if (!metadata) return 'desktop';
  const os = metadata.os.toLowerCase();
  if (os.includes('ios')) return 'phone';
  if (os.includes('ipados')) return 'tablet';
  if (os.includes('android')) return 'phone';
  return 'desktop';
}

/**
 * Generate a v4-ish UUID without depending on Node-only crypto APIs. Exported
 * (spec 2026-07-18 crash-reporting task) so adapter.ts's crash-envelope builder
 * shares the same non-secure-context fallback instead of calling
 * `crypto.randomUUID()` directly (which throws outside secure contexts).
 */
export function generateReportId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback — RFC 4122 v4 from getRandomValues; envelope schema only requires UUID format.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface DraftToEnvelopeOutput {
  envelope: ReportEnvelope;
  /** Binary attachment bytes the multipart builder consumes alongside the envelope. */
  attachments: Array<{
    name: string;
    blob: Blob;
    sha256: string;
    kind: 'screenshot' | 'annotated-screenshot' | 'session-replay';
  }>;
}

/**
 * Compose a ReportEnvelope from a reporter draft + capture bundle, honoring:
 *   - PRE-02 excludedArtifacts → captureControl.excluded[] AND payload omits excluded fields
 *   - PRE-03 redactedLogIndices → filter rows pre-envelope (network rows are
 *     not per-row redactable — the artifact-level switch is the only network control)
 *   - Pitfall 8 → exactly one screenshot attachment kind based on whether redactions exist
 *   - PAY-05 degradedReason → captureControl.degradedReason
 *   - AUTH-01 sdk.name from the `sdkName` parameter below, defaulting to
 *     'traceitx-react' (protocol enum lock)
 */
export function draftToEnvelope(
  draft: ReportDraft,
  bundle: CaptureBundle,
  config: WebTraceItXConfig,
  sdkVersion: string,
  /**
   * The self-declared `setUser` value for this report, or null/undefined for
   * none (spec 2026-08-12). Baked into the envelope here, which is also
   * outbox-enqueue time — so a queued report keeps the user who created it
   * rather than whoever is set when it finally drains.
   *
   * External review, finding 1 (Serious) — the caller must hand us the value
   * it captured at the SUBMIT BOUNDARY, not one read live at the call site.
   * This comment previously argued the opposite ("no capture-at-draft-time
   * mechanism is needed the way it is for the identity TOKEN, which is a live
   * credential with an expiry race this label doesn't have"); that was wrong
   * about why the token's capture exists. It has nothing to do with expiry —
   * it exists because an ACCOUNT SWITCH during the seconds-long prep window
   * before this function runs pins the new identity to a report the old
   * identity created, and that applies to this label identically.
   */
  user?: UserMetadata | null,
  /**
   * Phase-3 SDK platform identity — locked by the ReportEnvelope.sdk.name
   * enum (protocol). Defaults to `traceitx-react`, which every call site
   * predating `@traceitx/web`'s own `init()` is; that SDK passes
   * `traceitx-web` so a Vue/Svelte/plain-HTML report is not filed under the
   * React SDK. See internal/sdk-identity.ts.
   *
   * ── Codex round-2 finding 2, THE HALF THAT IS REJECTED (argument recorded
   * here so round 3 does not re-raise it as an oversight) ──
   *
   * The same review asked for this React default to be removed too — made
   * required, or flipped to the vanilla name — because `submitReportFromDraft`
   * (which forwards straight into this parameter) is a PUBLIC export of
   * `@traceitx/web`, so a vanilla consumer calling it without `sdkName` files
   * its in-app report stream under the React SDK. The hazard is real. Neither
   * remedy is available:
   *
   *   • REQUIRED — `packages/sdk-react/src/provider.tsx`'s `onComplete` calls
   *     `submitReportFromDraft({ config, sdkVersion: PKG_VERSION, … })` with
   *     NO `sdkName` and relies on this default. That file is published
   *     `@traceitx/react` v0.6.6 and is explicitly out of bounds for this
   *     change, so requiring the field breaks its typecheck immediately.
   *   • FLIPPED TO VANILLA — same call site, worse outcome: it would silently
   *     relabel every React host's entire in-app report stream `traceitx-web`,
   *     i.e. the exact bug this parameter exists to prevent, aimed at the
   *     higher-volume SDK.
   *   • UNEXPORTED — `provider.tsx` imports `submitReportFromDraft` from the
   *     package specifier `'@traceitx/web'`, so the barrel export in
   *     src/index.ts is load-bearing and cannot be dropped.
   *
   * `createWebPlatformAdapter`'s half of the finding IS fixed (see
   * internal/sdk-identity.ts) because React passes its identity to that one
   * explicitly. THE FIX HERE IS A ONE-LINE CHANGE TO provider.tsx: add
   * `sdkName: 'traceitx-react'` to its `submitReportFromDraft` call, then make
   * this parameter required and delete the default. Until `@traceitx/react`
   * can be edited, a vanilla caller MUST pass `sdkName` explicitly — as
   * `init()` (RULING 18) and the companion host seam both do.
   */
  sdkName: HostSdkName = REACT_SDK_NAME,
): DraftToEnvelopeOutput {
  const excluded = draft.excludedArtifacts.slice();
  const includesScreenshot = !excluded.includes('screenshot');
  const includesFocus = !excluded.includes('focus');
  const includesLogs = !excluded.includes('logs');
  const includesNetwork = !excluded.includes('network');

  // Row-level redaction (PRE-03) — applied before envelope so post-redaction indices
  // never round-trip the user's PII selections.
  const filteredLogs = includesLogs
    ? trimLogs(bundle.logs.filter((_, i) => !bundle.redactedLogIndices?.has(i)))
    : undefined;
  const filteredNet = includesNetwork ? bundle.network : undefined;

  // Pitfall 8 lock — a shot whose bytes were mutated by BlurBakery must ship
  // as 'annotated-screenshot' so viewers know the pixels differ from raw.
  const hasBake =
    (draft.redactions ?? []).length > 0 || (draft.annotations ?? []).length > 0;
  const attachments: DraftToEnvelopeOutput['attachments'] = [];
  const attachmentRefs: AttachmentRef[] = [];
  // Multi-screenshot (report-window overhaul): bundle.screenshots wins when
  // present; the legacy single-shot fields remain the fallback so older
  // callers/tests are untouched.
  const shots: BundleScreenshot[] =
    bundle.screenshots ??
    (bundle.screenshotBlob && bundle.screenshotSha256
      ? [
          {
            blob: bundle.screenshotBlob,
            sha256: bundle.screenshotSha256,
            width: bundle.screenshotWidth,
            height: bundle.screenshotHeight,
            annotated: hasBake,
          },
        ]
      : []);
  if (includesScreenshot) {
    shots.forEach((s, i) => {
      const kind: 'screenshot' | 'annotated-screenshot' = s.annotated
        ? 'annotated-screenshot'
        : 'screenshot';
      // Shot 1 keeps the bare name (backward compat with pre-overhaul
      // dashboards); shots 2..N are suffixed with their 1-based index.
      const name = i === 0 ? kind : `${kind}-${i + 1}`;
      attachments.push({ name, blob: s.blob, sha256: s.sha256, kind });
      attachmentRefs.push({
        partName: name,
        kind,
        contentType: s.blob.type || 'image/png',
        byteLength: s.blob.size,
        sha256: s.sha256,
        width: s.width,
        height: s.height,
      });
    });
  }

  // REPLAY-03 / RWEB-02 — session-replay attachment with sever-and-flag.
  // When a ReplayCapture is present we emit EXACTLY ONE `kind:'session-replay'`
  // attachment ref (partName=kind per the Pitfall-8 discipline) with `format`
  // + `durationMs`. If the compressed bytes exceed the 8 MB client budget the
  // replay is DROPPED (never raises the 25 MB envelope cap), `replayOmitted` is
  // set on captureControl, and the rest of the envelope is built unchanged so the
  // report STILL sends.
  const includesReplay = !excluded.includes('replay');
  let replayOmitted = false;
  if (
    includesReplay &&
    bundle.replayCapture &&
    bundle.replaySha256 &&
    bundle.replayCapture.bytes.byteLength > 0
  ) {
    const capture = bundle.replayCapture;
    if (capture.bytes.byteLength > REPLAY_BYTE_CAP) {
      // Sever-and-flag: drop the replay, flag it, keep building.
      replayOmitted = true;
    } else {
      const replayBlob = new Blob([capture.bytes as unknown as BlobPart], {
        type: capture.contentType,
      });
      attachments.push({
        name: 'session-replay',
        blob: replayBlob,
        sha256: bundle.replaySha256,
        kind: 'session-replay',
      });
      attachmentRefs.push({
        partName: 'session-replay',
        kind: 'session-replay',
        contentType: capture.contentType,
        byteLength: capture.bytes.byteLength,
        sha256: bundle.replaySha256,
        format: capture.format,
        durationMs: capture.durationMs,
      });
    }
  }

  // Build envelope via sdk-core's authoritative builder. PAY-03 truncation, captureControl
  // synthesis, and protocolVersion locking all happen there — we only feed inputs.
  const envelope = buildEnvelope({
    reportId: generateReportId(),
    submittedAt: new Date().toISOString(),
    sdk: {
      name: sdkName,
      version: sdkVersion,
      platform: 'web',
      formFactor: inferFormFactor(bundle.metadata),
    },
    reporter: { title: draft.title, description: draft.description, ...(user ? { user } : {}) },
    draft,
    ...(includesFocus ? { focus: bundle.focused } : {}),
    ...(filteredLogs !== undefined ? { logs: filteredLogs } : {}),
    ...(filteredNet !== undefined ? { network: filteredNet } : {}),
    ...(bundle.breadcrumbs?.length
      ? {
          breadcrumbs: bundle.breadcrumbs,
          ...(bundle.breadcrumbTrim ? { breadcrumbTrim: bundle.breadcrumbTrim } : {}),
        }
      : {}),
    ...(bundle.networkBodies?.length ? { networkBodies: bundle.networkBodies } : {}),
    device: bundle.metadata ?? {
      os: 'unknown',
      osVersion: '',
      screenSize: { width: 0, height: 0 },
      pixelRatio: 1,
      locale: 'en-US',
      timezone: 'UTC',
    },
    app: {
      name: config.appName ?? 'unknown-app',
      version: config.appVersion ?? '0.0.0',
      ...(config.appBuild !== undefined ? { build: config.appBuild } : {}),
    },
    attachments: attachmentRefs,
  });

  // PAY-05 — surface degradedReason on the envelope's captureControl. The sdk-core
  // builder doesn't accept this input directly; we patch it in here so envelope.captureControl
  // is the single source of truth.
  if (bundle.degradedReason !== undefined) {
    (envelope.captureControl as { degradedReason?: string }).degradedReason = bundle.degradedReason;
  }

  // RWEB-02 — surface the sever-and-flag marker on captureControl (PAY-05 surface)
  // so the dashboard can show "replay omitted (over budget)" without a tab.
  if (replayOmitted) {
    (envelope.captureControl as { replayOmitted?: boolean }).replayOmitted = true;
  }

  // Session Vitals (spec 2026-09-01 §8) — additive-optional on the envelope;
  // see stamp-active-vitals.ts for the no-op/live-read/cap doctrine, shared
  // verbatim with the crash-envelope stamp site in adapter.ts (Codex round-1
  // finding S2).
  stampActiveVitals(envelope);

  // Report Resource Window (spec 2026-09-05, Task 9) — additive-optional,
  // same no-op/live-read/cap doctrine as stampActiveVitals above, shared
  // verbatim with the crash-envelope stamp site in adapter.ts. A DIFFERENT
  // block (`payload.resources`, not `payload.vitals`) — Session Vitals
  // itself is untouched by this call.
  stampResources(envelope);

  return { envelope, attachments };
}
