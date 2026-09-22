// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { test, expect, type Page } from '@playwright/test';

/**
 * Regression — a `<video>` on the page must not be able to wedge capture.
 *
 * THE BUG THIS PINS DOWN: `modern-screenshot`'s `cloneVideoElement` assigns
 * `clone.currentTime` and then awaits a `seeked` event with no timeout. When
 * the element's readyState is HAVE_NOTHING, the spec says seeking sets the
 * default playback start position and RETURNS — `seeked` never fires. The
 * promise stays pending forever.
 *
 * Forever is the important word. `captureScreenshot` wraps the call in
 * try/catch and `ReporterDialog` adds `.catch(() => null)`, but neither
 * rescues a promise that never settles, so the 1x1-PNG degrade path is
 * unreachable and the reporter sits on
 * "Capturing report context…" indefinitely.
 *
 * `/video` mounts four elements covering the distinct hazards (see that page
 * for the full reasoning): healthy same-origin, stalled (readyState 0 with no
 * error ever), cross-origin (taints a canvas), and bare (no src at all).
 *
 * These tests are deliberately blind to WHICH element hangs — they assert only
 * that capture finishes and that a readable frame survives. That keeps them
 * honest if a future capture-library swap moves the hazard around.
 */

/**
 * Deliberately ABOVE the SDK's own ceiling (`CAPTURE_DEADLINE_MS`, 10s), not a
 * tighter target racing it.
 *
 * What is under test is that capture SETTLES — before the fix it never did, and
 * the reporter spun forever. Asserting a tighter bound than the SDK promises
 * turns this into a performance test of whatever machine it runs on, and it
 * duly flaked in Firefox when three browser projects shared one dev server.
 * Twenty seconds still separates "bounded" from "never" beyond any doubt.
 */
const CAPTURE_BUDGET_MS = 20_000;

/**
 * Navigate to the video bench.
 *
 * `domcontentloaded`, NOT the default `load`: the stalled plate holds an open
 * media request for the lifetime of the page, and the document's `load` event
 * waits on outstanding subresource requests. Firefox honours that strictly and
 * never fires `load` here, so the default wait times out before a single
 * assertion runs (Chromium and WebKit happen not to block on media, which is
 * exactly the kind of difference that makes this worth stating).
 */
async function gotoVideoPage(page: Page): Promise<void> {
  await page.goto('/video', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('video-heading')).toBeVisible();

  // Wait for BOTH decodable plates, not just the healthy one. They are the two
  // that are supposed to reach readyState 4, and a plate still climbing when
  // the assertions run silently collapses into the readyState-0 case — which
  // is how WebKit briefly reported the cross-origin plate as merely
  // "not-ready" instead of exercising the canvas-taint path it exists for.
  // (The stalled and bare plates are never waited on: staying at readyState 0
  // forever is their entire purpose.)
  await page.waitForFunction(
    () =>
      ['video-healthy', 'video-crossorigin', 'video-inflow'].every(
        (id) =>
          (document.querySelector<HTMLVideoElement>(`video[data-testid="${id}"]`)?.readyState ??
            0) >= 2,
      ),
    undefined,
    { timeout: 15_000 },
  );
}

async function openReporterOnVideoPage(page: Page): Promise<void> {
  await gotoVideoPage(page);
  await page.getByTestId('traceitx-bubble').click();
  await expect(page.getByTestId('reporter-modal')).toBeVisible();
}

test('capture completes on a page containing hostile <video> elements', async ({ page }) => {
  await openReporterOnVideoPage(page);

  // The assertion that fails before the fix: capture never resolves, so the
  // pending notice stays up until Playwright's timeout.
  await expect(page.getByTestId('capture-pending')).toBeHidden({ timeout: CAPTURE_BUDGET_MS });

  // A thumbnail only appears once a real ScreenshotResult came back.
  await expect(page.getByTestId('annotate-open')).toBeVisible();
});

