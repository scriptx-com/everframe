// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// TV-side capture + submit bridge for phone-driven reports. Composes the
// existing `captureScreenshot` + adapter capture primitives + the standard
// ingest `submitReportFromDraft` path — REUSED, no Tizen/WebOS branching.
//
// Wire protocol (D-05):
//   report.request →
//     1. text  : `report.assembled` { mime, size, toggles, counts }
//     2. binary: screenshot bytes (WebP @ 0.85 when re-encoding succeeds, else PNG)
//   report.submit →
//     1. text  : `report.submit` { title, description, annotations, includes }
//     2. binary: baked (annotated) screenshot bytes
//   TV then assembles an envelope, submits to ingest, and replies:
//     text   : `report.completed` { event_id } | `report.failed` { reason }
//
// The full TV-submits-to-ingest handshake mirrors the native
// CompanionCaptureBridge (iOS/Android Plan 06.2-13). The host config (apiKey)
// + adapter (capture + outbox) come from the companion host seam, populated by
// `EverframeProvider`. When the seam is empty we reply `report.failed`
// ("submit_unavailable") rather than hang — parity with native.
'use client';
import { readBlobArrayBuffer } from '../internal/blob.js';

import type { z } from 'zod';
import type { FocusedNode } from '@everframe/protocol';
import type {
  LogEntry,
  NetworkEntry,
  DeviceMetadata,
  ReportDraft,
} from '@everframe/sdk-core';
import { captureScreenshot } from '../capture/screenshot.js';
import { getCaptureProfile } from '../capture/capture-profile.js';
import { sha256Hex } from '../capture/sha256.js';
import { relay } from '@everframe/protocol';
import { submitReportFromDraft } from '../transport/submit.js';
import { captureUserSnapshot } from '../internal/user-snapshot.js';
import type { BundleScreenshot, CaptureBundle } from '../transport/draft-to-envelope.js';
import type { RelayWSClient, ReportSubmit } from './ws-client.js';
import type { CompanionAPI } from './state.js';
import type { CompanionHost } from './host-seam.js';
import {
  __companionSeamTicket,
  __isCompanionKilled,
  type CompanionSeamTicket,
} from './host-seam.js';
import { createPreviewLoop, type PreviewFrameCapture, type PreviewLoop } from './preview-loop.js';
import {
  createShotStash,
  type NormalizedRect as ShotRect,
  type ShotStash,
  type StashedShotCapture,
} from './shot-stash.js';

type ReportAssembled = z.infer<typeof relay.ReportAssembled>;
type ReportCompleted = z.infer<typeof relay.ReportCompleted>;
type ReportFailed = z.infer<typeof relay.ReportFailed>;

/** Structural shape of `captureScreenshot` / `adapter.captureScreenshot`. */
interface ScreenshotResult {
  blob: Blob;
  width: number;
  height: number;
  sha256: string;
}

export interface ReportCounts {
  logs: number;
  network: number;
  uiTreeNodes: number;
  /** Optional (protocol 0.3.x additive): live breadcrumb inventory for the
   * phone's summary line. Undefined when the caller has no breadcrumb
   * buffer to consult (e.g. the explicit-host path). */
  breadcrumbs?: number;
}

// ─── companion submit state ──────────────────────────────────────────────
//
// Capture taken at report.request time, stashed by correlation_id so the
// later report.submit can build a complete envelope (logs/network/metadata
// are NOT re-sent by the phone — only the baked screenshot is).
interface StashedCapture {
  logs: LogEntry[];
  network: NetworkEntry[];
  metadata: DeviceMetadata | null;
  focused: FocusedNode | null;
  screenshotWidth: number;
  screenshotHeight: number;
}
const requestStash = new Map<string, StashedCapture>();

// Single in-flight submit (the relay state machine is one report at a time).
// Wire ordering (plan 2026-08-12 Task 8): `report.submit` (text, with
// `shots[]`), then shot #1's baked binary, then per extra shot a
// `shot.binary {shot_id}` marker followed by that shot's baked binary. The
// primary text/binary pair tolerates either order (pre-multi-shot behavior);
// extra-shot binaries are bound by the marker that precedes them.
let pendingSubmitMsg: ReportSubmit | null = null;
let pendingBakedBytes: ArrayBuffer | null = null;
// Armed by a `shot.binary` marker: the NEXT binary belongs to that shot, not
// to the report's primary screenshot. Mirrors iOS's pendingShotBinary — and
// its warning: this binding outlives the phone leg, so it MUST be reset on
// cancel/peer loss or the next report's primary binary is routed into a dead
// shot and that report waits forever for a primary that already arrived.
let pendingShotBinding: { correlationId: string; shotId: string } | null = null;
const pendingShotParts = new Map<string, ArrayBuffer>();

/** Forget every partially-received submit (mirrors iOS resetSubmitFraming). */
function resetSubmitFraming(): void {
  pendingSubmitMsg = null;
  pendingBakedBytes = null;
  pendingShotBinding = null;
  pendingShotParts.clear();
}

/** Test seam. */
export function __resetCompanionSubmitFramingForTests(): void {
  resetSubmitFraming();
}

/** All frames of the submit present: text, primary binary, every shots[] part. */
function submitComplete(): boolean {
  if (pendingSubmitMsg === null || pendingBakedBytes === null) return false;
  const shots = (pendingSubmitMsg as { shots?: Array<{ shot_id: string }> }).shots ?? [];
  return shots.every((s) => pendingShotParts.has(s.shot_id));
}

/**
 * Handle a `report.request` when the SDK owns capture (host seam present).
 * Captures the FULL bundle (screenshot + logs + network + metadata),
 * stashes it by correlation_id for the matching `report.submit`, then ships
 * the assembled metadata + binary screenshot to the phone.
 */
