// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture (web TVs): the headless capture a gesture files.
// Lazy chunk only.
//
// Order: gate → attribution → synchronous freeze of replay, breadcrumbs and
// network bodies → a fresh shot plus logs, network, metadata and focus →
// fence (kill / teardown unwinds) → optimistic toast → take the frozen
// evidence → transport fence (a link that changed is never sent under another
// identity, and never falls back to shared) → upload as a draft.
//
// A capture never touches a freeze the in-app reporter holds. DEFE-02:
// nothing throws into the host. Tokens and nonces are never logged.
import type { ReportDraft } from '@everframe/sdk-core';
import { captureShotVia, type ShotCapture } from '../capture/shot-capture.js';
import { sha256HexOfBytes } from '../capture/sha256.js';
import { newLinkNonce } from '../devicelink/token.js';
import { DEGRADED_REASONS } from '../internal/degraded-reasons.js';
import { captureUserSnapshot } from '../internal/user-snapshot.js';
import type { CaptureBundle } from '../transport/draft-to-envelope.js';
import type { QuickCaptureUploadLink } from '../transport/device-link-upload.js';
import { submitReportFromDraft, type SubmitOutcome } from '../transport/submit.js';
import { COPY } from './copy.js';
import type { DeviceLinkController, LinkSnapshot } from './device-link.js';
import type { QuickCaptureHost } from './host.js';
import type { Overlay } from './overlay.js';

export type QuickCaptureOutcome =
  | 'submitted'
  | 'queued'
  | 'rejected'
  | 'unlinked'
  | 'failed'
  | 'ignored';

export interface QuickCapture {
  capture(): Promise<QuickCaptureOutcome>;
  readonly inFlight: boolean;
}

export const CAPTURE_COOLDOWN_MS = 2_000;

