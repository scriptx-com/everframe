// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// TV-side capture + submit bridge for phone-driven reports. Composes the
// existing `captureScreenshot` + adapter capture primitives + the standard
// ingest `submitReportFromDraft` path — REUSED, no Tizen/WebOS branching.
// The submit itself (envelope assembly + ingest) lives in the lazily loaded
// companion-submit.ts; this module keeps the framing and the capture side.
//
// Wire protocol (D-05):
//   report.request →
//     1. text  : `report.assembled` { mime, size, toggles, counts }
//     2. binary: screenshot bytes (WebP @ 0.85 when re-encoding succeeds, else PNG)
//     — or, with no image (smart-TV snapshot path), ONE image-less
//     `report.assembled` { outcome: snapshot|unavailable, size: 0 } and no
//     binary; with that path off, ONE `report.failed`. Never silence.
//   report.submit →
//     1. text  : `report.submit` { title, description, annotations, includes }
//     2. binary: baked (annotated) screenshot bytes — absent when
//        `primary_shot.has_image` is false
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
import { captureScreenshot } from '../capture/screenshot.js';
import { getCaptureProfile } from '../capture/capture-profile.js';
import { relay } from '@everframe/protocol';
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
import { decodeImageBlob, reportFailed, safe, type StashedCapture } from './bridge-helpers.js';
import { captureShotVia, type ShotCapture } from '../capture/shot-capture.js';
import { DEGRADED_REASONS } from '../internal/degraded-reasons.js';

type ReportAssembled = z.infer<typeof relay.ReportAssembled>;

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
// The report.request capture, stashed by correlation_id (see StashedCapture).
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

/** Does this submit announce a primary binary? Absent primary_shot = legacy phone = yes. */
function expectsPrimaryBinary(msg: ReportSubmit): boolean {
  return msg.primary_shot?.has_image !== false;
}

/** Extra shots whose baked image will follow (absent has_image = legacy = yes). */
function announcedImageShots(msg: ReportSubmit): string[] {
  return (msg.shots ?? []).filter((s) => s.has_image !== false).map((s) => s.shot_id);
}

