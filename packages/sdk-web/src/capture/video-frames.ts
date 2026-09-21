// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';

/**
 * Video handling for the web screenshot pipeline.
 *
 * WHY THIS EXISTS — measured, not guessed (2026-08-18):
 * `modern-screenshot@4.7.0` (our primary capture path) clones each `<video>`
 * via `cloneVideoElement`, which contains two awaits with no timeout:
 *
 *     await waitUntilLoad(clone, { onError, onWarn })   // no `timeout` key passed
 *     clone.currentTime = video.currentTime
 *     await new Promise(s => clone.addEventListener('seeked', s, { once: true }))
 *
 * The second one is fatal. Per the HTML spec, seeking a media element whose
 * readyState is HAVE_NOTHING sets the default playback start position and
 * RETURNS — no `seeking`, no `seeked`, ever. So the promise never settles.
 * Verified against live Chromium by probing the detached clone:
 * `seekAssigned: 1, readyStateAtSeek: 0, seekedFired: 0`.
 *
 * A hang, not a throw, is what makes it so damaging: `captureScreenshot`'s
 * try/catch and the reporter's `.catch(() => null)` are both no-ops on a
 * promise that stays pending, so the 1x1-PNG degrade path is unreachable and
 * the reporter spins forever.
 *
 * The trigger is ordinary. Measured across video states, everything at
 * readyState 0 hangs — including a `<video>` with no `src` at all:
 *
 *     loaded (readyState 4)          -> settles
 *     no src at all                  -> HANGS forever
 *     broken / stalled source        -> HANGS forever
 *     MSE open with nothing buffered -> HANGS forever
 *
 * NEITHER MITIGATION WORKS ALONE, also measured:
 *   - `timeout` option alone   -> still hangs; it never reaches the clone step
 *   - filtering `<video>` out  -> cures the hang, but still costs 30s, because
 *                                modern-screenshot awaits the load of every
 *                                `<img>`/`<video>` in the subtree BEFORE the
 *                                filter is consulted
 *   - both together            -> 0-1.5s
 *
 * ============================ THE STAND-IN =============================
 *
 * `captureScreenshot` therefore drops every `<video>` from the clone. On its
 * own that is WRONG, because a filtered node contributes no layout box:
 * measured on an in-flow `<video width=320 height=180>`, everything below it
 * moved UP by exactly 180px in the capture. A screenshot whose layout does not
 * match what the user saw is worse than one missing a video.
 *
 * So for the duration of the capture each `<video>` is paired with a STAND-IN:
 * a `<div>` inserted as its next sibling, carrying the video's box and its
 * current frame as a background image, while the video itself is held at
 * `display: none`. Net live layout is unchanged (the stand-in occupies exactly
 * the box the video vacated), the capture library sees an ordinary div it
 * cannot choke on, and everything is reverted in a `finally`.
 *
 * The frame is read with a synchronous `drawImage` off the LIVE element
 * (measured at 0.6-0.7ms — no clone, no seek, no awaits, structurally
 * incapable of hanging), which is exactly what the capture libraries get wrong.
 *
 * Standing the frame IN THE DOM, rather than compositing it onto the finished
 * PNG, is what makes the rest correct for free — and all three were real bugs
 * in the compositing version of this file:
 *   - a `visibility: hidden` / `opacity: 0` / clipped video cannot leak its
 *     frame, because the stand-in inherits the same styles and ancestors;
 *   - a rect-based `maskPlan` cannot be painted over, because nothing is
 *     painted after redaction runs;
 *   - z-order, `overflow` clipping and transforms are resolved by the renderer
 *     instead of being approximated by us.
 *
 * The video is NEVER detached (no `removeChild` / `replaceChild`): pulling a
 * playing element out of the document resets it, which for an MSE/HLS stream
 * means tearing down the live session in order to screenshot it. `display:
 * none` leaves the media element and its buffers intact — verified after a
 * capture: no stand-ins left, no hidden videos, every playing video still
 * playing.
 *
 * KNOWN COST, accepted deliberately: for the length of the capture the live
 * page shows the stand-in rather than the video, so motion appears to freeze
 * on a still frame (and an unreadable stream shows its placeholder). Under the
 * reporter this sits behind the modal; a companion-triggered capture has no
 * such cover and the freeze is visible. It is bounded by the capture deadline,
 * it costs no playback state, and the alternatives are a reporter that hangs
 * forever or a screenshot whose layout does not match the page. Off-screen
 * videos are left un-sampled precisely so this window stays as small as it can
 * be.
 *
 * Do NOT "simplify" this by letting the capture library handle video again.
 * The regression is silent in unit tests and manifests as a permanently stuck
 * reporter in production. `e2e/video-capture.spec.ts` is the guard.
 */

