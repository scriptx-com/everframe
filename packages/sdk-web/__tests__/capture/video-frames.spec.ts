// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasReadableFrame,
  isExcludedFromCapture,
  grabLiveFrame,
  loadPoster,
  buildStandIn,
  untransformedBorderBox,
  paintsNothing,
  intersectsViewport,
  hasActiveStandIn,
  collectVideos,
  clipHidesEverything,
  backgroundSizeForObjectFit,
  installVideoStandIns,
  POSTER_LOAD_TIMEOUT_MS,
  STAND_IN_ATTR,
} from '../../src/capture/video-frames.js';

/**
 * These cover the decision logic and the DOM contract. The behaviour that
 * motivates the module — that a `<video>` can no longer wedge capture, and
 * that the stand-in lands on the same pixels the video occupied — is not
 * provable here, because jsdom has no media pipeline, no real canvas and no
 * layout engine: `e2e/video-capture.spec.ts` owns that against live browsers.
 *
 * What these DO protect are the judgement calls that are easy to "simplify"
 * wrongly later and would fail silently in production: the
 * readyState/videoWidth pair, the skip/mask exclusion, and above all that the
 * live DOM is put back exactly as it was found.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/**
 * jsdom gives every element a 0x0 rect and no layout, so give this one both
 * halves of a real box: the VISUAL rect (mocked, since jsdom has no layout
 * engine) and the LAYOUT size, which the stand-in derives from computed style.
 * They are set to the same numbers here; the two only diverge under a
 * transform, which `untransformedBorderBox`'s own tests cover directly.
 */
function withBox(el: Element, box: Partial<DOMRect> = {}): void {
  const width = box.width ?? 320;
  const height = box.height ?? 180;
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    width,
    height,
    ...box,
  } as DOMRect);
  (el as HTMLElement).style.width = `${width}px`;
  (el as HTMLElement).style.height = `${height}px`;
}

describe('hasReadableFrame', () => {
  it('accepts an element with data and intrinsic dimensions', () => {
    expect(hasReadableFrame({ readyState: 2, videoWidth: 640, videoHeight: 360 })).toBe(true);
    expect(hasReadableFrame({ readyState: 4, videoWidth: 1, videoHeight: 1 })).toBe(true);
  });

  it('rejects readyState below HAVE_CURRENT_DATA', () => {
    // The exact states measured as hanging modern-screenshot: no src, stalled
    // source, MSE with nothing buffered — all report readyState 0.
    expect(hasReadableFrame({ readyState: 0, videoWidth: 640, videoHeight: 360 })).toBe(false);
    expect(hasReadableFrame({ readyState: 1, videoWidth: 640, videoHeight: 360 })).toBe(false);
  });

  it('rejects a ready element with no intrinsic size', () => {
    // Audio-only content in a <video> reaches readyState 4 with 0x0 dimensions.
    // Drawing it paints nothing yet still taints the canvas when the source is
    // cross-origin, so it must be rejected on size, not just readiness.
    expect(hasReadableFrame({ readyState: 4, videoWidth: 0, videoHeight: 0 })).toBe(false);
    expect(hasReadableFrame({ readyState: 4, videoWidth: 640, videoHeight: 0 })).toBe(false);
  });
});

describe('isExcludedFromCapture', () => {
  it('excludes a video nested deep inside a skipped subtree', () => {
    document.body.innerHTML =
      '<div data-traceitx-skip-capture="true"><section><figure><video></video></figure></section></div>';
    expect(isExcludedFromCapture(document.querySelector('video')!)).toBe(true);
  });

  it('excludes a video inside a mask target', () => {
    document.body.innerHTML = '<div id="secret"><video></video></div>';
    expect(
      isExcludedFromCapture(document.querySelector('video')!, [document.getElementById('secret')!]),
    ).toBe(true);
  });

  it('does not exclude an ordinary video', () => {
    document.body.innerHTML = '<div><video></video></div>';
    expect(isExcludedFromCapture(document.querySelector('video')!, [])).toBe(false);
  });

  it('ignores a skip attribute that is present but not "true"', () => {
    document.body.innerHTML = '<div data-traceitx-skip-capture="false"><video></video></div>';
    expect(isExcludedFromCapture(document.querySelector('video')!)).toBe(false);
  });
});