/** Every DECLARED frame of the submit present — the device waits only for binaries that will come. */
function submitComplete(): boolean {
  if (pendingSubmitMsg === null) return false;
  if (expectsPrimaryBinary(pendingSubmitMsg) && pendingBakedBytes === null) return false;
  return announcedImageShots(pendingSubmitMsg).every((id) => pendingShotParts.has(id));
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
  // A new report.request starts a new report: whatever submit framing is
  // still half-received belongs to an abandoned one, and a stray binary left
  // in it must not pair with THIS report's submit (ruling S25b).
  resetSubmitFraming();
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

  // Always a FRESH shot: no `consumePreCapture`. The TV pre-capture belongs to
  // the in-app dialog open that took it — handing it to the phone would ship
  // a screen from an earlier (possibly cancelled) open.
  const shot = await captureShotVia(adapter).catch((): ShotCapture | null => null);
  // Codex round-3 finding 4 (P1) — re-checked AFTER the capture await. The
  // entry gate above (and the seam gate that now precedes it) both ran before
  // a screenshot that takes seconds on TV silicon; a `kill()` landing inside
  // that window still stashed the bundle and shipped the pixels to the phone.
  //
  // ANSWERED, not dropped: going silent here would strand the phone in
  // "capturing…" until its correlation timed out. The adapter's captures
  // reject once killed, so in practice `shot` is already null on
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

  // Every capture request gets EXACTLY ONE completion (spec §Capture
  // contract) — including when something below throws unexpectedly (the
  // breadcrumb inventory, the image read, the re-encode). `answered` flips the
  // moment a frame is handed to the socket, so a throw AFTER the first frame
  // (e.g. the binary send) adds nothing, and one before it is answered with
  // the reason an image-less capture uses (ruling S25a).
  let answered = false;
  const reply: RelaySender = {
    send: (m) => {
      answered = true;
      ws.send(m);
    },
    sendBinary: (b) => ws.sendBinary(b),
  };
  try {
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
      screenshotWidth: shot?.image?.width ?? 0,
      screenshotHeight: shot?.image?.height ?? 0,
      primary: shot,
    });

    const counts: ReportCounts = {
      logs: logs.length,
      network: network.length,
      // Tap-to-identify is gone: no tree is captured, so the count is always 0.
      // The field stays REQUIRED in the relay schema so a legacy phone parses it.
      uiTreeNodes: 0,
      breadcrumbs: host.adapter.__getBreadcrumbBuffer?.()?.size ?? 0,
    };
    // The snapshot path's additive frame fields go out only while it is on:
    // with it off, every frame stays byte-identical to what old relays and
    // phones already parse (ruling S25c).
    const tvPathActive = safe(() => host.adapter.__tvSnapshotPathActive?.() === true, false);
    if (shot?.image !== undefined) {
      await shipCapture(correlationId, reply, shot.image, ticket, counts, tvPathActive ? { degradedReason: shot.degradedReason } : undefined);
      return;
    }
    // This used to `return` silently, stranding the phone in "capturing…"
    // until its correlation timed out.
    shipImageless(correlationId, reply, ticket, counts, shot, tvPathActive);
  } catch {
    if (!answered) ws.send(reportFailed(correlationId, DEGRADED_REASONS.screenshot_unavailable));
  }
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
  ws: RelaySender,
  screenshotResult: ScreenshotResult,
  /** The seam identity its caller began under — see `handleCompanionReportRequest`. */
  ticket: CompanionSeamTicket | undefined,
  counts: ReportCounts,
  /**
   * Set only while the TV snapshot path is active. The frame then carries
   * `outcome: 'image'` — the phone's capability signal that this TV takes the
   * new submit shape (and so can attach the stashed DOM snapshot) — plus the
   * shot's degraded reason (e.g. screenshot_blank). Absent, the frame stays
   * byte-identical to the legacy shape (ruling S25c).
   */
  snapshotPath?: { degradedReason?: string | undefined },
): Promise<void> {
  // Codex round-3 finding 4 (P1) — THE pixel-emit choke point for both
  // `report.request` paths. Each of them awaits a capture before reaching
  // here, so this is the last statement before the user's screen goes over
  // the relay; the callers' own gates cannot cover the window their awaits
  // open. Answered, not silent: no frame for this correlation has gone out
  // yet on any path that reaches here (a caller that answered its own kill
  // check returned instead of calling this), and silence would strand the
  // phone in "capturing…" — the exactly-one-completion rule.
  if (__isCompanionKilled(ticket)) {
    ws.send(reportFailed(correlationId, 'submit_unavailable'));
    return;
  }
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
  // Re-checked AFTER the encode/read awaits (ruling S25a): a `kill()` landing
  // inside them must not let these bytes reach the relay.
  if (__isCompanionKilled(ticket)) {
    ws.send(reportFailed(correlationId, 'submit_unavailable'));
    return;
  }

  const assembled: ReportAssembled = {
    type: 'report.assembled',
    correlation_id: correlationId,
    mime: screenshotMime,
    size: screenshotBuf.byteLength,
    toggles: IMAGE_TOGGLES,
    counts: countsFrame(counts),
    ...(snapshotPath !== undefined ? { outcome: 'image' as const } : {}),
    ...(snapshotPath?.degradedReason !== undefined ? { degraded_reason: snapshotPath.degradedReason } : {}),
  };

  ws.send(assembled);
  ws.sendBinary(screenshotBuf);
}

// No UI tree is captured on any producer any more — both natives send `false`
// here too. The field stays REQUIRED in the relay schema so a legacy phone
// still parses the frame, but it must report the truth: a `true` here would
// have the phone echo it back in `includes`, and an artifact that cannot exist
// has no business claiming it was on.
const IMAGE_TOGGLES = { logs: true, network: true, uiTree: false, metadata: true, screenshot: true } as const;

function countsFrame(counts: ReportCounts): ReportAssembled['counts'] {
  return {
    logs: counts.logs,
    network: counts.network,
    uiTreeNodes: counts.uiTreeNodes,
    ...(counts.breadcrumbs !== undefined ? { breadcrumbs: counts.breadcrumbs } : {}),
  };
}

/**
 * The image-less completions. Sent only when the server path is on: the relay
 * validates every frame with the pinned protocol and 4006-closes on a shape it
 * does not know, and `screenshotRender` is only switched on once the relay
 * knows these shapes (rollout ruling). With it off, the phone gets the one
 * completion every old relay and phone understand: report.failed.
 */