export async function handleCompanionReportRequest(
  correlationId: string,
  ws: RelayWSClient,
  host: CompanionHost,
): Promise<void> {
  const adapter = host.adapter;

  // Codex round-5 finding 1 (P1) — WHO began this operation, captured before
  // the first await. Every check below re-reads the seam through this ticket
  // instead of asking the page for its current mood: `destroy()` followed by
  // an `init()` for a different tenant leaves the page looking perfectly
  // healthy while THIS host is gone, and a successor cannot vouch for its
  // predecessor's in-flight pixels. See `seamTicketDead`.
  const ticket = __companionSeamTicket(host);

  // Codex round-2 finding 1, the companion half — gated at the CAPTURE end as
  // well as the submit end. `report.request` is the companion's reporter-open:
  // it freezes the replay window and photographs the user's screen, then ships
  // those pixels over the relay to the paired phone. Submitting is not the
  // only harm a withdrawn consent has to stop, and this is the earlier of the
  // two doors. Answered (never dropped) so the phone leaves its "capturing…"
  // state immediately, with the same reason the submit gate uses.
  if (__isCompanionKilled(ticket)) {
    ws.send(reportFailed(correlationId, 'submit_unavailable'));
    return;
  }

  // Registered BEFORE the captures below so a cancel arriving mid-capture
  // can claim ownership (`requestStash` is populated only after they
  // resolve — review round 3, finding 1). Cleared by cancel/peer loss;
  // the post-capture check below then aborts instead of stashing and
  // shipping a report the phone already discarded.
  activeRequestCorrelation = correlationId;

  // Capture-lifecycle (spec 2026-07-17 §1): report.request IS reporter-open
  // for the companion. Discard-then-freeze so a stale snapshot from an
  // abandoned report can never shadow this one (both discards no-op when
  // nothing is frozen). DEFE-02: never let this block the capture.
  try {
    adapter.__replayLifecycle?.cancel();
    adapter.__replayLifecycle?.freeze();
  } catch {
    /* swallow */
  }
  try {
    const crumbs = adapter.__getBreadcrumbBuffer?.();
    crumbs?.discardAndResume();
    crumbs?.freeze();
  } catch {
    /* swallow */
  }

  const screenshot = await adapter.captureScreenshot().catch(() => null);
  // Codex round-3 finding 4 (P1) — re-checked AFTER the capture await. The
  // entry gate above (and the seam gate that now precedes it) both ran before
  // a screenshot that takes seconds on TV silicon; a `kill()` landing inside
  // that window still stashed the bundle and shipped the pixels to the phone.
  //
  // ANSWERED, not dropped: going silent here would strand the phone in
  // "capturing…" until its correlation timed out. `adapter.captureScreenshot`
  // now rejects once killed, so in practice `screenshot` is already null on
  // this path — but the reply is what the phone needs, and the two other
  // captures below (logs/network) resolve to empty rather than throwing.
  //
  // Codex round-5 finding 1 (P1) — against the TICKET, not the page. The
  // global boolean this used to read was cleared by any later host
  // publication, so a `destroy()` + `init()` for the next tenant handed this
  // capture a pass and shipped the previous tenant's screen to the phone.
  if (__isCompanionKilled(ticket)) {
    ws.send(reportFailed(correlationId, 'submit_unavailable'));
    return;
  }
  // Cancelled (or superseded) while capturing — do not stash, do not ship.
  if (activeRequestCorrelation !== correlationId) return;
  const logs = safe(() => adapter.captureRecentLogs(), []);
  const network = safe(() => adapter.captureRecentNetwork(), []);
  const metadata = safe(() => adapter.getDeviceMetadata(), null);
  const focused = safe(() => adapter.captureFocusedNode(), null);

  // Single report in-flight (relay state machine). Drop any prior stash so an
  // abandoned/cancelled request (phone closed before submit) can't leak its
  // capture for the life of the TV session.
  requestStash.clear();
  requestStash.set(correlationId, {
    logs,
    network,
    metadata,
    focused,
    screenshotWidth: screenshot?.width ?? 0,
    screenshotHeight: screenshot?.height ?? 0,
  });

  if (!screenshot) return; // nothing to ship; submit will degrade gracefully
  await shipCapture(correlationId, ws, screenshot, ticket, {
    logs: logs.length,
    network: network.length,
    // Tap-to-identify is gone: no tree is captured, so the count is always 0.
    // The field itself stays REQUIRED in the relay schema so a legacy phone
    // still parses the frame.
    uiTreeNodes: 0,
    breadcrumbs: host.adapter.__getBreadcrumbBuffer?.()?.size ?? 0,
  });
}

/**
 * Handle a `report.request` with host-supplied counts (explicit-host path).
 * Captures via the standalone `captureScreenshot` (no adapter masking)
 * — kept for hosts that wire `createRelayWSClient` directly.
 */
