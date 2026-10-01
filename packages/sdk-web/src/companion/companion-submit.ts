// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The phone-driven report submit, loaded LAZILY (chunk companion-submit-*.js)
// by capture-bridge's maybeRunSubmit — it only runs when a paired phone
// submits, so it has no business in the always-loaded bundle. Body moved
// verbatim from capture-bridge.ts, then extended for the smart-TV snapshot
// path (spec 2026-09-29): shots may arrive without an image, and a shot's
// DOM snapshot rides only when the phone's per-shot redaction state is present
// and clean (and the device never re-cropped it).
'use client';
import type { ReportDraft } from '@everframe/sdk-core';
import { MAX_REPORT_SHOTS } from '@everframe/protocol';
import { sha256Hex } from '../capture/sha256.js';
import { snapshotAllowed, strongestShotReason, type ShotRedactionState } from '../capture/shot-capture.js';
import { submitReportFromDraft } from '../transport/submit.js';
import { captureUserSnapshot } from '../internal/user-snapshot.js';
import type { BundleDomSnapshot, BundleScreenshot, CaptureBundle } from '../transport/draft-to-envelope.js';
import type { RelayWSClient, ReportSubmit } from './ws-client.js';
import type { CompanionAPI } from './state.js';
import type { CompanionHost } from './host-seam.js';
import { __companionSeamTicket, __isCompanionKilled, type CompanionSeamTicket } from './host-seam.js';
import type { ShotStashInfo } from './shot-stash.js';
import {
  decodeImageBlob,
  reportCompleted,
  reportFailed,
  safe,
  sniffImageMime,
  type StashedCapture,
} from './bridge-helpers.js';
import { globalScope } from '../internal/global-scope.js';

export interface CompanionSubmitInput {
  msg: ReportSubmit;
  /** The primary's baked bytes — null when `primary_shot.has_image` is false. */
  primaryBytes: ArrayBuffer | null;
  shotParts: Map<string, ArrayBuffer>;
  ws: RelayWSClient;
  host: CompanionHost | null;
  companion: CompanionAPI;
  /** The report.request capture for this correlation, if it is still stashed. */
  stashed: StashedCapture | null;
  /** The shot stash's view of an extra shot (snapshot, reason, re-crop flag). */
  extraShot: (shotId: string) => ShotStashInfo | undefined;
  /** End-of-report teardown — runs exactly once, whatever the outcome. */
  onSettled: (correlationId: string, companion: CompanionAPI) => void;
  /**
   * The seam ticket taken when the final submit frame arrived, BEFORE this
   * chunk was imported (codex r7 F2). Every ownership check uses it; absent
   * (a direct caller), one is taken on entry.
   */
  ticket?: CompanionSeamTicket;
}

type WireRedaction = { cropped: boolean; blurred: boolean; area_selected: boolean } | undefined;

/** The phone's per-shot state, with a blur annotation counting as blurred whatever the flag says. */
function redactionOf(
  r: WireRedaction,
  annotations: ReadonlyArray<{ kind: string }> | undefined,
): ShotRedactionState | undefined {
  if (r === undefined) return undefined;
  return {
    cropped: r.cropped,
    blurred: r.blurred || (annotations ?? []).some((a) => a.kind === 'blur'),
    areaSelected: r.area_selected,
  };
}