/**
 * Videos currently stood in for, ACROSS ALL IN-FLIGHT CAPTURES.
 *
 * Captures can overlap: the companion bridge calls `captureScreenshot`
 * independently of the reporter, and React Strict Mode double-invokes effects.
 * Without this, the second capture would read the FIRST one's
 * `display: none !important` as the video's original state, and its teardown
 * would then "restore" the video to hidden — leaving the customer with a
 * permanently invisible video. That is the worst outcome in this whole file:
 * a broken page long after the report was sent.
 *
 * So the first capture to reach a video owns it, and the record is
 * reference-counted: later captures reuse the same stand-in (which is already
 * showing exactly what they want) and the video is only restored once the LAST
 * capture releases it. A WeakMap so a video removed from the page mid-capture
 * is still collectable.
 */
interface StandInRecord {
  count: number;
  standIn: HTMLElement;
  previousInlineDisplay: string;
  previousInlineDisplayPriority: string;
}
const activeStandIns = new WeakMap<HTMLVideoElement, StandInRecord>();

/** Test seam — asserts a video is currently stood in for. */
export function hasActiveStandIn(video: HTMLVideoElement): boolean {
  return activeStandIns.has(video);
}

/** Marks the elements we inject, so teardown can find them and never guess. */
export const STAND_IN_ATTR = 'data-traceitx-video-stand-in';

/**
 * Ceiling on the poster fetch. The poster is a nicety on the degraded path, so
 * it gets a small budget — the whole point of this module is that capture can
 * never be held hostage by a media resource.
 */
export const POSTER_LOAD_TIMEOUT_MS = 600;

/**
 * Ceiling on the total frame pixels read in one capture.
 *
 * Each readable video costs a canvas plus a base64 encode of it. A feed or
 * carousel holding a dozen HD players would otherwise allocate all of them
 * SYNCHRONOUSLY, before `withDeadline` has anything to time out — the tab
 * freezes or dies rather than degrading. Roughly four 1080p frames; past it,
 * remaining videos fall back to poster or placeholder, which is a far better
 * failure than a dead tab.
 */
const MAX_TOTAL_FRAME_PIXELS = 8_000_000;

/**
 * Frames are encoded as JPEG, not PNG.
 *
 * Video content is photographic, where JPEG is roughly an order of magnitude
 * smaller for the same perceived quality — and this string is inlined into the
 * DOM as a data URI, so its size is memory the page holds for the duration of
 * the capture. PNG's lossless-ness buys nothing on a camera frame; the one
 * thing it would buy, alpha, is vanishingly rare in video and not worth the
 * cost to everyone else.
 */
const FRAME_MIME = 'image/jpeg';
const FRAME_QUALITY = 0.82;

/** `HTMLMediaElement.HAVE_CURRENT_DATA` — the point at which a frame exists to draw. */
const HAVE_CURRENT_DATA = 2;

/** Structural subset of `HTMLVideoElement` the classifier needs — keeps it unit-testable. */
export interface VideoReadiness {
  readyState: number;
  videoWidth: number;
  videoHeight: number;
}

/**
 * Whether this element currently has a frame that `drawImage` can read.
 *
 * `videoWidth` is checked as well as `readyState` because they can disagree:
 * an audio-only stream in a `<video>` reaches readyState 4 with intrinsic
 * dimensions of 0, and drawing that paints nothing while still tainting the
 * canvas if the source is cross-origin — the worst of both outcomes.
 */
export function hasReadableFrame(v: VideoReadiness): boolean {
  return v.readyState >= HAVE_CURRENT_DATA && v.videoWidth > 0 && v.videoHeight > 0;
}

/**
 * Whether any part of this rect will survive the crop to the viewport.
 *
 * `captureScreenshot` always crops its output to the viewport, so a video
 * entirely outside it cannot contribute a single pixel to the report — and
 * reading its frame is pure cost. Its stand-in is still created, because an
 * off-screen video above the fold very much does hold layout open for what IS
 * visible; it is just created empty.
 */