export async function handleReportRequest(
  correlationId: string,
  ws: RelayWSClient,
  counts: ReportCounts,
  ticket?: CompanionSeamTicket,
): Promise<void> {
  // Codex round-3 finding 4 (P1) — the ONE companion path that cannot inherit
  // the `__getCompanionHost()` kill gate, because it is the path taken when
  // that function returns null. Reads the raw predicate instead: a killed host
  // must not be mistaken for an absent one and silently downgraded to the
  // screenshot-only handler, which would have kept photographing the screen
  // through the very gate that was supposed to stop it.
  //
  // Codex round-5 finding 3 (P2) — judged against the SESSION's ticket when
  // one is supplied. `companion.start()` takes a ticket (singleton.ts) so this
  // asks "has a host been torn down since MY session opened?" rather than "has
  // one ever been torn down on this page?". The first question keeps round 4's
  // fix — a session that outlived its host's `destroy()` still refuses — while
  // letting a `stop()` → `start()` companion-only session work, which is the
  // supported standalone entry point and was answering `submit_unavailable`
  // for every report until the page reloaded. No ticket (a hand-wired host
  // calling this export directly) keeps the page-wide answer: with an unknown
  // starting point the only safe assumption is the earliest one.
  if (__isCompanionKilled(ticket)) {
    ws.send(reportFailed(correlationId, 'submit_unavailable'));
    return;
  }
  const result = await captureScreenshot();
  await shipCapture(correlationId, ws, result, ticket, counts);
}

/** Ship `report.assembled` + the screenshot binary. */
async function shipCapture(
  correlationId: string,
  ws: RelayWSClient,
  screenshotResult: ScreenshotResult,
  /** The seam identity its caller began under — see `handleCompanionReportRequest`. */
  ticket: CompanionSeamTicket | undefined,
  counts: ReportCounts,
): Promise<void> {
  // Codex round-3 finding 4 (P1) — THE pixel-emit choke point for both
  // `report.request` paths. Each of them awaits a capture before reaching
  // here, so this is the last statement before the user's screen goes over
  // the relay; the callers' own gates cannot cover the window their awaits
  // open. Silent, unlike the callers': they have already answered the phone
  // with `report.failed` on the same condition, and a second frame for one
  // correlation is a protocol error.
  if (__isCompanionKilled(ticket)) return;
  // Re-encode PNG → WebP for the relay hop. ~70-80% byte reduction for
  // screenshot-class images, no visible quality loss at q=0.85. Falls back
  // to the original PNG bytes if WebP encode is unsupported (Tizen/WebOS
  // WebViews of varying vintages — q.v. canvas.toBlob shipping null).
  // A capture that is ALREADY WebP (the TV profile encodes it at the source,
  // screenshot.ts) passes through untouched: re-encoding it would cost a full
  // decode+encode round on the slowest hardware, and the pre-existing
  // fallback would have relabelled its bytes image/png.
  const alreadyWebP = screenshotResult.blob.type === 'image/webp';
  const screenshot = alreadyWebP
    ? null
    : await reencodeToWebP(screenshotResult.blob).catch(() => null);
  const screenshotBlob = screenshot ?? screenshotResult.blob;
  const screenshotBuf = await readBlobArrayBuffer(screenshotBlob);
  const screenshotMime: 'image/png' | 'image/webp' =
    alreadyWebP || screenshot !== null ? 'image/webp' : 'image/png';

  const assembled: ReportAssembled = {
    type: 'report.assembled',
    correlation_id: correlationId,
    mime: screenshotMime,
    size: screenshotBuf.byteLength,
    toggles: {
      logs: true,
      network: true,
      // No UI tree is captured on any producer any more — both natives send
      // `false` here too. The field stays REQUIRED in the relay schema so a
      // legacy phone still parses the frame, but it must report the truth:
      // a `true` here would have the phone echo it back in `includes`, and
      // an artifact that cannot exist has no business claiming it was on.
      uiTree: false,
      metadata: true,
      screenshot: true,
    },
    counts: {
      logs: counts.logs,
      network: counts.network,
      uiTreeNodes: counts.uiTreeNodes,
      ...(counts.breadcrumbs !== undefined ? { breadcrumbs: counts.breadcrumbs } : {}),
    },
  };

  ws.send(assembled);
  ws.sendBinary(screenshotBuf);
}

/**
 * Handle a `report.submit` text frame. Stash it and try to pair with the
 * baked-screenshot binary (which arrives immediately after). `host` may be
 * null (no Provider mounted) — `runCompanionSubmit` then replies
 * `report.failed("submit_unavailable")`.
 */
export function handleCompanionSubmitText(
  msg: ReportSubmit,
  ws: RelayWSClient,
  host: CompanionHost | null,
  companion: CompanionAPI,
): void {
  pendingSubmitMsg = msg;
  maybeRunSubmit(ws, host, companion);
}

/**
 * `shot.binary {shot_id}` marker: bind the NEXT binary to that shot — but
 * only when a pending `report.submit` for the SAME correlation announced
 * that shot_id in its `shots[]` (review round 2, finding 2). Task 8's wire
 * order puts the submit text first, so a legitimate marker always finds its
 * submit here; anything else (stale correlation, unannounced id, no submit
 * at all) is dropped, which also bounds `pendingShotParts` by the announced
 * list.
 */
export function handleCompanionShotBinaryMarker(msg: {
  correlation_id: string;
  shot_id: string;
}): void {
  const pending = pendingSubmitMsg as
    | { correlation_id: string; shots?: Array<{ shot_id: string }> }
    | null;
  if (pending === null || pending.correlation_id !== msg.correlation_id) return;
  if (!(pending.shots ?? []).some((s) => s.shot_id === msg.shot_id)) return;
  pendingShotBinding = { correlationId: msg.correlation_id, shotId: msg.shot_id };
}

/**
 * Handle a submit-phase binary: an extra shot's baked image when a
 * `shot.binary` marker armed the binding, otherwise the primary baked
 * screenshot that follows `report.submit`.
 */
export function handleCompanionSubmitBinary(
  bytes: ArrayBuffer,
  ws: RelayWSClient,
  host: CompanionHost | null,
  companion: CompanionAPI,
): void {
  if (pendingShotBinding !== null) {
    pendingShotParts.set(pendingShotBinding.shotId, bytes);
    pendingShotBinding = null;
  } else {
    pendingBakedBytes = bytes;
  }
  maybeRunSubmit(ws, host, companion);
}