export async function runCompanionSubmit(input: CompanionSubmitInput): Promise<void> {
  const { msg, primaryBytes: bakedBytes, shotParts, ws, host, companion } = input;
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
    const ticket = input.ticket ?? __companionSeamTicket(host);
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

    const stashed = input.stashed;

    // includes → excludedArtifacts (inverse). `metadata` is always carried via
    // the envelope's `device` block, so it has no excludedArtifacts token.
    // `includes.screenshot: false` is the user switching the screenshot
    // artifact off (an image-less primary is NOT that — it is expressed by
    // `primary_shot.has_image`), and maps to the `screenshot` exclusion.
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

    let screenshotBlob: Blob | null = null;
    let screenshotSha256: string | null = null;
    let primaryDims = { w: 0, h: 0 };
    if (bakedBytes !== null) {
      screenshotBlob = new Blob([bakedBytes], { type: sniffImageMime(bakedBytes) });
      screenshotSha256 = await sha256Hex(screenshotBlob);
      // The envelope must advertise the BAKED image's dimensions — the phone
      // may have cropped the primary before submit, so request-time
      // full-screen dims can be wrong (review round 3, finding 4). Decode
      // with the stashed dims as the degraded fallback (DEFE-02).
      primaryDims = await decodeImageBlob(screenshotBlob, 300)
        .then((img) => ({ w: img.naturalWidth, h: img.naturalHeight }))
        .catch(() => ({ w: stashed?.screenshotWidth ?? 0, h: stashed?.screenshotHeight ?? 0 }));
    }

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

    // Smart-TV snapshot path: which shots' DOM snapshots may ride, and the
    // report's degraded reason from the RETAINED shots (spec §Capture
    // contract). An excluded screenshot artifact retains no shot at all, so
    // it contributes neither a snapshot nor a shot reason.
    const includesShots = msg.includes.screenshot !== false;
    const primary = stashed?.primary ?? null;
    const domSnapshots: BundleDomSnapshot[] = [];
    const reasons: Array<string | undefined> = [];
    if (includesShots) {
      reasons.push(primary?.degradedReason);
      if (
        primary?.snapshot !== undefined &&
        snapshotAllowed(redactionOf(msg.primary_shot?.redaction, msg.annotations))
      ) {
        domSnapshots.push({ shotNumber: 1, bytes: primary.snapshot.bytes, sha256: primary.snapshot.sha256 });
      }
    }

    // Multi-shot (spec 2026-07-17 §3): each extra baked image arrived bound
    // by its `shot.binary` marker; ship primary + extras via the bundle's
    // multi-screenshot payload. Absent shots[] keeps the legacy single-shot
    // fields byte-identical to pre-multi-shot behavior.
    //
    // Shot numbers are POSITIONS (primary = 1, extras = 2..N in `shots[]`
    // order), carried on every image and snapshot alike, so an image-less
    // shot never shifts its neighbours' part names. The relay caps `shots[]`
    // at 3; the slice keeps the report inside MAX_REPORT_SHOTS regardless.
    const submitShots = (msg.shots ?? []).slice(0, MAX_REPORT_SHOTS - 1);
    if (submitShots.length > 0) {
      const images: BundleScreenshot[] = [];
      if (screenshotBlob !== null && screenshotSha256 !== null) {
        images.push({
          blob: screenshotBlob,
          sha256: screenshotSha256,
          width: primaryDims.w,
          height: primaryDims.h,
          annotated: msg.annotations.length > 0,
          shotNumber: 1,
        });
      }
      for (let k = 0; k < submitShots.length; k++) {
        const s = submitShots[k]!;
        const shotNumber = k + 2;
        if (includesShots) {
          const info = input.extraShot(s.shot_id);
          reasons.push(info?.degradedReason);
          // A device-side re-crop is an area selection whatever the phone's
          // flags say — the snapshot would restore what was cropped away.
          if (
            info?.snapshot !== undefined &&
            !info.recropped &&
            snapshotAllowed(redactionOf(s.redaction, s.annotations))
          ) {
            domSnapshots.push({ shotNumber, bytes: info.snapshot.bytes, sha256: info.snapshot.sha256 });
          }
        }
        if (s.has_image === false) continue;
        const bytes = shotParts.get(s.shot_id);
        if (bytes === undefined) continue; // submitComplete() guards; defensive
        const blob = new Blob([bytes], { type: sniffImageMime(bytes) });
        // Baked dims aren't echoed by the phone — decode for the envelope,
        // degrading to 0x0 rather than failing the report (DEFE-02).
        const dims = await decodeImageBlob(blob, 300)
          .then((img) => ({ w: img.naturalWidth, h: img.naturalHeight }))
          .catch(() => ({ w: 0, h: 0 }));
        images.push({
          blob,
          sha256: await sha256Hex(blob),
          width: dims.w,
          height: dims.h,
          annotated: (s.annotations?.length ?? 0) > 0,
          shotNumber,
        });
      }
      if (images.length > 0) bundle.screenshots = images;
    }
    if (domSnapshots.length > 0) bundle.domSnapshots = domSnapshots;
    if (includesShots && primary?.render !== undefined) bundle.render = primary.render;
    const reason = strongestShotReason(reasons);
    if (reason !== undefined) bundle.degradedReason = reason;

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
    input.onSettled(msg.correlation_id, companion);
  }
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
  base: typeof fetch = globalScope().fetch.bind(globalScope()),
): typeof fetch {
  if (!token) return base;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('X-Everframe-Companion-Attribution', token);
    return base(input, { ...init, headers });
  }) as typeof fetch;
}