export function intersectsViewport(
  rect: { x: number; y: number; width: number; height: number },
  viewportW: number,
  viewportH: number,
): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (rect.x >= viewportW || rect.y >= viewportH) return false;
  if (rect.x + rect.width <= 0 || rect.y + rect.height <= 0) return false;
  return true;
}

/**
 * True when `el` sits inside a subtree that is excluded from capture, either
 * by the SDK's own skip attribute or by a caller-supplied mask target.
 *
 * PRIVACY-LOAD-BEARING. These videos still get a stand-in — the box has to be
 * held open or the layout collapses — but an EMPTY one. Reading a frame for
 * them would reintroduce, through the stand-in, exactly the content the
 * customer asked us to leave out.
 */
export function isExcludedFromCapture(el: Element, maskTargets: readonly Element[] = []): boolean {
  let node: Element | null = el;
  while (node) {
    if (node.getAttribute?.('data-traceitx-skip-capture') === 'true') return true;
    for (const target of maskTargets) {
      if (target === node) return true;
    }
    // Cross the shadow boundary via the host rather than stopping at it:
    // `parentElement` is null for a shadow root's top-level children, so an
    // opt-out placed on a web component would otherwise not apply to the video
    // inside it — the exact case where the customer cannot reach the video to
    // tag it directly.
    const parent: Element | null = node.parentElement;
    if (parent) {
      node = parent;
      continue;
    }
    const root = node.getRootNode?.();
    node = root && (root as ShadowRoot).host ? (root as ShadowRoot).host : null;
  }
  return false;
}

/**
 * Every `<video>` under `root`, INCLUDING those inside open shadow roots.
 *
 * `querySelectorAll` does not pierce shadow boundaries, but both capture
 * libraries walk into open shadow roots — so a video inside a web-component
 * player was being dropped by the node filter (correctly, or it would hang)
 * with nothing standing in for it, collapsing the component's layout in the
 * screenshot. Video players are one of the commonest things to ship as a web
 * component, which puts this squarely on the path this module exists to fix.
 *
 * Closed shadow roots are unreachable by construction; a video inside one
 * keeps the old behaviour of a missing box, and nothing can be done about it
 * from here.
 */
export function collectVideos(root: ParentNode): HTMLVideoElement[] {
  const out: HTMLVideoElement[] = [];
  const seen = new Set<ParentNode>();

  const visit = (node: ParentNode): void => {
    if (seen.has(node)) return;
    seen.add(node);
    const videos = node.querySelectorAll?.('video');
    if (videos) for (let i = 0; i < videos.length; i++) out.push(videos[i] as HTMLVideoElement);
    const all = node.querySelectorAll?.('*');
    if (!all) return;
    for (let i = 0; i < all.length; i++) {
      const shadow = (all[i] as Element).shadowRoot;
      if (shadow) visit(shadow);
    }
  };

  if ((root as Element).tagName === 'VIDEO') out.push(root as unknown as HTMLVideoElement);
  visit(root);
  return out;
}

/**
 * Remove a stand-in's content, keeping its box.
 *
 * Used when an overlapping capture considers a video sensitive that the
 * capture which created the stand-in did not. Suppression is MONOTONIC — the
 * most restrictive concurrent capture wins and the frame is never put back —
 * because the alternative is deciding which of two in-flight captures a frame
 * is allowed to reach, and getting that wrong leaks it.
 */
export function stripStandInContent(standIn: HTMLElement): void {
  standIn.style.removeProperty('background-image');
  standIn.style.removeProperty('background-color');
  standIn.style.removeProperty('background-size');
  standIn.style.removeProperty('background-position');
  standIn.style.removeProperty('background-repeat');
  standIn.style.removeProperty('box-shadow');
}

