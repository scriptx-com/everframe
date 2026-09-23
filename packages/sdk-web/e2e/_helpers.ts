// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Shared machinery for the two mount paths this package ships, so both are
// held to ONE calibrated standard rather than two copies that can drift:
//
//   e2e/fixtures/plain.html       the ESM entry (`dist/index.js`) + an import
//                                 map standing in for a consumer's bundler.
//   e2e/fixtures/script-tag.html  the browser entry (`dist/browser/index.js`)
//                                 imported by URL from one
//                                 <script type="module"> — no import map, no
//                                 bundler, no build step.
//
// Not named `*.spec.ts`, so Playwright's testMatch does not collect it.
import { expect, type Page } from '@playwright/test';

export const ESM_FIXTURE = '/e2e/fixtures/plain.html';
export const SCRIPT_TAG_FIXTURE = '/e2e/fixtures/script-tag.html';

/**
 * The ingest origin is baked into dist/ at build time (tsup `define`), so an
 * un-stubbed run reaches the real everframe.dev for /api/config and the reply
 * poll — making a local e2e depend on the internet and on production's health.
 * Matched by PATH rather than origin so the stub holds whichever URL the local
 * dist/ happens to carry; neither fixture requests anything under /api/. 404 is
 * what an unrecognised key gets there anyway, and every one of those paths is
 * fail-closed by design, so the reporter behaves identically.
 */
export async function stubIngestApi(page: Page): Promise<void> {
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
  );
}

/** Evaluated in-page: has the reporter dialog committed inside the shadow root? */
export function dialogPresent(): boolean {
  return !!document.getElementById('everframe-host')?.shadowRoot?.querySelector('[role=dialog]');
}

export async function openReporter(page: Page): Promise<void> {
  await page.click('#report');
  await page.waitForFunction(dialogPresent, null, { timeout: 30_000 });
}

/**
 * Assert the reporter's own chrome never reaches a capture taken while it is
 * on screen.
 *
 * The page must already be loaded with the reporter CLOSED — the baseline is
 * taken first, through the same adapter seam the dialog captures through, so
 * both images come off one renderer with one set of options and any difference
 * between them is the chrome and nothing else.
 *
 * CALIBRATED, not assumed. Re-running this exact flow with every
 * `data-everframe-skip-capture` attribute stripped off the host and the portal
 * roots measures 33.6% / 35.3% / 35.5% of pixels differing on
 * chromium / firefox / webkit, against 0 clean — so the 1% threshold is ~35x
 * clear of the regression it guards.
 *
 * Three separate things could make a 0 here meaningless, and each has a guard:
 *   - the reporter not actually being on screen  -> `chromeOnScreen`
 *   - the capture degrading to the 1x1 transparent placeholder (what happens
 *     when a bare dynamic specifier fails to resolve) -> `total`
 *   - the strip appending elsewhere, so the "second" shot is really the
 *     chrome-free auto capture -> `newShotAppended`, which pins the assumption
 *     that `shots[last]` is the Add capture.
 */