/** Launch the submit once every frame of it has arrived. */
function maybeRunSubmit(
  ws: RelayWSClient,
  host: CompanionHost | null,
  companion: CompanionAPI,
): void {
  if (!submitComplete()) return;
  const msg = pendingSubmitMsg!;
  const bytes = pendingBakedBytes!;
  const shotParts = new Map(pendingShotParts);
  resetSubmitFraming();
  void runCompanionSubmit(msg, bytes, shotParts, ws, host, companion);
}

async function runCompanionSubmit(
  msg: ReportSubmit,
  bakedBytes: ArrayBuffer,
  shotParts: Map<string, ArrayBuffer>,
  ws: RelayWSClient,
  host: CompanionHost | null,
  companion: CompanionAPI,
): Promise<void> {
  try {
    if (!host) {
      ws.send(reportFailed(msg.correlation_id, 'submit_unavailable'));
      return;
    }

    // Codex round-2 finding 1, the companion half — the kill switch reaches
    // this route too. Answered with the SAME `submit_unavailable` the
    // no-host branch above uses rather than a new wire reason: from the
    // phone's side the two are the same fact ("this device cannot submit"),
    // and the paired phone, the relay and the dashboard already render it.
    // Fails CLOSED and answers rather than going silent — a dropped frame
    // would strand the phone's "sending…" state until the correlation timed
    // out. See `CompanionHost.isKilled`; absent (React) means not killed.
    //
    // Codex round-5 finding 1 (P1) — captured as a TICKET (the host that began
    // this submit) and re-read through it below, rather than re-asking the
    // page. `destroy()` + an `init()` for the next tenant used to clear the
    // page-global teardown flag, and this report — prepared under a host that
    // no longer exists — reached ingest anyway.
    const ticket = __companionSeamTicket(host);
    if (__isCompanionKilled(ticket)) {
      ws.send(reportFailed(msg.correlation_id, 'submit_unavailable'));
      return;
    }

    // PR review, round 4 (Serious) — the companion path's SUBMIT BOUNDARY:
    // captured as the very first thing this function does with a live host,
    // before the screenshot hashing / replay-lifecycle-complete / breadcrumb
    // snapshotting below — the exact same class of window provider.tsx's
    // `onComplete` closes, on the phone-driven entry point into report
    // submission. See submit.ts's `capturedIdentityToken` doc for the full
    // chain of rounds this closes.
    //
    // External review, finding 1 (Serious) — the self-declared user
    // (`setUser`) is captured at this same boundary, and FIRST: it is
    // synchronous, so taking it ahead of the token's `await` costs nothing and
    // leaves no window at all. Read through `host.getUser()` (the seam's own
    // live getter — a hand-wired host can implement `CompanionHost` without
    // the Provider ever having bound the adapter's user getter) rather than
    // the adapter method the in-process path uses; `captureUserSnapshot`
    // supplies the identical never-throw + clone semantics either way.
    const capturedUser = captureUserSnapshot(() => host.getUser());
    // Host-supplied free-form metadata (setExtra) — captured at the same
    // boundary, same never-throw posture: an extra getter failure must never
    // cost the report (it degrades to no extra, exactly like no user).
    const capturedExtra = safe(() => host.getExtra?.() || undefined, undefined);
    const capturedIdentityToken = await host.adapter.__captureIdentityAtSubmitBoundary();
    // Companion attach (spec 2026-08-07): a token captured off the bonding
    // `pair.bonded` frame — absent on an ordinary QR pairing. SECURITY:
    // never log; it is read once here and handed straight to the header
    // wrapper below, nowhere else. Read AFTER the identity capture above so
    // that boundary stays the first thing this function does.
    const attributionToken = ws.getCompanionAttribution?.() ?? null;

    const stashed = requestStash.get(msg.correlation_id) ?? null;
    const mime = sniffImageMime(bakedBytes);
    const screenshotBlob = new Blob([bakedBytes], { type: mime });
    const screenshotSha256 = await sha256Hex(screenshotBlob);

    // includes → excludedArtifacts (inverse). `metadata` is always carried via
    // the envelope's `device` block, so it has no excludedArtifacts token;
    // `screenshot` is always true in the relay schema.
    //
    // `includes.uiTree` is deliberately NOT mapped: the toggle is echoed back
    // from the `false` we announce above, so every report would otherwise
    // carry `captureControl.excluded: ['uiTree']` — which triage and admin
    // both read as "the user switched this off" rather than "this artifact no
    // longer exists". No tree can be captured, so nothing can be excluded.
    const excluded: string[] = [];
    if (!msg.includes.logs) excluded.push('logs');
    if (!msg.includes.network) excluded.push('network');
    if (!msg.includes.screenshot) excluded.push('screenshot');

    const draft: ReportDraft = {
      title: msg.title,
      description: msg.description.text,
      excludedArtifacts: excluded,
      // Stroke/arrow/blur — already baked into `bakedBytes` by the phone; kept
      // on the draft so draftToEnvelope marks the attachment annotated-screenshot.
      annotations: msg.annotations,
      // Description text-range redactions (PII spans in the description string).
      redactions: msg.description.redactions,
      // envelope-builder maps this to payload.extra. An over-budget value is
      // evicted key-by-key (object form) or omitted outright (string form)
      // rather than sliced — the emitted value always parses; see
      // sdk-core/src/extra-budget.ts.
      ...(capturedExtra ? { extra: capturedExtra } : {}),
    };

    // The envelope must advertise the BAKED image's dimensions — the phone
    // may have cropped the primary before submit, so request-time
    // full-screen dims can be wrong (review round 3, finding 4). Decode
    // with the stashed dims as the degraded fallback (DEFE-02).
    const primaryDims = await decodeImageBlob(screenshotBlob, 300)
      .then((img) => ({ w: img.naturalWidth, h: img.naturalHeight }))
      .catch(() => ({ w: stashed?.screenshotWidth ?? 0, h: stashed?.screenshotHeight ?? 0 }));

    const bundle: CaptureBundle = {
      screenshotBlob,
      screenshotSha256,
      screenshotWidth: primaryDims.w,
      screenshotHeight: primaryDims.h,
      focused: stashed?.focused ?? null,
      logs: stashed?.logs ?? [],
      network: stashed?.network ?? [],
      metadata: stashed?.metadata ?? null,
    };

    // Multi-shot (spec 2026-07-17 §3): each extra baked image arrived bound
    // by its `shot.binary` marker; ship primary + extras via the bundle's
    // multi-screenshot payload (index 0 = primary). Absent shots[] keeps the
    // legacy single-shot fields byte-identical to pre-multi-shot behavior.
    const submitShots =
      (msg as { shots?: Array<{ shot_id: string; annotations: unknown[] }> }).shots ?? [];
    if (submitShots.length > 0) {
      const extras: BundleScreenshot[] = [];
      for (const s of submitShots) {
        const bytes = shotParts.get(s.shot_id);
        if (bytes === undefined) continue; // submitComplete() guards; defensive
        const blob = new Blob([bytes], { type: sniffImageMime(bytes) });
        // Baked dims aren't echoed by the phone — decode for the envelope,
        // degrading to 0x0 rather than failing the report (DEFE-02).
        const dims = await decodeImageBlob(blob, 300)
          .then((img) => ({ w: img.naturalWidth, h: img.naturalHeight }))
          .catch(() => ({ w: 0, h: 0 }));
        extras.push({
          blob,
          sha256: await sha256Hex(blob),
          width: dims.w,
          height: dims.h,
          annotated: (s.annotations?.length ?? 0) > 0,
        });
      }
      bundle.screenshots = [
        {
          blob: screenshotBlob,
          sha256: screenshotSha256,
          width: primaryDims.w,
          height: primaryDims.h,
          annotated: msg.annotations.length > 0,
        },
        ...extras,
      ];
    }

    // Replay + breadcrumbs (spec 2026-07-17 §1-2) — parity with the native
    // reporter's onComplete path in provider.tsx. DEFE-02 throughout.
    try {
      const lifecycle = host.adapter.__replayLifecycle;
      if (lifecycle) {
        const capture = await lifecycle.complete();
        if (capture && capture.bytes.byteLength > 0) {
          bundle.replayCapture = capture;
          bundle.replaySha256 = await sha256Hex(
            new Blob([capture.bytes as unknown as BlobPart]),
          );
        }
      }
    } catch {
      /* swallow */
    }
    try {
      const frozen = host.adapter.__getBreadcrumbBuffer?.()?.takeFrozen();
      if (frozen && frozen.length > 0) {
        bundle.breadcrumbs = frozen;
        bundle.breadcrumbTrim = host.adapter.__breadcrumbTrimOptions();
      }
    } catch {
      /* swallow */
    }

    // Codex round-3 finding 4 (P1) — THE TRANSPORT BOUNDARY, re-checked, for
    // the same reason as init.ts's in-app submit: the entry gate above is
    // separated from this line by identity capture, SHA-256 hashing, image
    // decodes and the replay window's scrub+gzip. A `kill()` landing in that
    // window still reached ingest. Answered with the same
    // `submit_unavailable` the entry gate uses so the phone's "sending…"
    // state resolves identically however late the switch was pulled.
    //
    // Codex round-5 finding 1 (P1) — against the ticket taken at entry. A
    // successor tenant's `init()` must not vouch for the report its
    // predecessor prepared: the question here is whether the host that began
    // this submit is still the current one, not whether anyone holds the seam.
    if (__isCompanionKilled(ticket)) {
      ws.send(reportFailed(msg.correlation_id, 'submit_unavailable'));
      return;
    }
    const outcome = await submitReportFromDraft({
      config: host.config,
      ...(host.sdkName ? { sdkName: host.sdkName } : {}),
      sdkVersion: host.sdkVersion,
      draft,
      bundle,
      outbox: host.adapter.outbox,
      identityToken: host.adapter.__identityTokenReader,
      // Round 4 — pin to what was captured at the submit boundary above.
      capturedIdentityToken,
      // Task 15 (2026-08-12) — the phone-companion submit path's counterpart
      // to provider.tsx's in-process `user` threading (Task 7). Read via the
      // seam's getter, not a value stored on the seam.
      //
      // External review, finding 1 (Serious) — but read at the SUBMIT
      // BOUNDARY at the top of this function, not here: everything between
      // the two (screenshot hashing, replay-lifecycle completion, breadcrumb
      // snapshotting) is exactly the window an account switch has to land in
      // to misattribute the report. `captureUserSnapshot` never throws — a
      // host-supplied `getUser` that does degrades to anonymous rather than
      // hitting this function's outer try/catch, whose fallback is
      // `report.failed('ingest_error')`; losing the entire report over a
      // recognition getter would violate "recognition must never fail a
      // report."
      user: capturedUser,
      fetch: withCompanionAttribution(attributionToken),
    });

    if (outcome.ok) {
      // ReportCompleted.event_id is the client-generated report id (the ingest
      // 2xx response carries no separate event id today); the phone only needs
      // a stable string to unblock and surface "Report sent".
      ws.send(reportCompleted(msg.correlation_id, outcome.reportId));
    } else {
      ws.send(
        reportFailed(
          msg.correlation_id,
          outcome.retryable ? 'ingest_retryable' : 'ingest_error',
        ),
      );
    }
  } catch {
    // DEFE-02 — never let a submit-path throw escape; always answer the phone.
    ws.send(reportFailed(msg.correlation_id, 'ingest_error'));
  } finally {
    requestStash.delete(msg.correlation_id);
    if (activeRequestCorrelation === msg.correlation_id) activeRequestCorrelation = null;
    // The report is over either way — a lingering preview loop or a stash of
    // full-res captures must not outlive it (round 1, finding 6). Scoped to
    // THIS report's correlation: a slow ingest for c1 settling after the
    // phone re-bonded and opened c2 must not tear down c2's session
    // (round 2, finding 4).
    if (activePreviewCorrelation === msg.correlation_id) {
      activePreview?.stopSilently();
      activePreview = null;
      activePreviewCorrelation = null;
    }
    if (activeShotStash?.correlationId === msg.correlation_id) {
      activeShotStash.stash.clear();
      activeShotStash = null;
    }
    // Return the TV to Paired so its host UI clears the "report in progress"
    // indicator (the TV sends report.completed/failed, so the inbound-frame
    // path in ws-client never fires for its own report) — unless a NEWER
    // report is already mid-flight (its request stash or submit framing is
    // live), whose 'report_in_progress' this stale finally must not stomp.
    if (requestStash.size === 0 && pendingSubmitMsg === null) {
      companion.__setState('paired');
    }
  }
}