/**
 * Read the current frame off a LIVE video element, at its own aspect ratio.
 *
 * Synchronous by construction — no clone, no `currentTime` assignment, no
 * event wait. That is the whole reason this is safe where the capture library
 * is not.
 *
 * The canvas is capped to the element's on-screen footprint so a 4K stream in
 * a 320px plate does not allocate a 4K bitmap, but the video's INTRINSIC
 * aspect ratio is preserved rather than stretched to the box: the stand-in
 * reproduces letterboxing via `background-size`, mirroring the `object-fit`
 * the browser applied. Stretching here would silently distort every video
 * whose box is a different shape from its content.
 *
 * Returns null when there is no frame, or when the source is cross-origin
 * without CORS. In the latter case `drawImage` succeeds but TAINTS the canvas,
 * and the taint is only observable on read — so we probe with a 1x1
 * `getImageData` and discard the canvas if it throws. Skipping that probe
 * would let a poisoned canvas reach `toDataURL`, which throws and would cost
 * the whole screenshot instead of this one video.
 */
export function grabLiveFrame(
  video: HTMLVideoElement,
  maxW: number,
  maxH: number,
  pixelBudget = Number.POSITIVE_INFINITY,
): HTMLCanvasElement | null {
  if (!hasReadableFrame(video)) return null;
  if (maxW <= 0 || maxH <= 0) return null;
  if (pixelBudget <= 0) return null;
  try {
    let scale = Math.min(1, maxW / video.videoWidth, maxH / video.videoHeight);
    // Shrink rather than refuse when the shared budget is nearly spent: a
    // softer frame beats no frame, and beats allocating past the ceiling.
    // Approximate by design — rounding the two dimensions can land under a
    // row of pixels over the figure, which is irrelevant to a ceiling that
    // exists to prevent hundred-megabyte allocations.
    const wanted = video.videoWidth * scale * (video.videoHeight * scale);
    if (Number.isFinite(pixelBudget) && wanted > pixelBudget) {
      scale *= Math.sqrt(pixelBudget / wanted);
    }
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);
    // Taint probe — throws SecurityError on a cross-origin source.
    ctx.getImageData(0, 0, 1, 1);
    return canvas;
  } catch {
    return null;
  }
}

/**
 * Load a poster image under a hard deadline, for videos whose frame we could
 * not read.
 *
 * `crossOrigin = 'anonymous'` is set deliberately: a poster that needs CORS
 * and does not have it FAILS TO LOAD here, which costs us the poster but keeps
 * the export clean. Loading it without the attribute would succeed and taint
 * instead, trading a missing poster for a missing screenshot.
 */
export function loadPoster(
  url: string,
  timeoutMs: number = POSTER_LOAD_TIMEOUT_MS,
): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: HTMLImageElement | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'sync';
      img.addEventListener('load', () => done(img.naturalWidth > 0 ? img : null), { once: true });
      img.addEventListener('error', () => done(null), { once: true });
      img.src = url;
    } catch {
      done(null);
    }
  });
}

/** Neutral "a video was here" plate — deliberately unalarming, and font-free. */
const PLACEHOLDER_BG = '#1c2128';
const PLACEHOLDER_BORDER = '#3a424c';
/**
 * Play glyph as an inline SVG data URI.
 *
 * Vector rather than text so it needs no font and cannot render as tofu, and
 * inline rather than fetched so it survives a strict CSP with no `img-src`
 * allowance beyond `data:`. It exists so whoever reads the report understands
 * a video occupied this region and its frame was unreadable — a blank hole
 * reads as a rendering bug and sends people hunting for one.
 */
const PLACEHOLDER_GLYPH =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E" +
  "%3Ccircle cx='24' cy='24' r='15' fill='none' stroke='%236b7684' stroke-width='2'/%3E" +
  "%3Cpath d='M20 16.5 L32 24 L20 31.5 Z' fill='%236b7684'/%3E%3C/svg%3E";

/**
 * Map the video's computed `object-fit` onto the `background-size` that
 * reproduces it, so the stand-in letterboxes exactly as the element did.
 * `scale-down` collapses to `contain`: they differ only when the frame is
 * smaller than the box, and `grabLiveFrame` never upscales.
 */
export function backgroundSizeForObjectFit(objectFit: string): string {
  switch (objectFit) {
    case 'fill':
      return '100% 100%';
    case 'cover':
      return 'cover';
    case 'none':
      return 'auto';
    case 'scale-down':
    case 'contain':
    default:
      return 'contain';
  }
}