function shipImageless(
  correlationId: string,
  ws: RelaySender,
  ticket: CompanionSeamTicket | undefined,
  counts: ReportCounts,
  shot: ShotCapture | null,
  imagelessSupported: boolean,
): void {
  // Same rule as shipCapture's gate: nothing has been sent for this
  // correlation yet, so a kill is answered rather than left silent.
  if (__isCompanionKilled(ticket)) {
    ws.send(reportFailed(correlationId, 'submit_unavailable'));
    return;
  }
  if (!imagelessSupported) {
    ws.send(reportFailed(correlationId, DEGRADED_REASONS.screenshot_unavailable));
    return;
  }
  const reason = shot?.degradedReason ?? DEGRADED_REASONS.screenshot_unavailable;
  const snapshot = shot?.snapshot;
  const assembled: ReportAssembled = {
    type: 'report.assembled',
    correlation_id: correlationId,
    mime: 'image/webp', // required by the schema; meaningless without bytes
    size: 0,
    toggles: IMAGE_TOGGLES,
    counts: countsFrame(counts),
    ...(snapshot !== undefined
      ? { outcome: 'snapshot' as const, degraded_reason: reason, snapshot: { byte_length: snapshot.byteLength, sha256: snapshot.sha256 } }
      : { outcome: 'unavailable' as const, degraded_reason: DEGRADED_REASONS.screenshot_unavailable }),
  };
  ws.send(assembled);
}

/**
 * Handle a `report.submit` text frame. Stash it and try to pair with the
 * baked-screenshot binary (which arrives immediately after). `host` may be
 * null (no Provider mounted) — `runCompanionSubmit` (companion-submit.ts) then replies
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
  const pending: ReportSubmit | null = pendingSubmitMsg;
  if (pending === null || pending.correlation_id !== msg.correlation_id) return;
  // Only a shot whose baked image was announced: a has_image:false shot has
  // no binary coming, so a marker for it must not claim the next frame.
  if (!announcedImageShots(pending).includes(msg.shot_id)) return;
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

/** Launch the submit once every DECLARED frame of it has arrived. */
function maybeRunSubmit(
  ws: RelayWSClient,
  host: CompanionHost | null,
  companion: CompanionAPI,
): void {
  if (!submitComplete()) return;
  const msg = pendingSubmitMsg!;
  // An image-less primary (primary_shot.has_image === false) has no binary.
  const primaryBytes = expectsPrimaryBinary(msg) ? pendingBakedBytes : null;
  const shotParts = new Map(pendingShotParts);
  resetSubmitFraming();
  const stashed = requestStash.get(msg.correlation_id) ?? null;
  const stash = activeShotStash?.correlationId === msg.correlation_id ? activeShotStash.stash : null;
  // Lazy chunk (companion-submit-*.js): the submit body is not always-loaded
  // weight. The two-argument `then` keeps the load-failure answer apart from
  // the submit itself, which answers the phone on every path of its own — a
  // `.catch` here would answer a second time if it ever rejected.
  void import('./companion-submit.js').then(
    (m) =>
      m.runCompanionSubmit({
        msg,
        primaryBytes,
        shotParts,
        ws,
        host,
        companion,
        stashed,
        extraShot: (shotId) => stash?.info(shotId),
        onSettled: settleCompanionSubmit,
      }),
    () => {
      // The chunk itself failed to load — still answer the phone exactly once.
      ws.send(reportFailed(msg.correlation_id, 'ingest_error'));
      settleCompanionSubmit(msg.correlation_id, companion);
    },
  );
}

/** End-of-report teardown shared by every submit outcome (was runCompanionSubmit's finally). */
export function settleCompanionSubmit(correlationId: string, companion: CompanionAPI): void {
  requestStash.delete(correlationId);
  if (activeRequestCorrelation === correlationId) activeRequestCorrelation = null;
  // The report is over either way — a lingering preview loop or a stash of
  // full-res captures must not outlive it (round 1, finding 6). Scoped to
  // THIS report's correlation: a slow ingest for c1 settling after the
  // phone re-bonded and opened c2 must not tear down c2's session
  // (round 2, finding 4).
  if (activePreviewCorrelation === correlationId) {
    activePreview?.stopSilently();
    activePreview = null;
    activePreviewCorrelation = null;
  }
  if (activeShotStash?.correlationId === correlationId) {
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

/**
 * A full-res shot for the stash, shipped as-is (masking included). Always
 * fresh — never the dialog's pre-capture. No image (TV path render failed /
 * unavailable) → shot.failed with the degraded reason.
 */
async function captureShotFull(host: CompanionHost): Promise<StashedShotCapture> {
  const shot = await captureShotVia(host.adapter);
  if (shot.image === undefined) throw new Error(shot.degradedReason ?? DEGRADED_REASONS.screenshot_unavailable);
  const image = shot.image;
  const mime: StashedShotCapture['mime'] =
    image.blob.type === 'image/webp' || image.blob.type === 'image/jpeg' ? image.blob.type : 'image/png';
  return {
    bytes: await readBlobArrayBuffer(image.blob),
    mime,
    width: image.width,
    height: image.height,
    ...(shot.snapshot !== undefined ? { snapshot: shot.snapshot } : {}),
    ...(shot.degradedReason !== undefined ? { degradedReason: shot.degradedReason } : {}),
  };
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