// ─── live preview + multi-shot (spec 2026-07-17 §3, Task 9) ──────────────
//
// One preview loop and one shot stash at a time — the relay state machine is
// one report per pair, matching `requestStash` above. Both are torn down on
// report.cancelled and on peer loss so an abandoned draft can never leave a
// device streaming its screen.

const PREVIEW_INTERVAL_MS = 500; // 2 fps — the ceiling of the spec's 1–2 fps budget
const PREVIEW_MAX_DURATION_MS = 120_000; // 2 minutes, device-enforced
const PREVIEW_MAX_EDGE = 854; // ~480p LONGEST edge (portrait too); crops re-capture at full res

type RelaySender = Pick<RelayWSClient, 'send' | 'sendBinary'>;

let activePreview: PreviewLoop | null = null;
let activePreviewCorrelation: string | null = null;
let activeShotStash: { correlationId: string; stash: ShotStash } | null = null;
// The report.request currently mid-capture (set before its awaits) — the
// cancel gate's ownership check must see a report whose requestStash entry
// doesn't exist yet (review round 3, finding 1).
let activeRequestCorrelation: string | null = null;

/**
 * Ownership predicate shared by the cancel gate and ws-client's paired
 * transition: does the bridge currently track this correlation anywhere?
 * The second return-true arm keeps legacy hosts (custom handlers, no bridge
 * state at all) on the old unconditional-transition behavior.
 */