/**
 * The computed properties the stand-in copies from the video.
 *
 * Explicitly enumerated rather than copying every computed property, because a
 * `<video>` is a REPLACED element and a `<div>` is not: verbatim copying brings
 * `display: inline` across, width/height do not apply to a non-replaced inline
 * box, and the stand-in collapses — putting us back in the layout bug this
 * exists to fix. `display` is special-cased below for exactly that reason.
 *
 * Everything here earns its place by changing where the box lands or how it is
 * clipped — flow, flex/grid participation, positioning, transforms, and the
 * visibility/opacity pair that keeps a hidden video hidden.
 */
const COPIED_STYLE_PROPS = [
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',
  'float',
  'clear',
  'vertical-align',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'align-self',
  'justify-self',
  'order',
  'grid-column-start',
  'grid-column-end',
  'grid-row-start',
  'grid-row-end',
  'transform',
  'transform-origin',
  'border-radius',
  'visibility',
  'opacity',
  'mix-blend-mode',
  'filter',
  'clip-path',
  // Deprecated but alive: `clip` is the engine of the classic `.sr-only` /
  // `.visually-hidden` utility, and it does suppress a div's background — so
  // copying it reproduces the effect exactly, partial clips included.
  'clip',
  // Paint suppression that DOES reproduce when copied, because a mask applies
  // to the whole of an element's rendering — the stand-in's background
  // included. A partially transparent mask is a legitimate effect (a rounded
  // or gradient reveal), so it is reproduced rather than treated as "hidden".
  'content-visibility',
  'mask-image',
  'mask-mode',
  'mask-repeat',
  'mask-position',
  'mask-size',
  'mask-origin',
  'mask-clip',
  'mask-composite',
  '-webkit-mask-image',
  '-webkit-mask-repeat',
  '-webkit-mask-position',
  '-webkit-mask-size',
  '-webkit-mask-origin',
  '-webkit-mask-clip',
  '-webkit-mask-composite',
] as const;

/**
 * Whether a computed `clip` collapses the element to nothing.
 *
 * `clip: rect(0 0 0 0)` on an absolutely-positioned element is how the
 * `.sr-only` / `.visually-hidden` utility that ships with Bootstrap, Tailwind
 * and most design systems hides content — while leaving a full-size layout
 * box, so nothing else here would notice. An `auto` edge means that side is
 * not clipped at all, which cannot collapse the box.
 */
export function clipHidesEverything(clip: string | undefined): boolean {
  if (!clip || clip === 'auto') return false;
  const match = /^rect\(([^)]+)\)$/.exec(clip.trim());
  if (!match) return false;
  const edges = match[1]!
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((value) => (value === 'auto' ? Number.NaN : Number.parseFloat(value)));
  if (edges.length !== 4 || edges.some((n) => !Number.isFinite(n))) return false;
  const [top, right, bottom, left] = edges as [number, number, number, number];
  return right - left <= 0 || bottom - top <= 0;
}

/**
 * True when the element paints nothing of its own, despite holding a layout box.
 *
 * PRIVACY-LOAD-BEARING, and the reason it cannot simply be handled by copying
 * styles onto the stand-in. `content-visibility: hidden` suppresses an
 * element's CONTENTS, and a video frame is contents — but the stand-in shows
 * the frame as its own BACKGROUND, which `content-visibility` does not
 * suppress. Copying the property across would therefore reveal, as a div
 * background, a frame the page had hidden. Verified in Chromium: such a video
 * keeps a full 200x112 box and paints zero pixels.
 *
 * `visibility`, `opacity: 0` and a fully collapsed `clip` would in fact all
 * survive the copy, but are included so no frame is ever read for them:
 * cheaper, and it keeps a screenshot-shaped copy of hidden content from
 * existing even briefly.
 *
 * Ancestors need no equivalent check — the stand-in sits where the video sat,
 * so an ancestor's `opacity`, `content-visibility`, mask or clip suppresses it
 * identically. `visibility` inherits and so is already reflected here.
 */
export function paintsNothing(computed: CSSStyleDeclaration | undefined): boolean {
  if (!computed) return false;
  if (computed.getPropertyValue('content-visibility') === 'hidden') return true;
  const visibility = computed.visibility;
  if (visibility === 'hidden' || visibility === 'collapse') return true;
  if (Number.parseFloat(computed.opacity) === 0) return true;
  if (clipHidesEverything(computed.getPropertyValue('clip'))) return true;
  return false;
}