export async function expectCaptureExcludesReporterChrome(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as {
      __everframe: { __adapter: { captureScreenshot(): Promise<{ blob: Blob }> } };
      __baselineShot?: Blob;
    };
    w.__baselineShot = (await w.__everframe.__adapter.captureScreenshot()).blob;
  });

  await page.click('#report');
  await page.waitForFunction(
    () =>
      (document.getElementById('everframe-host')?.shadowRoot?.querySelectorAll(
        'img.everframe-shot-thumb-img',
      ).length ?? 0) > 0,
    null,
    { timeout: 30_000 },
  );

  const diff = await page.evaluate(async () => {
    const sr = document.getElementById('everframe-host')!.shadowRoot!;
    const baseline = (window as unknown as { __baselineShot: Blob }).__baselineShot;

    type Shot = { w: number; h: number; data: Uint8ClampedArray };
    const toPixels = async (blob: Blob): Promise<Shot> => {
      const bmp = await createImageBitmap(blob);
      // OffscreenCanvas is not universal across the three engines; a detached
      // <canvas> is, and is never attached to the document so it cannot
      // perturb a later capture.
      let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
      if (typeof OffscreenCanvas !== 'undefined') {
        ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
      } else {
        const c = document.createElement('canvas');
        c.width = bmp.width;
        c.height = bmp.height;
        ctx = c.getContext('2d')!;
      }
      ctx.drawImage(bmp, 0, 0);
      return {
        w: bmp.width,
        h: bmp.height,
        data: ctx.getImageData(0, 0, bmp.width, bmp.height).data,
      };
    };

    /**
     * Is the reporter's scrim mounted, painted and over the middle of the
     * viewport? Sampled either side of the capture, so the diff below cannot
     * pass because the dialog quietly was not there.
     */
    const chromeOverCentre = (): boolean => {
      const backdrop = sr.querySelector('.everframe-backdrop');
      if (!backdrop || getComputedStyle(backdrop).visibility === 'hidden') return false;
      const r = backdrop.getBoundingClientRect();
      return (
        r.left <= window.innerWidth / 2 &&
        r.right >= window.innerWidth / 2 &&
        r.top <= window.innerHeight / 2 &&
        r.bottom >= window.innerHeight / 2
      );
    };

    const waitFor = <T,>(probe: () => T | null, ms: number, what: string): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const started = Date.now();
        const t = setInterval(() => {
          const v = probe();
          if (v) {
            clearInterval(t);
            resolve(v);
          } else if (Date.now() - started > ms) {
            clearInterval(t);
            reject(new Error(`timed out waiting for ${what}`));
          }
        }, 100);
      });

    const chromeBefore = chromeOverCentre();
    const shotsBefore = Array.from(
      sr.querySelectorAll<HTMLImageElement>('img.everframe-shot-thumb-img'),
    );

    // "Add" opens the area-capture overlay; take the whole viewport so the
    // capture runs with the reporter mounted and on screen.
    (sr.querySelector('[data-testid=screenshot-add]') as HTMLButtonElement).click();
    const full = await waitFor(
      () => sr.querySelector('[data-testid=area-capture-full]') as HTMLButtonElement | null,
      10_000,
      'the area-capture overlay',
    );
    full.click();
    await waitFor(
      () =>
        sr.querySelectorAll('img.everframe-shot-thumb-img').length > shotsBefore.length ? true : null,
      25_000,
      'the second screenshot',
    );
    const chromeAfter = chromeOverCentre();

    const shotsAfter = Array.from(
      sr.querySelectorAll<HTMLImageElement>('img.everframe-shot-thumb-img'),
    );
    const newest = shotsAfter[shotsAfter.length - 1]!;
    const withDialogOpen = await toPixels(await (await fetch(newest.src)).blob());
    const closed = await toPixels(baseline);

    let differing = 0;
    const sameSize = closed.w === withDialogOpen.w && closed.h === withDialogOpen.h;
    if (sameSize) {
      for (let i = 0; i < closed.data.length; i += 4) {
        const d = Math.max(
          Math.abs(closed.data[i]! - withDialogOpen.data[i]!),
          Math.abs(closed.data[i + 1]! - withDialogOpen.data[i + 1]!),
          Math.abs(closed.data[i + 2]! - withDialogOpen.data[i + 2]!),
        );
        if (d > 12) differing++;
      }
    }
    return {
      chromeOnScreen: chromeBefore && chromeAfter,
      // The strip APPENDS, so the element just measured is the Add capture and
      // not the (chrome-free either way) auto capture taken at open. Prepending
      // would silently turn this whole assertion into a tautology.
      newShotAppended: !shotsBefore.includes(newest),
      sameSize,
      size: [closed.w, closed.h] as [number, number],
      total: closed.data.length / 4,
      differing,
    };
  });

  // eslint-disable-next-line no-console
  console.log('[capture-exclusion]', JSON.stringify(diff));

  // Without these three the diff below could read 0 for reasons that have
  // nothing to do with capture exclusion.
  expect(diff.chromeOnScreen, 'the reporter was not covering the page during the capture').toBe(
    true,
  );
  expect(diff.newShotAppended, 'the measured thumbnail is not the new Add capture').toBe(true);
  expect(diff.sameSize).toBe(true);
  expect(diff.total, 'the capture degraded to a placeholder').toBeGreaterThan(100_000);

  // The spike measured exactly 0 of 1,024,000 differing, and so does this.
  // Allow a hair of tolerance for font rasterisation across the three engines,
  // but nothing near the ~35% a captured backdrop produces.
  expect(diff.differing / diff.total).toBeLessThan(0.01);
}