export function __companionShouldSettleOnCancel(correlationId: string): boolean {
  const tracksAnything =
    requestStash.size > 0 ||
    activeRequestCorrelation !== null ||
    activeShotStash !== null ||
    activePreviewCorrelation !== null ||
    pendingSubmitMsg !== null;
  if (!tracksAnything) return true;
  return (
    requestStash.has(correlationId) ||
    activeRequestCorrelation === correlationId ||
    activeShotStash?.correlationId === correlationId ||
    activePreviewCorrelation === correlationId ||
    (pendingSubmitMsg as { correlation_id?: string } | null)?.correlation_id === correlationId
  );
}

/** Test seam — is a device-side preview currently streaming? */
export function __companionPreviewRunning(): boolean {
  return activePreview?.running ?? false;
}

/**
 * `preview.start` from the phone. With a host seam the device starts a real
 * capture loop; without one it declines exactly as it did before Task 9 —
 * the phone shows "this app doesn't support live view" instead of hanging
 * on an empty viewport until its no-frame timeout.
 */
export function handleCompanionPreviewStart(
  host: CompanionHost | null,
  ws: RelaySender,
  correlationId: string,
  captureImpl?: () => Promise<PreviewFrameCapture>,
  profileImpl: typeof getCaptureProfile = getCaptureProfile,
): void {
  // Every profile currently declines live preview (capture-profile.ts —
  // a frame costs a full DOM capture, ~6s on TV silicon, a continuous tax
  // everywhere). The phone shows its standard "live view unavailable"
  // fallback; the loop machinery below stays for per-tier re-enablement.
  if (host === null || !profileImpl().livePreview) {
    ws.send({
      type: 'preview.stop',
      correlation_id: correlationId,
      reason: 'capture_unavailable',
    } as unknown as Parameters<RelaySender['send']>[0]);
    return;
  }
  if (activePreview?.running) return; // reconnect re-send — one loop only
  const loop = createPreviewLoop({
    intervalMs: PREVIEW_INTERVAL_MS,
    maxDurationMs: PREVIEW_MAX_DURATION_MS,
    capture: captureImpl ?? (() => capturePreviewFrame(host)),
    send: (m) => ws.send(m as Parameters<RelaySender['send']>[0]),
    sendBinary: (b) => ws.sendBinary(b),
  });
  activePreview = loop;
  activePreviewCorrelation = correlationId;
  loop.start(correlationId);
}

/** `preview.stop` from the phone (its add-shot screen closed). No echo. */
export function handleCompanionPreviewStop(): void {
  activePreview?.stopSilently();
  activePreview = null;
  activePreviewCorrelation = null;
}

/**
 * `shot.request` from the phone. Unknown shot_id → fresh full-res capture,
 * stashed; known shot_id → re-crop of the stash (see shot-stash.ts).
 */