/**
 * The video's UNTRANSFORMED border-box size, in CSS px.
 *
 * `getBoundingClientRect()` must not be used for this. It reports the
 * TRANSFORMED box, so a `transform: scale(2)` video returns double its layout
 * size — and since the stand-in also copies `transform`, feeding that back in
 * as width/height applies the scale twice. For a rotated video it is worse
 * still: the rect is the axis-aligned bounding box of the rotated shape, which
 * is not a width and a height at all. An ancestor transform has the same
 * effect, because it scales the rect while also already applying to the
 * stand-in.
 *
 * The resolved `width`/`height` are used values in layout space, immune to
 * every transform in the ancestor chain. They resolve to the CONTENT box, so
 * padding and border are added back to reach the border box that
 * `box-sizing: border-box` on the stand-in then expects. `offsetWidth`/
 * `offsetHeight` are the fallback: already border-box and transform-free, just
 * rounded to whole pixels.
 */
export function untransformedBorderBox(
  video: HTMLVideoElement,
  computed: CSSStyleDeclaration | undefined,
): { width: number; height: number } {
  const px = (value: string | undefined): number => {
    const n = Number.parseFloat(value ?? '');
    return Number.isFinite(n) ? n : 0;
  };
  if (computed) {
    const contentW = Number.parseFloat(computed.width);
    const contentH = Number.parseFloat(computed.height);
    if (Number.isFinite(contentW) && Number.isFinite(contentH)) {
      // `width` already IS the border box when the element is border-box sized.
      const extraX =
        computed.boxSizing === 'border-box'
          ? 0
          : px(computed.paddingLeft) +
            px(computed.paddingRight) +
            px(computed.borderLeftWidth) +
            px(computed.borderRightWidth);
      const extraY =
        computed.boxSizing === 'border-box'
          ? 0
          : px(computed.paddingTop) +
            px(computed.paddingBottom) +
            px(computed.borderTopWidth) +
            px(computed.borderBottomWidth);
      return { width: contentW + extraX, height: contentH + extraY };
    }
  }
  return { width: video.offsetWidth, height: video.offsetHeight };
}

export interface InstallStandInsOptions {
  /** Device-pixel scale the capture runs at; caps the frame bitmap. */
  pixelRatio: number;
  /** Elements being masked as sensitive — videos inside them get an EMPTY stand-in. */
  maskTargets?: readonly Element[];
  /** Test seam. */
  posterTimeoutMs?: number;
}

interface StandInContent {
  frame: HTMLCanvasElement | HTMLImageElement | null;
  placeholder: boolean;
}

/** Build (but do not yet insert) the stand-in for one video. */
export function buildStandIn(video: HTMLVideoElement, content: StandInContent): HTMLElement {
  const doc = video.ownerDocument;
  const standIn = doc.createElement('div');
  standIn.setAttribute(STAND_IN_ATTR, 'true');
  standIn.setAttribute('aria-hidden', 'true');
  // Inherit the slot assignment. A `<video slot="media">` in a web component's
  // light DOM renders wherever the shadow root's matching `<slot>` puts it; a
  // stand-in without the attribute falls to the default slot, or nowhere at
  // all, and the component's video box collapses.
  const slot = video.getAttribute('slot');
  if (slot !== null) standIn.setAttribute('slot', slot);

  const computed = doc.defaultView?.getComputedStyle(video);
  const style = standIn.style;

  if (computed) {
    for (const prop of COPIED_STYLE_PROPS) {
      const value = computed.getPropertyValue(prop);
      if (value) style.setProperty(prop, value);
    }
    // A replaced inline element has a box; a plain inline div does not, so
    // width/height would be ignored and the stand-in would collapse.
    const display = computed.display;
    style.display = !display || display === 'inline' ? 'inline-block' : display;
  } else {
    style.display = 'inline-block';
  }

  // Sized from the UNTRANSFORMED border box — see untransformedBorderBox for
  // why the visual rect would double any transform the copy above re-applies.
  const box = untransformedBorderBox(video, computed ?? undefined);
  style.boxSizing = 'border-box';
  style.width = `${box.width}px`;
  style.height = `${box.height}px`;
  // Rounded video corners should clip the frame, not show it square.
  style.overflow = 'hidden';

  if (content.frame) {
    const url =
      typeof (content.frame as HTMLImageElement).src === 'string'
        ? (content.frame as HTMLImageElement).src
        : (content.frame as HTMLCanvasElement).toDataURL(FRAME_MIME, FRAME_QUALITY);
    style.backgroundImage = `url("${url}")`;
    style.backgroundRepeat = 'no-repeat';
    style.backgroundPosition = computed?.objectPosition || 'center';
    style.backgroundSize = backgroundSizeForObjectFit(computed?.objectFit ?? 'contain');
  } else if (content.placeholder) {
    style.backgroundColor = PLACEHOLDER_BG;
    style.boxShadow = `inset 0 0 0 1px ${PLACEHOLDER_BORDER}`;
    style.backgroundImage = `url("${PLACEHOLDER_GLYPH}")`;
    style.backgroundRepeat = 'no-repeat';
    style.backgroundPosition = 'center';
    // Bounded so the glyph stays a glyph on both a thumbnail and a hero player.
    const glyph = Math.max(24, Math.min(64, Math.min(box.width, box.height) * 0.32));
    style.backgroundSize = `${glyph}px ${glyph}px`;
  }

  return standIn;
}

