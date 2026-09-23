// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
} from 'react';
import type { FocusedNode } from '@everframe/protocol';
import type {
  LogEntry,
  NetworkEntry,
  DeviceMetadata,
  ReportDraft,
  Rect,
  ScreenshotResult,
  UserMetadata,
} from '@everframe/sdk-core';
import { Modal } from './primitives/Modal.js';
import { Button } from './primitives/Button.js';
import { TextInput } from './primitives/TextInput.js';
import { Textarea } from './primitives/Textarea.js';
import { NoticeStrip } from './primitives/NoticeStrip.js';
import { type Annotation } from './AnnotateCanvas.js';
import { AnnotateScreenshot } from './AnnotateScreenshot.js';
import { bakeAnnotations } from './BlurBakery.js';
import { DiscardConfirmModal } from './DiscardConfirmModal.js';
import { ScreenshotStrip } from './ScreenshotStrip.js';
import { AreaCaptureOverlay } from './AreaCaptureOverlay.js';
import { cropBlob } from './crop-blob.js';
import { Watermark } from './Watermark.js';
import { sha256Hex } from '../capture/sha256.js';
import {
  __getBrandingServerConfig,
  __subscribeBrandingServerConfig,
} from '../branding/server-config.js';
import type { WebPlatformAdapter } from '../adapter.js';
import type { CaptureBundle, BundleScreenshot } from '../transport/draft-to-envelope.js';

/**
 * Ratio the capture ACTUALLY ran at, derived from the shot itself: captures
 * are viewport-anchored and viewport-sized, so shotWidth / innerWidth is the
 * scale that maps CSS-px selections/annotations onto image pixels.
 * `window.devicePixelRatio` is only an upper bound — capture-profile.ts caps
 * the render ratio (TV 1080p, desktop 2560), and using the uncapped DPR
 * cropped the wrong region (codex round-2 finding 2). Falls back for the
 * degraded 1x1 placeholder and non-window environments.
 */
function effectiveCaptureRatio(shotWidth: number, fallback?: number): number {
  const fb =
    fallback ??
    (typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);
  if (typeof window === 'undefined' || !window.innerWidth || shotWidth <= 1) return fb;
  return shotWidth / window.innerWidth;
}

export interface ReporterCompletePayload extends ReportDraft {
  /** Final screenshot blob (post-blur-bake) — Plan 07 envelope-builder consumes this. */
  screenshotBlob: Blob | null;
  /**
   * Capture bundle gathered at modal-open time. Plan 07 — the Provider's onComplete
   * handler builds the envelope from this bundle + draft and submits via sdk-core
   * transport. The screenshotBlob/screenshotSha256 fields reflect the FINAL post-blur-bake
   * state, NOT the original captured screenshot (Pitfall 8 PRIV-03 lock).
   */
  bundle: CaptureBundle;
  /**
   * PR review, round 5 (Serious) — the identity captured at the TRUE submit
   * boundary: the top of `onSubmit` below, before `bakeAnnotations` /
   * `sha256Hex` for any annotated screenshot (`createImageBitmap` + a
   * full-resolution canvas draw + PNG re-encode — see `BlurBakery.ts`) has a
   * chance to run. That bake can cost hundreds of milliseconds to seconds on
   * the most common reporter flow (any blur/arrow/stroke), and round 4's
   * capture — in provider.tsx's `onComplete`, called only once THIS dialog
   * hands it a finished draft — was one hop too late to see it. `undefined`
   * (vs. `null`, "captured, nothing was live") means this dialog never
   * captured at all; `onComplete` falls back to capturing on its own in that
   * case, for any caller that reaches it by another route.
   */
  capturedIdentityToken?: string | null;
  /**
   * External review, finding 1 (Serious) — the self-declared user (`setUser`)
   * captured at the SAME true submit boundary as `capturedIdentityToken`
   * above, and for the same reason: the bake/hash prep between the Send click
   * and the envelope build can span seconds, and a host that switches accounts
   * during it must not have account B's label attached to account A's report.
   *
   * Same `undefined` vs `null` distinction as the token: `undefined` means
   * this dialog never captured (a caller reaching `onComplete` by another
   * route), so the Provider falls back to capturing itself; `null` means
   * "captured, and nobody was signed in" and is used as-is.
   */
  capturedUser?: UserMetadata | null;
}