export async function handleCompanionShotRequest(
  host: CompanionHost | null,
  ws: RelaySender,
  msg: { correlation_id: string; shot_id: string; rect?: ShotRect },
  impls?: {
    capture?: () => Promise<StashedShotCapture>;
    crop?: (
      source: StashedShotCapture,
      rect: { x: number; y: number; w: number; h: number },
    ) => Promise<StashedShotCapture>;
  },
): Promise<void> {
  if (host === null) {
    ws.send({
      type: 'shot.failed',
      correlation_id: msg.correlation_id,
      shot_id: msg.shot_id,
      reason: 'capture_unavailable',
    } as unknown as Parameters<RelaySender['send']>[0]);
    return;
  }
  // Codex round-5 finding 1 (P1), the shot path. Round 3 gated this handler at
  // ENTRY — `host` is already the seam's answer, so a killed or absent host is
  // refused above — but the capture it starts is the same full-resolution
  // screen grab `report.request` takes, seconds of it on TV silicon. Nothing
  // re-asked afterwards, so a `destroy()` (or a successor tenant's `init()`)
  // landing inside that window still shipped the pixels. The ticket is taken
  // here and re-read at the one place the stash reaches the wire, which is the
  // only line that matters: an emit that is not ours any more never leaves the
  // device, and the phone is told rather than left waiting on its no-frame
  // timeout.
  const ticket = __companionSeamTicket(host);
  if (activeShotStash === null || activeShotStash.correlationId !== msg.correlation_id) {
    const refuse = (shotId: string): void => {
      ws.send({
        type: 'shot.failed',
        correlation_id: msg.correlation_id,
        shot_id: shotId,
        reason: 'capture_unavailable',
      } as unknown as Parameters<RelaySender['send']>[0]);
    };
    activeShotStash = {
      correlationId: msg.correlation_id,
      stash: createShotStash({
        correlationId: msg.correlation_id,
        capture: impls?.capture ?? (() => captureShotFull(host)),
        crop: impls?.crop ?? cropShotCapture,
        send: (m) => {
          if (__isCompanionKilled(ticket)) {
            refuse((m as { shot_id?: string }).shot_id ?? msg.shot_id);
            return;
          }
          ws.send(m as Parameters<RelaySender['send']>[0]);
        },
        sendBinary: (b) => {
          if (__isCompanionKilled(ticket)) return;
          ws.sendBinary(b);
        },
      }),
    };
  }
  await activeShotStash.stash.handle({
    shotId: msg.shot_id,
    ...(msg.rect !== undefined ? { rect: msg.rect } : {}),
  });
}

/**
 * The peer is gone — `phone.disconnected` (server-emitted the moment the
 * phone socket closes) or `pair.expired`. Stop capturing IMMEDIATELY rather
 * than waiting for the time cap: there is nobody to send frames to, and a
 * device that keeps reading the screen after the session ended is exactly
 * what the four auto-stop triggers exist to rule out.
 *
 * No `preview.stop` frame goes out — there is no peer to receive one.
 */
export function handleCompanionPeerLost(): void {
  activeRequestCorrelation = null; // aborts a report.request still capturing
  activePreview?.stopSilently();
  activePreview = null;
  activePreviewCorrelation = null;
  // clear() (not just dropping the reference) makes any in-flight capture
  // inert — a late resolution must neither retain pixels nor send frames
  // into a possibly re-bonded socket (review round 1, finding 5).
  activeShotStash?.stash.clear();
  activeShotStash = null;
  // The shot.binary binding outlives the phone leg (see resetSubmitFraming's
  // doc) — a half-received submit must not poison the next report's framing.
  resetSubmitFraming();
}

/** Adapter screenshot → downscaled JPEG preview frame (throws when unsupported). */
async function capturePreviewFrame(host: CompanionHost): Promise<PreviewFrameCapture> {
  const shot = await host.adapter.captureScreenshot();
  const img = await decodeImageBlob(shot.blob);
  // Cap the LONGEST edge, not the width — a portrait 1080x1920 capture must
  // land in the same ~480p budget as landscape (review round 1, finding 8).
  const longestEdge = Math.max(img.naturalWidth || 1, img.naturalHeight || 1);
  const scale = Math.min(1, PREVIEW_MAX_EDGE / longestEdge);
  const width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
  const height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas_unavailable');
  ctx.drawImage(img, 0, 0, width, height);
  const jpeg = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.7),
  );
  // The protocol pins preview frames to image/jpeg — no encoder, no preview.
  if (!jpeg || (jpeg.type !== '' && jpeg.type !== 'image/jpeg')) {
    throw new Error('jpeg_encode_unavailable');
  }
  return { bytes: await readBlobArrayBuffer(jpeg), width, height };
}

/** Adapter screenshot at full resolution, shipped as-is (masking included). */
async function captureShotFull(host: CompanionHost): Promise<StashedShotCapture> {
  const shot = await host.adapter.captureScreenshot();
  const mime: StashedShotCapture['mime'] =
    shot.blob.type === 'image/webp' || shot.blob.type === 'image/jpeg'
      ? shot.blob.type
      : 'image/png';
  return { bytes: await readBlobArrayBuffer(shot.blob), mime, width: shot.width, height: shot.height };
}