test('the four <video> plates are genuinely in their distinct hazard states', async ({ page }) => {
  await gotoVideoPage(page);

  // Guards the fixture itself. If a Next upgrade starts serving the stalled
  // route to completion, or the loopback-hostname swap stops being
  // cross-origin, the capture tests would still pass while testing nothing —
  // this test is what notices.
  const states = await page.evaluate(() => {
    const probe = (id: string) => {
      const v = document.querySelector<HTMLVideoElement>(`video[data-testid="${id}"]`);
      if (!v) return { id, present: false as const };
      let grab: 'frame-ok' | 'tainted' | 'not-ready';
      try {
        if (v.readyState < 2 || !v.videoWidth) {
          grab = 'not-ready';
        } else {
          const c = document.createElement('canvas');
          c.width = v.videoWidth;
          c.height = v.videoHeight;
          c.getContext('2d')?.drawImage(v, 0, 0);
          c.toDataURL();
          grab = 'frame-ok';
        }
      } catch {
        grab = 'tainted';
      }
      return { id, present: true as const, readyState: v.readyState, grab };
    };
    return ['video-healthy', 'video-stalled', 'video-crossorigin', 'video-bare'].map(probe);
  });

  expect(states).toEqual([
    { id: 'video-healthy', present: true, readyState: 4, grab: 'frame-ok' },
    { id: 'video-stalled', present: true, readyState: 0, grab: 'not-ready' },
    { id: 'video-crossorigin', present: true, readyState: 4, grab: 'tainted' },
    { id: 'video-bare', present: true, readyState: 0, grab: 'not-ready' },
  ]);
});

/**
 * Sample the CAPTURED PNG — the reporter's thumbnail `<img>`, which is an
 * object URL over the real `ScreenshotResult` blob at full resolution.
 *
 * Deliberately not the annotation Konva stage: that stage is several stacked
 * layer canvases scaled to fit the overlay, so `canvas.first()` is a small
 * transient layer rather than the screenshot, and any pixel count taken from
 * it measures the preview's scaling rather than the capture's content.
 *
 * Returns, per video plate, the share of that plate's own rect which is the
 * demo clip's blue vs. the placeholder's near-black — mapping viewport CSS px
 * to the capture's device px by `devicePixelRatio`, which is exactly the
 * transform `compositeVideoFrames` uses.
 */
async function sampleVideoPlates(page: Page): Promise<Record<string, { blue: number; dark: number }>> {
  return page.evaluate(async () => {
    const img = document.querySelector<HTMLImageElement>('.txx-annotate-thumb-img');
    if (!img) throw new Error('reporter thumbnail not found — capture did not produce a blob');
    await img.decode().catch(() => undefined);

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(img, 0, 0);

    const ratio = window.devicePixelRatio || 1;
    const out: Record<string, { blue: number; dark: number }> = {};

    for (const video of Array.from(document.querySelectorAll('video'))) {
      const id = video.dataset.testid;
      if (!id) continue;
      const r = video.getBoundingClientRect();
      const x = Math.round(r.x * ratio);
      const y = Math.round(r.y * ratio);
      const w = Math.round(r.width * ratio);
      const h = Math.round(r.height * ratio);
      if (w <= 0 || h <= 0 || x + w > canvas.width || y + h > canvas.height) continue;

      const { data } = ctx.getImageData(x, y, w, h);
      let blue = 0;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [red, green, bl, a] = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
        // Blue-dominant and clearly saturated — the demo clip's #0B6FA4, a hue
        // that appears nowhere in Elytra's parchment/amber palette, so this is
        // specifically evidence the VIDEO's content reached the PNG.
        if (a > 200 && bl > 90 && bl - red > 45 && green > red && bl > green) blue++;
        // The placeholder plate's exact fill (#1c2128). Matched tightly on
        // purpose: the plates' CSS letterbox is #20241c, which a loose
        // "is it dark" test cannot tell apart — and that would let this pass
        // whether or not a placeholder was ever drawn. The channels that
        // separate them are blue vs red (40 > 28 here, 28 < 32 there).
        if (
          a > 200 &&
          Math.abs(red - 0x1c) < 10 &&
          Math.abs(green - 0x21) < 10 &&
          Math.abs(bl - 0x28) < 10
        ) {
          dark++;
        }
      }
      const total = w * h;
      out[id] = { blue: blue / total, dark: dark / total };
    }
    return out;
  });
}