/** Minimal stand-in for a canvas whose readback may be poisoned. */
function stubCanvas(opts: { tainted?: boolean } = {}): HTMLCanvasElement {
  const ctx = {
    drawImage: () => undefined,
    getImageData: () => {
      if (opts.tainted) {
        const err = new Error('Tainted canvases may not be exported.');
        err.name = 'SecurityError';
        throw err;
      }
      return { data: new Uint8ClampedArray(4) };
    },
  };
  return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

describe('grabLiveFrame', () => {
  const video = (readyState: number, w = 640, h = 360) =>
    ({ readyState, videoWidth: w, videoHeight: h }) as unknown as HTMLVideoElement;

  it('returns null without touching the canvas when there is no frame', () => {
    const createElement = vi.spyOn(document, 'createElement');
    expect(grabLiveFrame(video(0), 320, 180)).toBeNull();
    expect(createElement).not.toHaveBeenCalled();
  });

  it('returns null for a non-positive budget', () => {
    expect(grabLiveFrame(video(4), 0, 180)).toBeNull();
    expect(grabLiveFrame(video(4), 320, -5)).toBeNull();
  });

  it('caps the bitmap to the on-screen footprint', () => {
    // A 4K stream in a small plate must not allocate a 4K canvas.
    const canvas = stubCanvas();
    vi.spyOn(document, 'createElement').mockReturnValue(canvas);
    expect(grabLiveFrame(video(4, 3840, 2160), 320, 180)).toBe(canvas);
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(180);
  });

  it('preserves the intrinsic aspect ratio rather than stretching to the box', () => {
    // A 16:9 frame in a 1:1 box must stay 16:9 — the stand-in letterboxes it
    // via background-size, mirroring object-fit. Stretching here would distort
    // every video whose box is a different shape from its content.
    const canvas = stubCanvas();
    vi.spyOn(document, 'createElement').mockReturnValue(canvas);
    grabLiveFrame(video(4, 1920, 1080), 400, 400);
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(225);
  });

  it('never upscales past the source resolution', () => {
    const canvas = stubCanvas();
    vi.spyOn(document, 'createElement').mockReturnValue(canvas);
    grabLiveFrame(video(4, 100, 50), 1000, 1000);
    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(50);
  });

  it('discards a canvas whose readback is tainted', () => {
    // THE LOAD-BEARING CASE. drawImage of a cross-origin video SUCCEEDS and
    // poisons the canvas; the taint only surfaces on read. Returning this
    // canvas would let toDataURL throw during stand-in construction and cost
    // the entire screenshot rather than this one video.
    vi.spyOn(document, 'createElement').mockReturnValue(stubCanvas({ tainted: true }));
    expect(grabLiveFrame(video(4), 320, 180)).toBeNull();
  });
});

describe('loadPoster', () => {
  it('resolves null once the deadline passes without a load event', async () => {
    vi.useFakeTimers();
    const pending = loadPoster('https://example.invalid/poster.jpg', 50);
    await vi.advanceTimersByTimeAsync(51);
    await expect(pending).resolves.toBeNull();
    vi.useRealTimers();
  });

  it('defaults to the documented budget', () => {
    expect(POSTER_LOAD_TIMEOUT_MS).toBe(600);
  });
});

describe('backgroundSizeForObjectFit', () => {
  it('maps each object-fit onto the background-size that reproduces it', () => {
    expect(backgroundSizeForObjectFit('fill')).toBe('100% 100%');
    expect(backgroundSizeForObjectFit('cover')).toBe('cover');
    expect(backgroundSizeForObjectFit('none')).toBe('auto');
    expect(backgroundSizeForObjectFit('contain')).toBe('contain');
    // <video> defaults to contain, so an unknown/empty value must too.
    expect(backgroundSizeForObjectFit('scale-down')).toBe('contain');
    expect(backgroundSizeForObjectFit('')).toBe('contain');
  });
});

describe('buildStandIn', () => {
  it('promotes an inline video to inline-block so its box survives', () => {
    // <video> is a REPLACED inline element and therefore has a box; a plain
    // inline <div> does not, so copying `display: inline` verbatim would make
    // width/height inert and collapse the stand-in — reintroducing the exact
    // layout bug this whole mechanism exists to fix.
    document.body.innerHTML = '<video style="width: 320px; height: 180px"></video>';
    const video = document.querySelector('video')!;
    const standIn = buildStandIn(video, { frame: null, placeholder: false });
    expect(standIn.style.display).toBe('inline-block');
    expect(standIn.style.width).toBe('320px');
    expect(standIn.style.height).toBe('180px');
    expect(standIn.style.boxSizing).toBe('border-box');
    expect(standIn.getAttribute(STAND_IN_ATTR)).toBe('true');
  });

  it('copies visibility so a hidden video cannot leak its frame', () => {
    // The stand-in is what gets rendered, so if it were visible while the
    // video was not, capture would EXPOSE content the page had hidden.
    document.body.innerHTML = '<video style="visibility: hidden"></video>';
    const standIn = buildStandIn(document.querySelector('video')!, {
      frame: null,
      placeholder: true,
    });
    expect(standIn.style.visibility).toBe('hidden');
  });

  it('paints a placeholder only when asked', () => {
    document.body.innerHTML = '<video></video>';
    const video = document.querySelector('video')!;
    const withGlyph = buildStandIn(video, { frame: null, placeholder: true });
    expect(withGlyph.style.backgroundImage).toContain('svg');

    // Excluded videos get an EMPTY box: a placeholder glyph would advertise
    // that something was deliberately hidden here.
    const empty = buildStandIn(video, { frame: null, placeholder: false });
    expect(empty.style.backgroundImage).toBe('');
    expect(empty.style.backgroundColor).toBe('');
  });
});

describe('installVideoStandIns', () => {
  it('does nothing when there are no videos', async () => {
    document.body.innerHTML = '<div><p>no media here</p></div>';
    const restore = await installVideoStandIns(document.body, { pixelRatio: 1 });
    restore();
    expect(document.querySelectorAll(`[${STAND_IN_ATTR}]`)).toHaveLength(0);
  });

  it('inserts a stand-in beside the video and hides the video', async () => {
    document.body.innerHTML = '<div><video></video></div>';
    const video = document.querySelector('video')!;
    withBox(video);

    const restore = await installVideoStandIns(document.body, { pixelRatio: 1 });

    const standIn = document.querySelector(`[${STAND_IN_ATTR}]`);
    expect(standIn).not.toBeNull();
    expect(video.nextElementSibling).toBe(standIn);
    expect(video.style.display).toBe('none');
    // Never detached: pulling a playing element out of the document resets it,
    // which for an MSE/HLS stream tears down the live session.
    expect(video.isConnected).toBe(true);

    restore();
    expect(document.querySelectorAll(`[${STAND_IN_ATTR}]`)).toHaveLength(0);
    expect(video.style.display).toBe('');
    expect(video.isConnected).toBe(true);
  });

  it('restores a pre-existing inline display value exactly', async () => {
    // The customer's own inline style must come back byte-for-byte, including
    // its priority — we are borrowing their DOM, not rewriting it.
    document.body.innerHTML = '<video style="display: flex !important"></video>';
    const video = document.querySelector('video')!;
    withBox(video);

    const restore = await installVideoStandIns(document.body, { pixelRatio: 1 });
    expect(video.style.display).toBe('none');
    restore();

    expect(video.style.getPropertyValue('display')).toBe('flex');
    expect(video.style.getPropertyPriority('display')).toBe('important');
  });

  it('is idempotent, so a double teardown cannot strip the page twice', async () => {
    document.body.innerHTML = '<video></video>';
    const video = document.querySelector('video')!;
    withBox(video);
    const restore = await installVideoStandIns(document.body, { pixelRatio: 1 });
    restore();
    restore();
    expect(document.querySelectorAll(`[${STAND_IN_ATTR}]`)).toHaveLength(0);
    expect(video.style.display).toBe('');
  });

  it('gives an excluded video a box but no content', async () => {
    // Regression guard for a privacy leak: the stand-in must hold the layout
    // open without reintroducing the frame the customer excluded.
    document.body.innerHTML = '<div data-traceitx-skip-capture="true"><video></video></div>';
    withBox(document.querySelector('video')!);

    const restore = await installVideoStandIns(document.body, { pixelRatio: 1 });
    const standIn = document.querySelector(`[${STAND_IN_ATTR}]`) as HTMLElement;
    expect(standIn).not.toBeNull();
    expect(standIn.style.width).toBe('320px');
    expect(standIn.style.backgroundImage).toBe('');
    restore();
  });

  it('skips zero-area videos, which hold no layout open', async () => {
    document.body.innerHTML = '<video></video>';
    withBox(document.querySelector('video')!, { width: 0, height: 0 });
    const restore = await installVideoStandIns(document.body, { pixelRatio: 1 });
    expect(document.querySelectorAll(`[${STAND_IN_ATTR}]`)).toHaveLength(0);
    restore();
  });

  it('loads posters concurrently, not one after another', async () => {
    // Guards the N x timeout regression: with sequential awaits the second
    // poster's timer is only created after the first resolves, so a single
    // advance past the budget would leave the promise pending. A page holding
    // several dead players with posters must cost ONE timeout, not one each.
    vi.useFakeTimers();
    document.body.innerHTML = '<video poster="/a.jpg"></video><video poster="/b.jpg"></video>';
    for (const v of Array.from(document.querySelectorAll('video'))) withBox(v);

    const pending = installVideoStandIns(document.body, { pixelRatio: 1, posterTimeoutMs: 500 });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(501);
    expect(settled).toBe(true);
    (await pending)();
    vi.useRealTimers();
  });

  it('uses the poster when the frame is unreadable', async () => {
    document.body.innerHTML = '<video poster="/poster.jpg"></video>';
    withBox(document.querySelector('video')!);

    // jsdom never actually fetches, so stand in an Image that reports success.
    class LoadingImage {
      crossOrigin = '';
      decoding = '';
      naturalWidth = 640;
      src = '';
      #handlers: Record<string, () => void> = {};
      addEventListener(type: string, fn: () => void): void {
        this.#handlers[type] = fn;
        if (type === 'load') queueMicrotask(() => this.#handlers.load?.());
      }
    }
    vi.stubGlobal('Image', LoadingImage);

    const restore = await installVideoStandIns(document.body, { pixelRatio: 1 });
    const standIn = document.querySelector(`[${STAND_IN_ATTR}]`) as HTMLElement;
    // Poster path taken rather than the placeholder glyph.
    expect(standIn.style.backgroundImage).not.toContain('svg');
    expect(standIn.style.backgroundColor).toBe('');
    restore();
  });
});

describe('untransformedBorderBox', () => {
  const computed = (over: Record<string, string>): CSSStyleDeclaration =>
    ({
      width: '100px',
      height: '50px',
      boxSizing: 'content-box',
      paddingLeft: '0px',
      paddingRight: '0px',
      paddingTop: '0px',
      paddingBottom: '0px',
      borderLeftWidth: '0px',
      borderRightWidth: '0px',
      borderTopWidth: '0px',
      borderBottomWidth: '0px',
      ...over,
    }) as unknown as CSSStyleDeclaration;

  const video = (offset = { w: 0, h: 0 }) =>
    ({ offsetWidth: offset.w, offsetHeight: offset.h }) as unknown as HTMLVideoElement;

  it('ignores transforms entirely', () => {
    // THE REGRESSION THIS PINS DOWN: getBoundingClientRect would report 200x100
    // for a scale(2) video. Feeding that back as width/height while ALSO
    // copying the transform renders it at 400x200 — the stand-in must be sized
    // in layout space, where the transform has not been applied yet.
    const box = untransformedBorderBox(video(), computed({ transform: 'matrix(2, 0, 0, 2, 0, 0)' }));
    expect(box).toEqual({ width: 100, height: 50 });
  });

  it('adds padding and border back for a content-box element', () => {
    const box = untransformedBorderBox(
      video(),
      computed({ paddingLeft: '4px', paddingRight: '6px', borderTopWidth: '2px' }),
    );
    expect(box).toEqual({ width: 110, height: 52 });
  });

  it('takes the resolved width as-is when the element is border-box sized', () => {
    const box = untransformedBorderBox(
      video(),
      computed({ boxSizing: 'border-box', paddingLeft: '20px' }),
    );
    expect(box).toEqual({ width: 100, height: 50 });
  });

  it('falls back to offsetWidth/Height when width does not resolve to a length', () => {
    const box = untransformedBorderBox(video({ w: 321, h: 181 }), computed({ width: 'auto' }));
    expect(box).toEqual({ width: 321, height: 181 });
  });

  it('falls back when there is no computed style at all', () => {
    expect(untransformedBorderBox(video({ w: 12, h: 34 }), undefined)).toEqual({
      width: 12,
      height: 34,
    });
  });
});

describe('paintsNothing', () => {
  const style = (over: Record<string, string>): CSSStyleDeclaration => {
    const map: Record<string, string> = {
      'content-visibility': 'visible',
      visibility: 'visible',
      opacity: '1',
      clip: 'auto',
      ...over,
    };
    return {
      ...map,
      getPropertyValue: (name: string) => map[name] ?? '',
    } as unknown as CSSStyleDeclaration;
  };

  it('flags content-visibility: hidden', () => {
    // THE LEAK THIS PINS DOWN. Such a video keeps its full layout box and
    // paints nothing — but the stand-in shows the frame as its own BACKGROUND,
    // which content-visibility does not suppress, so copying the property
    // across is not enough. Measured in Chromium before this check: the whole
    // frame (19,968 px of it) appeared in the capture.
    expect(paintsNothing(style({ 'content-visibility': 'hidden' }))).toBe(true);
    expect(paintsNothing(style({ 'content-visibility': 'auto' }))).toBe(false);
  });

  it('flags hidden and collapsed visibility', () => {
    expect(paintsNothing(style({ visibility: 'hidden' }))).toBe(true);
    expect(paintsNothing(style({ visibility: 'collapse' }))).toBe(true);
  });

  it('flags a fully transparent element', () => {
    expect(paintsNothing(style({ opacity: '0' }))).toBe(true);
    expect(paintsNothing(style({ opacity: '0.01' }))).toBe(false);
  });

  it('flags a fully collapsed legacy clip', () => {
    expect(paintsNothing(style({ clip: 'rect(0px, 0px, 0px, 0px)' }))).toBe(true);
    expect(paintsNothing(style({ clip: 'rect(0px, 100px, 50px, 0px)' }))).toBe(false);
  });

  it('passes an ordinary visible element', () => {
    expect(paintsNothing(style({}))).toBe(false);
  });

  it('says nothing when there is no computed style to inspect', () => {
    expect(paintsNothing(undefined)).toBe(false);
  });
});

describe('installVideoStandIns — paint suppression', () => {
  it('reads no frame for a video the page is not painting', async () => {
    document.body.innerHTML = '<video style="content-visibility: hidden"></video>';
    const video = document.querySelector('video')!;
    withBox(video);
    // If a frame were read, this would be the call that does it.
    const createElement = vi.spyOn(document, 'createElement');

    const restore = await installVideoStandIns(document.body, { pixelRatio: 1 });
    const standIn = document.querySelector(`[${STAND_IN_ATTR}]`) as HTMLElement;

    expect(standIn).not.toBeNull();
    // Box held open...
    expect(standIn.style.width).toBe('320px');
    // ...but nothing painted into it, and no placeholder either: a glyph would
    // advertise that something was deliberately hidden here.
    expect(standIn.style.backgroundImage).toBe('');
    expect(standIn.style.backgroundColor).toBe('');
    expect(createElement).not.toHaveBeenCalledWith('canvas');
    restore();
  });
});

describe('intersectsViewport', () => {
  it('accepts anything touching the viewport', () => {
    expect(intersectsViewport({ x: 10, y: 10, width: 100, height: 100 }, 1280, 720)).toBe(true);
    expect(intersectsViewport({ x: -50, y: 10, width: 100, height: 100 }, 1280, 720)).toBe(true);
    expect(intersectsViewport({ x: 1250, y: 10, width: 100, height: 100 }, 1280, 720)).toBe(true);
  });

  it('rejects anything wholly outside it', () => {
    expect(intersectsViewport({ x: -200, y: 10, width: 100, height: 100 }, 1280, 720)).toBe(false);
    expect(intersectsViewport({ x: 10, y: 900, width: 100, height: 100 }, 1280, 720)).toBe(false);
  });

  it('rejects degenerate rects', () => {
    expect(intersectsViewport({ x: 0, y: 0, width: 0, height: 100 }, 1280, 720)).toBe(false);
  });
});

describe('installVideoStandIns — overlapping captures', () => {
  it('reference-counts a shared video instead of nesting stand-ins', async () => {
    // THE WORST OUTCOME IN THIS FILE if unhandled: the second capture reads the
    // FIRST one's `display: none` as the video's original state, and its
    // teardown then "restores" the video to hidden — leaving the customer with
    // a permanently invisible video long after the report was sent. Captures do
    // overlap: the companion bridge captures independently of the reporter.
    document.body.innerHTML = '<video style="display: block"></video>';
    const video = document.querySelector('video')! as HTMLVideoElement;
    withBox(video);

    const restoreA = await installVideoStandIns(document.body, { pixelRatio: 1 });
    const restoreB = await installVideoStandIns(document.body, { pixelRatio: 1 });

    // One stand-in, not two stacked.
    expect(document.querySelectorAll(`[${STAND_IN_ATTR}]`)).toHaveLength(1);
    expect(hasActiveStandIn(video)).toBe(true);

    // The first to finish must NOT restore while the other is still capturing.
    restoreA();
    expect(video.style.display).toBe('none');
    expect(document.querySelectorAll(`[${STAND_IN_ATTR}]`)).toHaveLength(1);

    // The last one out restores the original value, not the borrowed one.
    restoreB();
    expect(video.style.getPropertyValue('display')).toBe('block');
    expect(document.querySelectorAll(`[${STAND_IN_ATTR}]`)).toHaveLength(0);
    expect(hasActiveStandIn(video)).toBe(false);
  });
});

describe('installVideoStandIns — cost ceilings', () => {
  it('holds an off-screen video\'s box open without reading its frame', async () => {
    // The capture is cropped to the viewport, so an off-screen video cannot
    // contribute a pixel — but one above the fold still holds layout open for
    // what IS visible, so the box must survive.
    document.body.innerHTML = '<video></video>';
    const video = document.querySelector('video')!;
    withBox(video, { x: 0, y: 99_999, width: 320, height: 180 });
    const createElement = vi.spyOn(document, 'createElement');

    const restore = await installVideoStandIns(document.body, { pixelRatio: 1 });
    const standIn = document.querySelector(`[${STAND_IN_ATTR}]`) as HTMLElement;

    expect(standIn).not.toBeNull();
    expect(standIn.style.width).toBe('320px');
    expect(standIn.style.backgroundImage).toBe('');
    expect(createElement).not.toHaveBeenCalledWith('canvas');
    restore();
  });

  it('shrinks a frame to fit the remaining pixel budget rather than refusing it', () => {
    // A dozen HD players would otherwise allocate every canvas synchronously,
    // before withDeadline has anything to time out — the tab dies instead of
    // degrading. A softer frame is the better failure.
    const canvas = stubCanvas();
    vi.spyOn(document, 'createElement').mockReturnValue(canvas);
    const video = { readyState: 4, videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement;

    grabLiveFrame(video, 1920, 1080, 1920 * 1080);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(1920 * 1080);

    grabLiveFrame(video, 1920, 1080, 100_000);
    // The ceiling is approximate: rounding each dimension can land a fraction
    // of a pixel row over, which does not matter for a guard that exists to
    // stop hundred-megabyte allocations. A 20x reduction is the point.
    expect(canvas.width * canvas.height).toBeLessThan(105_000);
    expect(canvas.width).toBeGreaterThan(0);
  });

  it('refuses a frame outright once the budget is gone', () => {
    const video = { readyState: 4, videoWidth: 640, videoHeight: 360 } as HTMLVideoElement;
    const createElement = vi.spyOn(document, 'createElement');
    expect(grabLiveFrame(video, 640, 360, 0)).toBeNull();
    expect(createElement).not.toHaveBeenCalled();
  });
});

describe('collectVideos', () => {
  it('finds videos inside open shadow roots', () => {
    // Both capture libraries walk into open shadow roots, so a video in a
    // web-component player was being filtered out with nothing standing in for
    // it — collapsing the component's layout. querySelectorAll alone cannot
    // see it.
    document.body.innerHTML = '<div id="host"></div><video id="light"></video>';
    const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<section><video id="shadowed"></video></section>';

    const ids = collectVideos(document.body).map((v) => v.id);
    expect(ids).toContain('light');
    expect(ids).toContain('shadowed');
  });

  it('descends through nested shadow roots', () => {
    document.body.innerHTML = '<div id="outer"></div>';
    const outer = document.getElementById('outer')!.attachShadow({ mode: 'open' });
    outer.innerHTML = '<div id="inner"></div>';
    const inner = outer.getElementById('inner')!.attachShadow({ mode: 'open' });
    inner.innerHTML = '<video id="deep"></video>';

    expect(collectVideos(document.body).map((v) => v.id)).toEqual(['deep']);
  });

  it('includes the root itself when the root IS a video', () => {
    document.body.innerHTML = '<video id="root"></video>';
    const video = document.getElementById('root')!;
    expect(collectVideos(video as unknown as ParentNode).map((v) => v.id)).toEqual(['root']);
  });
});

describe('isExcludedFromCapture — shadow boundaries', () => {
  it('honours an opt-out placed on the shadow host', () => {
    // The customer often cannot reach the video inside a third-party web
    // component; the host is the only element they can tag, so the walk has to
    // cross the boundary via getRootNode().host — parentElement stops dead at
    // a shadow root's top-level children.
    document.body.innerHTML = '<div id="host" data-traceitx-skip-capture="true"></div>';
    const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<video></video>';
    expect(isExcludedFromCapture(shadow.querySelector('video')!)).toBe(true);
  });

  it('does not exclude a shadow video whose host is untagged', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<video></video>';
    expect(isExcludedFromCapture(shadow.querySelector('video')!)).toBe(false);
  });
});

describe('installVideoStandIns — suppression is monotonic across captures', () => {
  it('strips a frame when an overlapping capture considers the video sensitive', async () => {
    // The companion bridge captures with NO masking while the reporter captures
    // WITH it. If the unmasked capture wins the race to build the stand-in, the
    // masked one would otherwise adopt a frame-bearing stand-in and carry the
    // sensitive frame straight into its report.
    document.body.innerHTML = '<div id="wrap"><video></video></div>';
    const video = document.querySelector('video')! as HTMLVideoElement;
    withBox(video);
    // Give the first capture a readable frame to put on the stand-in.
    const canvas = stubCanvas();
    (canvas as unknown as { toDataURL: () => string }).toDataURL = () => 'data:image/jpeg;base64,AA';
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
      tag === 'canvas'
        ? canvas
        : Object.getPrototypeOf(document).createElement.call(document, tag)) as never);
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
    Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 360, configurable: true });

    const restoreUnmasked = await installVideoStandIns(document.body, { pixelRatio: 1 });
    const standIn = document.querySelector(`[${STAND_IN_ATTR}]`) as HTMLElement;
    expect(standIn.style.backgroundImage).not.toBe('');

    // Second, overlapping capture — this one masks the video.
    const restoreMasked = await installVideoStandIns(document.body, {
      pixelRatio: 1,
      maskTargets: [document.getElementById('wrap')!],
    });
    expect(standIn.style.backgroundImage).toBe('');

    restoreMasked();
    restoreUnmasked();
  });
});