/** Canvas crop of a stashed full-res capture. WebP when available, else PNG. */
async function cropShotCapture(
  source: StashedShotCapture,
  rect: { x: number; y: number; w: number; h: number },
): Promise<StashedShotCapture> {
  const w = Math.max(1, rect.w);
  const h = Math.max(1, rect.h);
  const img = await decodeImageBlob(new Blob([source.bytes], { type: source.mime }));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas_unavailable');
  ctx.drawImage(img, rect.x, rect.y, w, h, 0, 0, w, h);
  const webp = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/webp', 0.85),
  );
  const out =
    webp && webp.type === 'image/webp'
      ? webp
      : await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b)));
  if (!out) throw new Error('encode_failed');
  return {
    bytes: await readBlobArrayBuffer(out),
    mime: out.type === 'image/webp' ? 'image/webp' : 'image/png',
    width: w,
    height: h,
  };
}

/**
 * Decode a Blob into an HTMLImageElement, bounded (see reencodeToWebP's
 * rationale). Capture paths keep the default budget; BEST-EFFORT callers
 * (attachment dims, where the fallback is perfectly serviceable) pass a
 * short one so a degraded engine can't stall every submit by the full
 * timeout.
 */
async function decodeImageBlob(blob: Blob, timeoutMs = 1_000): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    return await Promise.race([
      new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('image-decode-failed'));
        el.src = url;
      }),
      new Promise<HTMLImageElement>((_, reject) =>
        setTimeout(() => reject(new Error('image-decode-timeout')), timeoutMs),
      ),
    ]);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Phone tapped Discard (report.cancelled): drop frozen state + stash.
 *
 * `correlationId` scopes the teardown: a DELAYED cancel for a report that
 * already finished must not clear the successor report's session (review
 * round 2, finding 5). Omitted (legacy caller) → unscoped, prior behavior.
 */
export function handleCompanionReportCancelled(
  host: CompanionHost | null,
  correlationId?: string,
): void {
  if (correlationId !== undefined && !__companionShouldSettleOnCancel(correlationId)) {
    return;
  }
  activeRequestCorrelation = null; // aborts a report.request still capturing
  requestStash.clear();
  // An abandoned draft must never leave the device streaming or holding
  // full-res captures (plan Task 9 Step 5) — and a half-received submit's
  // framing must not leak into the next report.
  activePreview?.stopSilently();
  activePreview = null;
  activePreviewCorrelation = null;
  activeShotStash?.stash.clear();
  activeShotStash = null;
  resetSubmitFraming();
  try {
    host?.adapter.__replayLifecycle?.cancel();
  } catch {
    /* swallow */
  }
  try {
    host?.adapter.__getBreadcrumbBuffer?.()?.discardAndResume();
  } catch {
    /* swallow */
  }
}

/**
 * @deprecated Passive no-op kept for back-compat with hosts that wired
 * `onReportSubmit: (msg) => handleReportSubmit(msg)`. The real submit flow is
 * `handleCompanionSubmitText` + `handleCompanionSubmitBinary` (wired by the
 * `companion.start()` singleton). A passive observer can never complete the
 * report — the phone will hang. Migrate to `companion.start()`.
 */
export function handleReportSubmit(_msg: ReportSubmit): Promise<void> {
  return Promise.resolve();
}

function reportCompleted(correlationId: string, eventId: string): ReportCompleted {
  return { type: 'report.completed', correlation_id: correlationId, event_id: eventId };
}

function reportFailed(correlationId: string, reason: string): ReportFailed {
  return { type: 'report.failed', correlation_id: correlationId, reason };
}

/**
 * Wrap `fetch` so the ingest POST `submitReportFromDraft` performs carries
 * the `X-Everframe-Companion-Attribution` header (spec 2026-08-07). Returns the
 * base `fetch` completely unmodified when there's no token — the ordinary
 * (non-companion, or QR-paired) submit path is byte-for-byte what it was
 * before this feature existed.
 *
 * `submitReportFromDraft` → `submitReport` (sdk-core) already sets its own
 * headers (Authorization, X-Everframe-Device-Token, Origin) on the `init` it hands
 * this wrapped fetch; merging via `Headers` here preserves all of them.
 *
 * SECURITY: never log `token`.
 */
function withCompanionAttribution(
  token: string | null,
  base: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  if (!token) return base;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('X-Everframe-Companion-Attribution', token);
    return base(input, { ...init, headers });
  }) as typeof fetch;
}

/** Run a sync capture, swallowing throws (DEFE-02) and returning a fallback. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Sniff the image MIME from the baked bytes (the binary frame carries no type). */
function sniffImageMime(bytes: ArrayBuffer): string {
  const u = new Uint8Array(bytes.slice(0, 12));
  if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return 'image/png';
  if (
    u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46 && // RIFF
    u[8] === 0x57 && u[9] === 0x45 && u[10] === 0x42 && u[11] === 0x50 // WEBP
  ) {
    return 'image/webp';
  }
  if (u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return 'image/jpeg';
  return 'image/png';
}

async function reencodeToWebP(pngBlob: Blob): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;
  const url = URL.createObjectURL(pngBlob);
  try {
    // Race image decode against a short timeout — jsdom and degraded TV
    // WebViews can hang here without firing onload/onerror at all.
    const img = await Promise.race([
      new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('image-decode-failed'));
        el.src = url;
      }),
      new Promise<HTMLImageElement>((_, reject) =>
        setTimeout(() => reject(new Error('image-decode-timeout')), 500),
      ),
    ]);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || 1;
    canvas.height = img.naturalHeight || 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const webp = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/webp', 0.85),
    );
    // toBlob returns null on encoder failure (no WebP support) — caller falls
    // back to the source PNG. Also reject same-or-larger output (rare, but
    // happens for already-small PNGs of solid color) — no point shipping WebP
    // when it didn't actually save bytes.
    if (!webp || webp.size >= pngBlob.size) return null;
    return webp;
  } finally {
    URL.revokeObjectURL(url);
  }
}