export interface QuickCaptureDeps {
  host: QuickCaptureHost;
  link: DeviceLinkController;
  overlay: Overlay;
  /** For `Captured · {device model}` on an unlinked debug TV. */
  deviceModel(): string;
  debugBuild: boolean;
  /** False once the runtime that owns this pipeline was torn down. */
  isCurrent(): boolean;
  now(): number;
  beginAttempt(attemptId: string, number: number, nonce: string): void;
  /** Test seams. */
  submit?: typeof submitReportFromDraft;
  captureShot?: (adapter: QuickCaptureHost['adapter']) => Promise<ShotCapture>;
  nonce?: () => string | null;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function guard(fn: () => void): void {
  try {
    fn();
  } catch {
    /* DEFE-02 */
  }
}

export function createQuickCapture(deps: QuickCaptureDeps): QuickCapture {
  const { host, link, overlay } = deps;
  const submit = deps.submit ?? submitReportFromDraft;
  const shoot = deps.captureShot ?? ((adapter) => captureShotVia(adapter));
  const nonceOf = deps.nonce ?? (() => newLinkNonce());
  let inFlight = false;
  let lastCaptureAt: number | null = null;

  function isKilled(): boolean {
    return safe(() => host.isKilled(), true);
  }

  /** Bumped by every reporter open path; see `__reporterOpenSeq`. */
  function reporterOpenSeq(): number {
    const read = (host.adapter as { __reporterOpenSeq?: () => number }).__reporterOpenSeq;
    return safe(() => (read ? read() : 0), 0);
  }

  /** Resume live capture after a capture that will not be sent. */
  function unwind(): void {
    const adapter = host.adapter;
    guard(() => adapter.__replayLifecycle?.cancel());
    guard(() => adapter.__getBreadcrumbBuffer?.()?.discardAndResume());
    guard(() => adapter.__getNetworkBodiesBuffer?.()?.discardAndResume());
  }

  async function run(): Promise<QuickCaptureOutcome> {
    const adapter = host.adapter;

    // 1. Gate. Nothing is touched yet, so an ignored gesture leaves no trace.
    if (inFlight || isKilled()) return 'ignored';
    const startedAt = deps.now();
    if (lastCaptureAt !== null && startedAt - lastCaptureAt < CAPTURE_COOLDOWN_MS) return 'ignored';
    const lifecycle = adapter.__replayLifecycle;
    if (safe(() => lifecycle?.state === 'FROZEN', true)) return 'ignored';
    const reporterOpen = (adapter as { __isReporterOpen?: () => boolean }).__isReporterOpen;
    if (safe(() => reporterOpen?.() === true, true)) return 'ignored';

    // 2. Attribution, fixed for the whole capture.
    const snap: LinkSnapshot | null = link.snapshot();
    let deviceLink: QuickCaptureUploadLink | undefined;
    if (snap) {
      deviceLink = { token: snap.token, fingerprint: snap.fingerprint, nonce: nonceOf() };
    } else if (!deps.debugBuild) {
      return 'ignored';
    }
    const owner = snap ? snap.owner : null;

    inFlight = true;
    lastCaptureAt = startedAt;
    let frozen = false;
    let toasted = false;
    try {
      // The submit boundary: who the capture belongs to is read now.
      const user = captureUserSnapshot(() => host.getUser());
      const extra = safe(() => host.getExtra(), undefined);
      const identity: Promise<string | null> = Promise.resolve()
        .then(() => adapter.__captureIdentityAtSubmitBoundary())
        .catch(() => null);

      // 3. Synchronous freeze, before any await. The freeze-to-consume
      // interval has one owner: if the reporter opens before the capture
      // consumes (its idempotent freeze() reuses these buffers), the capture
      // hands everything over and consumes nothing.
      const openSeq = reporterOpenSeq();
      const reporterOpened = (): boolean => reporterOpenSeq() !== openSeq;
      frozen = true;
      guard(() => lifecycle?.freeze());
      guard(() => adapter.__getBreadcrumbBuffer?.()?.freeze());
      guard(() => adapter.__getNetworkBodiesBuffer?.()?.freeze());

      // 4. A fresh shot (never the reporter's pre-capture), then the rest.
      const shot = await shoot(adapter).catch((): ShotCapture | null => null);
      const logs = safe(() => adapter.captureRecentLogs(), []);
      const network = safe(() => adapter.captureRecentNetwork(), []);
      const metadata = safe(() => adapter.getDeviceMetadata(), null);
      const focused = safe(() => adapter.captureFocusedNode(), null);

      // 5. Fence: killed or torn down while the shot was taken.
      if (!deps.isCurrent() || isKilled()) {
        frozen = false;
        unwind();
        return 'failed';
      }
      // The reporter opened while the shot was taken: the frozen replay,
      // breadcrumbs and bodies are its now. No unwind, no toast, no upload.
      if (reporterOpened()) {
        frozen = false;
        return 'ignored';
      }

      // 6. Optimistic toast.
      const text = COPY.captured(owner, deps.deviceModel());
      toasted = true;
      guard(() => overlay.toast(text));

      // 7. Take the frozen evidence.
      const bundle: CaptureBundle = {
        screenshotBlob: shot?.image?.blob ?? null,
        screenshotSha256: shot?.image?.sha256 ?? null,
        screenshotWidth: shot?.image?.width ?? 0,
        screenshotHeight: shot?.image?.height ?? 0,
        focused,
        logs,
        network,
        metadata,
      };
      if (shot?.snapshot !== undefined) {
        bundle.domSnapshots = [
          { shotNumber: 1, bytes: shot.snapshot.bytes, sha256: shot.snapshot.sha256 },
        ];
      }
      if (shot?.render !== undefined) bundle.render = shot.render;
      const reason = shot === null ? DEGRADED_REASONS.screenshot_failed : shot.degradedReason;
      if (reason !== undefined) bundle.degradedReason = reason;
      frozen = false;
      // Breadcrumbs and bodies are taken synchronously, before the replay
      // export's await, so a reporter that opens during the export freezes
      // fresh ones of its own.
      guard(() => {
        const crumbs = adapter.__getBreadcrumbBuffer?.()?.takeFrozen();
        if (crumbs && crumbs.length > 0) {
          bundle.breadcrumbs = crumbs;
          bundle.breadcrumbTrim = adapter.__breadcrumbTrimOptions();
        }
      });
      guard(() => {
        const bodies = adapter.__getNetworkBodiesBuffer?.()?.takeFrozen();
        if (bodies && bodies.length > 0) bundle.networkBodies = bodies;
      });
      let capture: Awaited<ReturnType<NonNullable<typeof lifecycle>['complete']>> = null;
      try {
        capture = lifecycle ? await lifecycle.complete() : null;
      } catch {
        // A failed export leaves the lifecycle FROZEN, which would shut out
        // every later gesture (and the reporter): unwind the freeze and file
        // the capture without a replay.
        guard(() => lifecycle?.cancel());
        capture = null;
      }
      // A reporter that opened during the export found the replay still
      // frozen (its freeze() was a no-op) and complete() then resumed the
      // buffer: freeze it again so the reporter holds a frozen window.
      if (reporterOpened()) guard(() => lifecycle?.freeze());
      try {
        if (capture && capture.bytes.byteLength > 0) {
          bundle.replaySha256 = await sha256HexOfBytes(capture.bytes);
          bundle.replayCapture = capture;
        }
      } catch {
        /* a replay failure never costs the capture */
      }
      const capturedIdentityToken = await identity;

      // 8. Transport fence. A linked capture goes only under the token it was
      // taken with; it never falls back to a shared upload.
      const stillLinked = snap === null || link.snapshot()?.token === snap.token;
      if (isKilled() || !deps.isCurrent() || !stillLinked) {
        guard(() => overlay.toast(COPY.CAPTURE_REJECTED));
        return 'rejected';
      }

      // 9. Upload as a draft.
      const draft: ReportDraft = {
        title: '',
        description: '',
        excludedArtifacts: [],
        annotations: [],
        redactions: [],
        ...(extra ? { extra } : {}),
      };
      const outcome: SubmitOutcome = await submit({
        config: host.config,
        sdkName: host.sdkName,
        sdkVersion: host.sdkVersion,
        draft,
        bundle,
        outbox: adapter.outbox,
        identityToken: adapter.__identityTokenReader,
        capturedIdentityToken,
        user,
        quickCapture: true,
        ...(deviceLink ? { deviceLink } : {}),
        // Checked before every request and before queueing.
        isOwned: () => deps.isCurrent() && !isKilled(),
      });

      // Killed or torn down during the upload: nothing was sent after that,
      // nothing was queued, and nothing more is shown.
      if (outcome.abandoned) return 'failed';

      if (outcome.ok) {
        const lp = outcome.linkPending;
        // A takeover reply belongs to the link the upload carried: dropped if
        // the runtime went away or the link changed (another takeover, a
        // forget) while the upload was in flight.
        const sameLink = snap !== null && link.snapshot()?.token === snap.token;
        if (lp && deviceLink?.nonce && sameLink && deps.isCurrent() && !isKilled()) {
          deps.beginAttempt(lp.attemptId, lp.number, deviceLink.nonce);
        }
        return 'submitted';
      }
      if (outcome.deviceUnlinked && snap) {
        if (link.forget(snap.token)) return 'unlinked';
        guard(() => overlay.toast(COPY.CAPTURE_REJECTED));
        return 'rejected';
      }
      if (outcome.retryable && !outcome.notQueued && adapter.outbox) return 'queued';
      guard(() => overlay.toast(COPY.CAPTURE_REJECTED));
      return 'rejected';
    } catch {
      if (frozen) unwind();
      guard(() => overlay.toast(toasted ? COPY.CAPTURE_REJECTED : COPY.CAPTURE_FAILED));
      return toasted ? 'rejected' : 'failed';
    } finally {
      inFlight = false;
    }
  }

  return {
    async capture(): Promise<QuickCaptureOutcome> {
      try {
        return await run();
      } catch {
        return 'failed';
      }
    },
    get inFlight(): boolean {
      return inFlight;
    },
  };
}