describe('clipHidesEverything', () => {
  it('flags the .sr-only rectangle', () => {
    // `clip: rect(0 0 0 0)` on an absolutely-positioned element is how the
    // visually-hidden utility in Bootstrap, Tailwind and most design systems
    // works. The layout box stays full size, so nothing else here notices.
    expect(clipHidesEverything('rect(0px, 0px, 0px, 0px)')).toBe(true);
    expect(clipHidesEverything('rect(0px 0px 0px 0px)')).toBe(true);
    expect(clipHidesEverything('rect(10px, 5px, 20px, 5px)')).toBe(true);
  });

  it('leaves a real clip alone', () => {
    expect(clipHidesEverything('rect(0px, 100px, 50px, 0px)')).toBe(false);
    expect(clipHidesEverything('auto')).toBe(false);
    expect(clipHidesEverything(undefined)).toBe(false);
    expect(clipHidesEverything('')).toBe(false);
  });

  it('treats an auto edge as unclipped on that side', () => {
    expect(clipHidesEverything('rect(0px, auto, 0px, 0px)')).toBe(false);
  });

  it('ignores anything it cannot parse rather than guessing', () => {
    expect(clipHidesEverything('inset(50%)')).toBe(false);
    expect(clipHidesEverything('rect(0px, 0px)')).toBe(false);
  });
});