/**
 * Swap every `<video>` under `root` for a stand-in, and return the teardown.
 *
 * MUST be called AFTER any live-DOM masking is applied, so a masked video is
 * observed in its masked state, and BEFORE the capture, so the frame matches
 * the moment the rest of the page was sampled.
 *
 * The returned teardown is idempotent and never throws — it runs from a
 * `finally`, and a customer's page must not be left with hidden videos and
 * orphaned divs because one restoration step failed.
 */
export async function installVideoStandIns(
  root: HTMLElement,
  opts: InstallStandInsOptions,
): Promise<() => void> {
  const noop = (): void => undefined;
  if (typeof document === 'undefined' || typeof window === 'undefined') return noop;

  const videos = collectVideos(root);
  if (videos.length === 0) return noop;

  const ratio = opts.pixelRatio > 0 ? opts.pixelRatio : 1;
  const maskTargets = opts.maskTargets ?? [];
  /** Videos another capture already owns; we hold a reference, not the state. */
  const adopted: HTMLVideoElement[] = [];

  // PASS 1 — synchronous: measure and read every frame that can be read.
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  let framePixelsUsed = 0;

  interface Candidate {
    video: HTMLVideoElement;
    excluded: boolean;
    frame: HTMLCanvasElement | HTMLImageElement | null;
    posterUrl: string | null;
  }
  const candidates: Candidate[] = [];

  for (const video of videos) {
    if (!video.parentNode) continue;
    // Already stood in for by an overlapping capture: adopt it rather than
    // stacking a second stand-in and mis-recording the "original" display.
    const existing = activeStandIns.get(video);
    if (existing) {
      existing.count += 1;
      adopted.push(video);
      // The stand-in was built for ANOTHER capture, which may not have
      // considered this video sensitive. Re-judge it against ours and strip the
      // frame if we would not have shown it — otherwise an unmasked capture's
      // stand-in carries a masked frame straight into our report.
      if (isExcludedFromCapture(video, maskTargets)) stripStandInContent(existing.standIn);
      continue;
    }
    // The VISUAL rect, used only to decide whether there is anything to do and
    // how many pixels the frame will actually occupy on screen. The stand-in's
    // own dimensions come from untransformedBorderBox instead — these two
    // differ exactly when a transform is in play, which is the point.
    let painted: DOMRect;
    try {
      painted = video.getBoundingClientRect();
    } catch {
      continue;
    }
    // A zero-area video (display:none, detached, collapsed) holds no layout
    // open, so there is nothing to stand in for.
    if (painted.width <= 0 || painted.height <= 0) continue;

    // Two different reasons to hold the box open while showing nothing in it:
    // the customer excluded this video, or the page itself is not painting it.
    // Neither gets a placeholder glyph, which would advertise that something
    // was hidden here.
    const excluded =
      isExcludedFromCapture(video, maskTargets) ||
      paintsNothing(video.ownerDocument.defaultView?.getComputedStyle(video));
    if (excluded) {
      candidates.push({ video, excluded, frame: null, posterUrl: null });
      continue;
    }

    // Off-screen videos get a stand-in (they still hold layout open for what IS
    // visible) but no frame: the capture is cropped to the viewport, so their
    // pixels could never appear in the report.
    if (!intersectsViewport(painted, viewportW, viewportH)) {
      candidates.push({ video, excluded: true, frame: null, posterUrl: null });
      continue;
    }

    // Capped by what the viewer will SEE, so a video scaled up by a transform
    // is still sampled at enough resolution to look sharp.
    const budgetLeft = MAX_TOTAL_FRAME_PIXELS - framePixelsUsed;
    const frame =
      budgetLeft > 0
        ? grabLiveFrame(video, painted.width * ratio, painted.height * ratio, budgetLeft)
        : null;
    if (frame) framePixelsUsed += frame.width * frame.height;
    candidates.push({
      video,
      excluded,
      frame,
      posterUrl: frame ? null : video.poster || null,
    });
  }

  if (candidates.length === 0 && adopted.length === 0) return noop;

  // PASS 2 — the only await, and only for videos with a poster to fall back to.
  //
  // CONCURRENT, deliberately. Awaiting these one at a time would make the cost
  // N x POSTER_LOAD_TIMEOUT_MS, so a page holding ten dead players with posters
  // would add six seconds to every report — reintroducing the stuck reporter
  // this module exists to prevent, just more slowly. Fetched together, the
  // worst case is one timeout regardless of count.
  const withPoster = candidates.filter((c) => c.posterUrl);
  if (withPoster.length > 0) {
    const posters = await Promise.all(
      withPoster.map((c) => loadPoster(c.posterUrl as string, opts.posterTimeoutMs)),
    );
    posters.forEach((poster, i) => {
      if (poster) withPoster[i]!.frame = poster;
    });
  }

  // PASS 3 — mutate. Kept last and tight so the window in which the customer's
  // DOM differs from its resting state is as short as possible.
  const owned: HTMLVideoElement[] = [];
  for (const c of candidates) {
    // Re-checked here, not just in pass 1: pass 2 awaited, and an overlapping
    // capture may have claimed this video in the meantime.
    const existing = activeStandIns.get(c.video);
    if (existing) {
      existing.count += 1;
      adopted.push(c.video);
      if (c.excluded) stripStandInContent(existing.standIn);
      continue;
    }
    const standIn = buildStandIn(c.video, {
      frame: c.frame,
      placeholder: !c.excluded && !c.frame,
    });
    try {
      c.video.parentNode?.insertBefore(standIn, c.video.nextSibling);
    } catch {
      continue;
    }
    const previousInlineDisplay = c.video.style.getPropertyValue('display');
    const previousInlineDisplayPriority = c.video.style.getPropertyPriority('display');
    // `!important` so a stylesheet rule with higher specificity cannot leave
    // the video visible alongside its stand-in, which would double the box.
    c.video.style.setProperty('display', 'none', 'important');
    activeStandIns.set(c.video, {
      count: 1,
      standIn,
      previousInlineDisplay,
      previousInlineDisplayPriority,
    });
    owned.push(c.video);
  }

  if (owned.length === 0 && adopted.length === 0) return noop;

  let restored = false;
  return (): void => {
    if (restored) return;
    restored = true;
    for (const video of [...owned, ...adopted]) {
      const record = activeStandIns.get(video);
      if (!record) continue;
      record.count -= 1;
      // Another capture is still relying on this stand-in; it restores.
      if (record.count > 0) continue;
      activeStandIns.delete(video);
      try {
        record.standIn.remove();
      } catch {
        // keep going — one stuck node must not strand the rest
      }
      try {
        // Only put back what we took. A capture can be in flight for seconds,
        // and the application may legitimately restyle its own video in that
        // window — React re-rendering it, a player toggling fullscreen. Writing
        // the pre-capture value back unconditionally would silently revert
        // that, leaving the page showing or hiding a video against its own
        // current state. If the inline display is no longer the exact
        // `none !important` we set, someone else owns it now; leave it alone.
        const current = video.style.getPropertyValue('display');
        const currentPriority = video.style.getPropertyPriority('display');
        if (current === 'none' && currentPriority === 'important') {
          if (record.previousInlineDisplay) {
            video.style.setProperty(
              'display',
              record.previousInlineDisplay,
              record.previousInlineDisplayPriority,
            );
          } else {
            video.style.removeProperty('display');
          }
        }
      } catch {
        // as above
      }
    }
  };
}