/**
 * Ceiling on how long the dialog will keep focus out on the host page while
 * the opening screenshot is taken. See the effect that uses it.
 */
const FOCUS_HOLD_CEILING_MS = 5_000;

export interface ReporterDialogProps {
  open: boolean;
  adapter: WebPlatformAdapter;
  onComplete: (draft: ReporterCompletePayload) => void;
  onCancel: () => void;
}

// Character caps shared with the Zod protocol schema and the other reporter
// UI surfaces (phone-companion SPA, iOS native, Android native). Single source
// of truth for the web modal — duplicated as raw numbers at the leaf input
// `maxLength` attributes below.
//
//   TITLE       200
//   DESCRIPTION 400

/** Local capture state held by the dialog (distinct from CaptureBundle which is the
 * envelope-builder-facing shape — the dialog folds this into a CaptureBundle on submit
 * after applying blur baking + row-level redactions). */
interface DialogCaptureState {
  screenshot: ScreenshotResult | null;
  logs: LogEntry[];
  network: NetworkEntry[];
  metadata: DeviceMetadata | null;
  focused: FocusedNode | null;
  degradedReason: string | undefined;
}

/** Per-shot capture state Tasks 7/9 build on — one entry per screenshot in the strip. */
interface ReportScreenshot {
  id: string;
  blob: Blob;
  sha256: string;
  width: number;
  height: number;
  pixelRatio: number;
  annotations: Annotation[];
  source: 'auto' | 'manual';
}

/**
 * ReporterDialog — orchestrates capture (parallel-fan-out via the adapter at open-time),
 * draft state, optional blur bake (PRIV-03 / ANN-02 lock), and discard-confirm flow.
 * Resolves onComplete with the final draft + post-bake screenshot blob; Plan 07 wires
 * envelope build + submitReport at the Provider seam.
 */