describe('installVideoStandIns — respects the application\'s own writes', () => {
  it('leaves display alone when the app restyled the video mid-capture', async () => {
    // A capture can be in flight for seconds. If React re-renders the video or
    // a player toggles fullscreen in that window, writing the pre-capture value
    // back would silently revert the application's own newer state.
    document.body.innerHTML = '<video style="display: block"></video>';
    const video = document.querySelector('video')! as HTMLVideoElement;
    withBox(video);

    const restore = await installVideoStandIns(document.body, { pixelRatio: 1 });
    expect(video.style.display).toBe('none');

    // The application takes ownership back while we are still capturing.
    video.style.setProperty('display', 'flex');
    restore();

    expect(video.style.getPropertyValue('display')).toBe('flex');
  });

  it('still restores when nothing else touched it', async () => {
    document.body.innerHTML = '<video style="display: block"></video>';
    const video = document.querySelector('video')! as HTMLVideoElement;
    withBox(video);
    const restore = await installVideoStandIns(document.body, { pixelRatio: 1 });
    restore();
    expect(video.style.getPropertyValue('display')).toBe('block');
  });
});

describe('buildStandIn — slot assignment', () => {
  it('inherits a named slot so the component still lays the box out', () => {
    // <video slot="media"> renders wherever the shadow root's matching <slot>
    // puts it. A stand-in without the attribute falls to the default slot, or
    // nowhere, and the component's video box collapses.
    document.body.innerHTML = '<video slot="media" style="width:320px;height:180px"></video>';
    const standIn = buildStandIn(document.querySelector('video')!, {
      frame: null,
      placeholder: false,
    });
    expect(standIn.getAttribute('slot')).toBe('media');
  });

  it('adds no slot attribute when the video has none', () => {
    document.body.innerHTML = '<video style="width:320px;height:180px"></video>';
    const standIn = buildStandIn(document.querySelector('video')!, {
      frame: null,
      placeholder: false,
    });
    expect(standIn.hasAttribute('slot')).toBe(false);
  });
});