test('the healthy video contributes real pixels to the captured screenshot', async ({ page }) => {
  await openReporterOnVideoPage(page);
  await expect(page.getByTestId('capture-pending')).toBeHidden({ timeout: CAPTURE_BUDGET_MS });

  const plates = await sampleVideoPlates(page);

  // Skipping the video without compositing its frame back would leave this
  // plate flat #20241c (the CSS letterbox), so this is what separates "capture
  // no longer hangs" from "capture still shows the video".
  expect(plates['video-healthy']!.blue).toBeGreaterThan(0.9);
});

test('unreadable videos degrade to a placeholder, not a blank hole', async ({ page }) => {
  await openReporterOnVideoPage(page);
  await expect(page.getByTestId('capture-pending')).toBeHidden({ timeout: CAPTURE_BUDGET_MS });

  const plates = await sampleVideoPlates(page);

  // Cross-origin: the frame is there on screen but taints any canvas that
  // reads it, so it must come back as the placeholder rather than as pixels.
  // Asserting `blue` is near-zero is the part that would catch us shipping a
  // tainted-canvas read — the one mistake here that leaks nothing but breaks
  // every screenshot on the page.
  expect(plates['video-crossorigin']!.dark).toBeGreaterThan(0.8);
  expect(plates['video-crossorigin']!.blue).toBeLessThan(0.02);

  // Stalled: never had a frame at all.
  expect(plates['video-stalled']!.dark).toBeGreaterThan(0.8);
});

test('an in-flow video does not collapse the captured layout', async ({ page }) => {
  await gotoVideoPage(page);

  // The bench sits below the fold and the capture is cropped to the viewport,
  // so scroll it into view first. That also puts this assertion through the
  // scroll-offset half of the crop maths rather than only the trivial y=0 case.
  await page.getByTestId('flow-bench').scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);

  await page.getByTestId('traceitx-bubble').click();
  await expect(page.getByTestId('reporter-modal')).toBeVisible();
  await expect(page.getByTestId('capture-pending')).toBeHidden({ timeout: CAPTURE_BUDGET_MS });

  // THE REGRESSION THIS PINS DOWN: dropping <video> from the clone removes its
  // layout box, so everything below it renders too high. Measured on this very
  // markup before the fix, the marker moved up by 180px — the video's exact
  // height. The plates in the grid above cannot catch it, because their
  // aspect-ratio containers reserve the space regardless of the video.
  const result = await page.evaluate(async () => {
    const marker = document.querySelector<HTMLElement>('[data-testid="flow-marker"]');
    const img = document.querySelector<HTMLImageElement>('.txx-annotate-thumb-img');
    if (!marker || !img) throw new Error('marker or capture missing');
    await img.decode().catch(() => undefined);

    const ratio = window.devicePixelRatio || 1;
    const liveY = marker.getBoundingClientRect().y * ratio;

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(img, 0, 0);

    // Scan a column through the marker for its violet (#7c3aed), a hue used
    // nowhere else in Elytra's parchment/amber palette.
    const x = Math.round((marker.getBoundingClientRect().x + 8) * ratio);
    const column = ctx.getImageData(x, 0, 1, canvas.height).data;
    let capturedY = -1;
    for (let y = 0; y < canvas.height; y++) {
      const i = y * 4;
      if (
        Math.abs(column[i]! - 0x7c) < 24 &&
        Math.abs(column[i + 1]! - 0x3a) < 24 &&
        Math.abs(column[i + 2]! - 0xed) < 24
      ) {
        capturedY = y;
        break;
      }
    }
    return { liveY, capturedY, height: canvas.height };
  });

  expect(result.capturedY).toBeGreaterThanOrEqual(0);
  // A few px of slack for subpixel rounding and the documented clone drift;
  // the bug being guarded is an order of magnitude larger.
  expect(Math.abs(result.capturedY - result.liveY)).toBeLessThan(12);
});