export function ReporterDialog({
  open,
  adapter,
  onComplete,
  onCancel,
}: ReporterDialogProps): JSX.Element | null {
  const [bundle, setBundle] = useState<DialogCaptureState | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [titleError, setTitleError] = useState<string | undefined>(undefined);
  const [screenshots, setScreenshots] = useState<ReportScreenshot[]>([]);
  const [activeShotId, setActiveShotId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [redactedLogs, setRedactedLogs] = useState<Set<number>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [showDiscard, setShowDiscard] = useState(false);
  const [addStage, setAddStage] = useState<'idle' | 'selecting' | 'capturing'>('idle');
  const [addError, setAddError] = useState<string | null>(null);
  // Held from the first render of an open transition — NOT set in the open
  // effect, which runs after commit and so would land a frame too late, after
  // Modal's own focus effect has already fired. `true` initially and re-armed
  // in the close branch of the capture effect below, so every open starts
  // holding. See ModalProps.deferAutoFocus for what the hold buys.
  const [captureHoldsFocus, setCaptureHoldsFocus] = useState(true);
  const startedAtRef = useRef<number>(0);

  // Watermark gate (branding spec 2026-08-25): shown unless the latest
  // server config confirms paid entitlement. useSyncExternalStore because a
  // config read can land between renders while the dialog is open.
  const brandingServer = useSyncExternalStore(
    __subscribeBrandingServerConfig,
    __getBrandingServerConfig,
    () => undefined,
  );
  const showWatermark = brandingServer?.watermark !== false;

  const activeShot = screenshots.find((s) => s.id === activeShotId) ?? null;
  const setActiveAnnotations = useCallback(
    (next: Annotation[]): void =>
      setScreenshots((prev) => {
        const idx = prev.findIndex((s) => s.id === activeShotId);
        // Identity bail-out — AnnotateCanvas fires onChange from an effect
        // keyed on [annotations, onChange]; without returning `prev` here an
        // unchanged update would mint a new array identity every render and
        // loop the dialog forever.
        if (idx === -1 || prev[idx]!.annotations === next) return prev;
        const copy = prev.slice();
        copy[idx] = { ...copy[idx]!, annotations: next };
        return copy;
      }),
    [activeShotId],
  );

  const isDirty = (): boolean =>
    title.length > 0 ||
    description.length > 0 ||
    screenshots.some((s) => s.annotations.length > 0) ||
    screenshots.some((s) => s.source === 'manual');

  useEffect(() => {
    if (!open) {
      setBundle(null);
      setTitle('');
      setDescription('');
      setScreenshots([]);
      setActiveShotId(null);
      setPendingDeleteId(null);
      setRedactedLogs(new Set());
      setTitleError(undefined);
      setSubmitting(false);
      setShowDiscard(false);
      setAddStage('idle');
      setAddError(null);
      setCaptureHoldsFocus(true);
      return;
    }
    startedAtRef.current = Date.now();
    let cancelled = false;
    // Read SYNCHRONOUSLY, before the first await — same reasoning as the
    // `deferAutoFocus` hold below, but this one cannot be fixed by holding
    // focus alone. `captureFocusedNode()` reads `document.activeElement`, so
    // taken after the screenshot await it named the reporter's OWN title
    // input (or, through a shadow root, the reporter's host div) on every
    // single web report — `focusedNode.componentPath` and `.cursor` described
    // the bug reporter instead of the thing the user was looking at.
    const focused = (() => {
      try {
        return adapter.captureFocusedNode();
      } catch {
        return null;
      }
    })();
    void (async () => {
      const screenshot = await adapter.captureScreenshot().catch(() => null);
      // The clone has sampled the DOM; the host page's focus no longer needs
      // protecting. Released before the (cancelled) bail-out below so an open
      // that is torn down mid-capture cannot strand the hold.
      setCaptureHoldsFocus(false);
      const logs = (() => {
        try {
          return adapter.captureRecentLogs();
        } catch {
          return [] as LogEntry[];
        }
      })();
      const network = (() => {
        try {
          return adapter.captureRecentNetwork();
        } catch {
          return [] as NetworkEntry[];
        }
      })();
      const metadata = (() => {
        try {
          return adapter.getDeviceMetadata();
        } catch {
          return null;
        }
      })();
      if (cancelled) return;
      setBundle({
        screenshot,
        logs,
        network,
        metadata,
        focused,
        degradedReason: adapter.__lastDegradedReason,
      });
      if (screenshot) {
        const id = 'shot-1';
        setScreenshots([
          {
            id,
            blob: screenshot.blob,
            sha256: screenshot.sha256,
            width: screenshot.width,
            height: screenshot.height,
            pixelRatio: effectiveCaptureRatio(screenshot.width, metadata?.pixelRatio ?? 1),
            annotations: [],
            source: 'auto',
          },
        ]);
        setActiveShotId(id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, adapter]);

  // Safety net on the focus hold. The real `captureScreenshot` cannot hang —
  // it runs under `withDeadline` (capture-profile.ts) — but `ReporterDialog`
  // is exported publicly (`@everframe/web/ui`, re-exported by
  // `@everframe/react/preview`), so the adapter handed to it is not always
  // ours. A `captureScreenshot` that never settles would otherwise leave the
  // dialog on screen with focus permanently outside it: unreachable by
  // keyboard, unreachable by a TV remote, and unannounced to a screen reader.
  //
  // Deliberately shorter than the capture deadline itself. This is not a
  // budget the normal path is expected to fit in (a desktop capture settles
  // in a few hundred ms and releases the hold on its own); it is the point
  // past which an unfocusable dialog is the worse bug of the two.
  useEffect(() => {
    if (!open || !captureHoldsFocus) return;
    if (typeof window === 'undefined') return;
    const t = window.setTimeout(() => setCaptureHoldsFocus(false), FOCUS_HOLD_CEILING_MS);
    return () => window.clearTimeout(t);
  }, [open, captureHoldsFocus]);

  const handleClose = (): void => {
    if (isDirty()) setShowDiscard(true);
    else onCancel();
  };

  const onSubmit = async (): Promise<void> => {
    if (title.trim().length === 0) {
      setTitleError('Add a title before sending.');
      return;
    }
    setTitleError(undefined);
    setSubmitting(true);
    // PR review, round 5 (Serious) — capture the identity AT THE TRUE SUBMIT
    // BOUNDARY: the very first async work this handler does, before the
    // per-shot bake loop below. `onClick={() => void onSubmit()}` invokes
    // this function directly from the Send button's click — nothing awaits
    // ahead of this line. Round 4 captured in provider.tsx's `onComplete`,
    // reachable only once THIS function has already finished (including its
    // own `bakeAnnotations`/`sha256Hex` awaits for any annotated
    // screenshot — hundreds of milliseconds to seconds on the most common
    // reporter flow), which was still one hop later than the user's actual
    // Send action. Never throws (see the adapter method's own doc);
    // `undefined`/`null` distinction preserved so `onComplete` can tell "this
    // dialog captured, and nothing was live" from "this dialog never
    // captured" — see `ReporterCompletePayload.capturedIdentityToken`.
    //
    // External review, finding 1 (Serious) — the self-declared user is
    // captured at this same boundary, and FIRST: it is synchronous (no config
    // gate, no provider call, no await), so taking it before the token's
    // capture above costs nothing and closes the sliver of window that
    // capture's own `await` would otherwise open. Cloned by the adapter, so a
    // host that mutates its user object during the bake can't change what
    // ships. Threaded through `ReporterCompletePayload.capturedUser`.
    const capturedUser = adapter.__captureUserAtSubmitBoundary();
    const capturedIdentityToken = await adapter.__captureIdentityAtSubmitBoundary();
    // Per-shot pipeline: bake annotations into each shot's bytes, re-hash,
    // and tag the structured annotations/redactions with the part name the
    // shot will ship under (audit trail — receiver maps marks to images).
    interface TaggedAnnotation extends Record<string, unknown> {
      partName: string;
    }
    const bundleShots: BundleScreenshot[] = [];
    const taggedAnnotations: TaggedAnnotation[] = [];
    const taggedRedactions: TaggedAnnotation[] = [];
    for (let i = 0; i < screenshots.length; i++) {
      const shot = screenshots[i]!;
      const annotated = shot.annotations.length > 0;
      const kind = annotated ? 'annotated-screenshot' : 'screenshot';
      const partName = i === 0 ? kind : `${kind}-${i + 1}`;
      let blob = shot.blob;
      let sha = shot.sha256;
      if (annotated) {
        try {
          blob = await bakeAnnotations(shot.blob, shot.annotations);
        } catch {
          // DEFE-02 — never block submit on a bake failure; ship unmodified bytes.
        }
        try {
          sha = await sha256Hex(blob);
        } catch {
          // DEFE-02 — fall back to the pre-bake sha; receiver flags integrity,
          // report still ships.
        }
      }
      bundleShots.push({ blob, sha256: sha, width: shot.width, height: shot.height, annotated });
      for (const a of shot.annotations) {
        taggedAnnotations.push({ ...a, partName });
        if (a.kind === 'blur') {
          taggedRedactions.push({
            x: a.x,
            y: a.y,
            width: a.width,
            height: a.height,
            type: 'blur',
            partName,
          });
        }
      }
    }
    const primaryShot = bundleShots[0] ?? null;
    const captureBundle: CaptureBundle = {
      screenshotBlob: primaryShot?.blob ?? null,
      screenshotSha256: primaryShot?.sha256 ?? null,
      screenshotWidth: primaryShot?.width ?? 0,
      screenshotHeight: primaryShot?.height ?? 0,
      ...(bundleShots.length > 0 ? { screenshots: bundleShots } : {}),
      focused: bundle?.focused ?? null,
      logs: bundle?.logs ?? [],
      network: bundle?.network ?? [],
      metadata: bundle?.metadata ?? null,
      degradedReason: bundle?.degradedReason,
      redactedLogIndices: redactedLogs,
    };
    const draft: ReporterCompletePayload = {
      title,
      description,
      excludedArtifacts: [],
      annotations: taggedAnnotations as unknown as ReportDraft['annotations'],
      redactions: taggedRedactions as unknown as ReportDraft['redactions'],
      screenshotBlob: primaryShot?.blob ?? null,
      bundle: captureBundle,
      capturedIdentityToken,
      capturedUser,
    };
    onComplete(draft);
  };

  const performDeleteShot = (id: string): void => {
    const idx = screenshots.findIndex((s) => s.id === id);
    if (idx === -1) {
      setPendingDeleteId(null);
      return;
    }
    const next = screenshots.filter((s) => s.id !== id);
    setScreenshots(next);
    if (activeShotId === id) {
      const neighbor = next[Math.min(idx, next.length - 1)];
      setActiveShotId(neighbor ? neighbor.id : null);
    }
    setPendingDeleteId(null);
  };
  const requestDeleteShot = (id: string): void => {
    const shot = screenshots.find((s) => s.id === id);
    if (!shot) return;
    if (shot.annotations.length > 0) setPendingDeleteId(id);
    else performDeleteShot(id);
  };

  const handleAreaSelect = async (rect: Rect | null): Promise<void> => {
    setAddStage('capturing');
    setAddError(null);
    try {
      // Overlay unmounts before this await resolves (addStage left 'selecting'),
      // and both overlay + modal are data-everframe-skip-capture'd anyway.
      // The captured blob is VIEWPORT-anchored, so viewport-space CSS rect ×
      // the capture's ratio = image-pixel rect — no scroll math. The ratio is
      // derived from the SHOT (width / viewport width), NOT read off
      // window.devicePixelRatio: capture-profile.ts caps the render ratio on
      // TV/desktop, and scaling a selection by the uncapped DPR crops the
      // wrong region (codex round-2 finding 2).
      const shot = await adapter.captureScreenshot();
      const dpr = effectiveCaptureRatio(shot.width);
      let blob = shot.blob;
      let width = shot.width;
      let height = shot.height;
      let sha256 = shot.sha256;
      if (rect) {
        const cropped = await cropBlob(blob, {
          x: rect.x * dpr,
          y: rect.y * dpr,
          width: rect.width * dpr,
          height: rect.height * dpr,
        });
        blob = cropped.blob;
        width = cropped.width;
        height = cropped.height;
        sha256 = await sha256Hex(blob);
      }
      const id = `shot-${screenshots.length + 1}-${Math.random().toString(36).slice(2, 7)}`;
      setScreenshots((prev) => [
        ...prev,
        { id, blob, sha256, width, height, pixelRatio: dpr, annotations: [], source: 'manual' },
      ]);
      setActiveShotId(id);
    } catch {
      // DEFE-02 — a failed add never blocks the report; nothing is added.
      setAddError("Couldn't capture that screenshot. Nothing was added.");
    } finally {
      setAddStage('idle');
    }
  };

  // Footer manifest — names the artifacts captured silently at open-time.
  // Web reports always ship full context (the include-toggles card is gone),
  // so the manifest is the user-facing statement of what "Send report" sends.
  const attached = bundle
    ? [
        bundle.logs.length > 0 ? 'console' : null,
        bundle.network.length > 0 ? 'network' : null,
        bundle.metadata ? 'device info' : null,
      ].filter((part): part is string => part !== null)
    : [];

  const stripShots = useMemo(
    () =>
      screenshots.map((s) => ({
        id: s.id,
        blob: s.blob,
        annotationCount: s.annotations.length,
        source: s.source,
      })),
    [screenshots],
  );

  if (!open) return null;
  return (
    <>
      <Modal
        open={open}
        onClose={handleClose}
        title="Report a bug"
        hidden={addStage === 'selecting'}
        deferAutoFocus={captureHoldsFocus}
        footer={
          <>
            <span className="everframe-footer-left">
              {showWatermark ? <Watermark /> : null}
              {attached.length > 0 ? (
                <span className="everframe-manifest" data-testid="context-manifest">
                  <span className="everframe-manifest-dot" aria-hidden="true" />
                  <span className="everframe-manifest-text">Attached: {attached.join(' · ')}</span>
                </span>
              ) : null}
            </span>
            <Button
              variant="secondary"
              onClick={handleClose}
              disabled={submitting}
              data-testid="cancel-report"
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void onSubmit()}
              loading={submitting}
              disabled={submitting}
              data-testid="submit-report"
            >
              {submitting ? 'Sending…' : 'Send report'}
            </Button>
          </>
        }
      >
        <div data-testid="reporter-modal" className="everframe-composer">
          {/* Form pane first in the DOM: the title input is the first
           * focusable, so the Modal's open-focus lands on it immediately. */}
          <div className="everframe-composer-form">
            <TextInput
              label="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Describe the bug in one line"
              maxLength={200}
              {...(titleError !== undefined ? { errorText: titleError } : {})}
              required
              data-testid="report-title"
            />
            <Textarea
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional. What did you do? What did you expect? What happened instead?"
              rows={3}
              maxLength={400}
              data-testid="report-description"
            />
          </div>
          <div className="everframe-composer-media">
            {activeShot ? (
              <AnnotateScreenshot
                key={activeShot.id}
                imageBlob={activeShot.blob}
                annotations={activeShot.annotations}
                onChange={setActiveAnnotations}
                pixelRatio={activeShot.pixelRatio}
              />
            ) : bundle ? (
              <NoticeStrip>
                Couldn&apos;t capture a screenshot. The rest of your report will still be sent.
              </NoticeStrip>
            ) : (
              <p data-testid="capture-pending" className="everframe-capture-pending">
                Capturing report context…
              </p>
            )}
            {bundle ? (
              <ScreenshotStrip
                shots={stripShots}
                activeId={activeShotId}
                onSelect={setActiveShotId}
                onDelete={requestDeleteShot}
                onAdd={() => setAddStage('selecting')}
                adding={addStage === 'capturing'}
              />
            ) : null}
            {addError ? (
              <div data-testid="add-capture-error">
                <NoticeStrip tone="error">{addError}</NoticeStrip>
              </div>
            ) : null}
          </div>
        </div>
      </Modal>
      {addStage === 'selecting' ? (
        <AreaCaptureOverlay
          onSelect={(rect) => void handleAreaSelect(rect)}
          onCancel={() => setAddStage('idle')}
        />
      ) : null}
      <DiscardConfirmModal
        open={showDiscard}
        onConfirm={() => {
          setShowDiscard(false);
          onCancel();
        }}
        onDismiss={() => setShowDiscard(false)}
      />
      <Modal
        open={pendingDeleteId !== null}
        onClose={() => setPendingDeleteId(null)}
        title="Delete this screenshot?"
        compact
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setPendingDeleteId(null)}
              data-testid="delete-shot-keep"
              autoFocus
            >
              Keep it
            </Button>
            <Button
              variant="outline-destructive"
              onClick={() => pendingDeleteId && performDeleteShot(pendingDeleteId)}
              data-testid="delete-shot-confirm"
            >
              Delete screenshot
            </Button>
          </>
        }
      >
        <p>Its annotations will be lost.</p>
      </Modal>
    </>
  );
}
