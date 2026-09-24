// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { test, expect } from '@playwright/test';

test('add screenshot via area select, then delete it', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('everframe-bubble').click();
  await expect(page.getByTestId('reporter-modal')).toBeVisible();
  await expect(page.getByTestId('capture-pending')).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId('screenshot-thumb-0')).toBeVisible();

  await page.getByTestId('screenshot-add').click();
  const overlay = page.getByTestId('area-capture-overlay');
  await expect(overlay).toBeVisible();

  // Drag a region on the page. Coordinates are VIEWPORT-space (the overlay's
  // rect is emitted as-is, no scroll offset added — capture is viewport-anchored)
  // and land well inside the default 1280x720 desktop viewport.
  await page.mouse.move(120, 160);
  await page.mouse.down();
  await page.mouse.move(420, 380, { steps: 5 });
  await page.mouse.up();

  await expect(page.getByTestId('screenshot-thumb-1')).toBeVisible({ timeout: 15_000 });
  await expect(overlay).toBeHidden();

  // Cropped shot has no ⊙ element-picker (manual source).
  await page.getByTestId('annotate-open').click();
  await expect(page.getByTestId('tool-select')).toHaveCount(0);
  await page.getByTestId('annotate-done').click();

  await page.getByTestId('screenshot-delete-1').click();
  await expect(page.getByTestId('screenshot-thumb-1')).toHaveCount(0);
});

test('Esc cancels area capture without adding', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('everframe-bubble').click();
  await expect(page.getByTestId('capture-pending')).toBeHidden({ timeout: 15_000 });
  await page.getByTestId('screenshot-add').click();
  await expect(page.getByTestId('area-capture-overlay')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('area-capture-overlay')).toBeHidden();
  await expect(page.getByTestId('reporter-modal')).toBeVisible();
  await expect(page.getByTestId('screenshot-thumb-1')).toHaveCount(0);
});

test.describe('area capture pads when the source bitmap is shorter than the viewport', () => {
  // Body content (~1613px) shorter than this viewport: the captured bitmap
  // renders shorter than the viewport, so a drag near the viewport bottom
  // extends PAST the bitmap's bottom edge. cropBlob must pad to the requested
  // size (white background), not silently clamp the selection's bottom off.
  test.use({ viewport: { width: 1280, height: 2000 } });

  test('drag past the rendered bitmap bottom keeps the requested dimensions', async ({
    page,
  }) => {
    await page.goto('/');
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    // Red marker inside the drag region (and inside rendered content) proves
    // the kept pixels sit at the correct offset — not just that the canvas
    // has the right size.
    await page.evaluate(() => {
      const el = document.createElement('div');
      el.id = 'pad-marker';
      el.style.position = 'absolute';
      el.style.left = '200px';
      el.style.top = '1790px';
      el.style.width = '100px';
      el.style.height = '40px';
      el.style.background = '#ff0000';
      el.style.zIndex = '999999';
      document.body.appendChild(el);
    });

    await page.getByTestId('everframe-bubble').click();
    await expect(page.getByTestId('reporter-modal')).toBeVisible();
    await expect(page.getByTestId('capture-pending')).toBeHidden({ timeout: 15_000 });
    await page.getByTestId('screenshot-add').click();
    await expect(page.getByTestId('area-capture-overlay')).toBeVisible();

    // Drag (180,1780) -> (330,1950): the bottom edge is ~75px below the
    // ~1875px-tall captured bitmap but well inside the 2000px viewport.
    await page.mouse.move(180, 1780);
    await page.mouse.down();
    await page.mouse.move(330, 1950, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByTestId('screenshot-thumb-1')).toBeVisible({ timeout: 15_000 });

    const m = await page.evaluate(async () => {
      const img = document.querySelector(
        '[data-testid="screenshot-thumb-1"] img',
      ) as HTMLImageElement;
      const resp = await fetch(img.src);
      const bitmap = await createImageBitmap(await resp.blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let redCount = 0;
      for (let y = 0; y < bitmap.height; y++) {
        for (let x = 0; x < bitmap.width; x++) {
          const i = (y * bitmap.width + x) * 4;
          const r = data[i]!;
          const g = data[i + 1]!;
          const b = data[i + 2]!;
          const a = data[i + 3]!;
          if (a > 200 && r > 180 && g < 80 && b < 80) {
            redCount++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      return { w: bitmap.width, h: bitmap.height, redCount, minX, minY, maxX, maxY };
    });

    // Output must match the DRAG dimensions (150x170 CSS px) at device scale,
    // not the bitmap-clamped remainder (±2px for dpr rounding).
    expect(Math.abs(m.w - 150 * dpr)).toBeLessThanOrEqual(2);
    expect(Math.abs(m.h - 170 * dpr)).toBeLessThanOrEqual(2);
    // Marker (page 200,1790 100x40) within drag origin (180,1780) would sit
    // at (20,10) — but this marker is ABSOLUTELY positioned (anchored to the
    // initial containing block), and the capture pipeline's clone-drift
    // compensation shifts the ICB-positioned layer by -8 CSS px (the
    // documented tradeoff in capture/screenshot.ts: in-flow content aligns
    // pixel-exactly; ICB-anchored positioned elements skew by the drift).
    // Expect the red box at (20-8, 10-8) = (12,2) x dpr.
    expect(m.redCount).toBeGreaterThan(0);
    expect(Math.abs(m.minX - 12 * dpr)).toBeLessThanOrEqual(2);
    expect(Math.abs(m.minY - 2 * dpr)).toBeLessThanOrEqual(2);
    expect(Math.abs(m.maxX - (111 * dpr + dpr - 1))).toBeLessThanOrEqual(2);
    expect(Math.abs(m.maxY - (41 * dpr + dpr - 1))).toBeLessThanOrEqual(2);
  });
});

test('area capture aligns IN-FLOW content pixel-exactly (clone-drift regression)', async ({
  page,
}) => {
  // Bug 3 round 3: modern-screenshot's clone resurrects the UA default body
  // margin (8px) — the page's `body { margin: 0 }` reset does not exist in
  // the clone — so ALL in-flow content rendered +8px down/right and crops
  // cut the bottom/right of the user's selection. The fix compensates the
  // viewport crop by the drift. Lock: outline an in-flow element (the hero
  // plate), area-select around it, and assert the outline lands at the
  // drag-relative position within ±2 device px.
  await page.goto('/');
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const card = await page.evaluate(() => {
    const el = document.querySelector('.hero-plate') as HTMLElement;
    el.style.outline = '6px solid #ff00ff';
    el.style.outlineOffset = '-6px';
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  });

  await page.getByTestId('everframe-bubble').click();
  await expect(page.getByTestId('reporter-modal')).toBeVisible();
  await expect(page.getByTestId('capture-pending')).toBeHidden({ timeout: 15_000 });
  await page.getByTestId('screenshot-add').click();
  await expect(page.getByTestId('area-capture-overlay')).toBeVisible();

  const sel = { x: card.left - 30, y: card.top - 30, w: card.width + 60, h: card.height + 90 };
  await page.mouse.move(sel.x, sel.y);
  await page.mouse.down();
  await page.mouse.move(sel.x + sel.w, sel.y + sel.h, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('screenshot-thumb-1')).toBeVisible({ timeout: 15_000 });

  const m = await page.evaluate(async () => {
    const img = document.querySelector(
      '[data-testid="screenshot-thumb-1"] img',
    ) as HTMLImageElement;
    const resp = await fetch(img.src);
    const bitmap = await createImageBitmap(await resp.blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let minX = Infinity;
    let minY = Infinity;
    let found = false;
    for (let y = 0; y < bitmap.height; y++) {
      for (let x = 0; x < bitmap.width; x++) {
        const i = (y * bitmap.width + x) * 4;
        if (data[i]! > 200 && data[i + 2]! > 200 && data[i + 1]! < 80) {
          found = true;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
        }
      }
    }
    return { found, minX, minY };
  });

  expect(m.found).toBe(true);
  // Outline top-left = card top-left (outline-offset -6 puts it inside the
  // border box). Drag-relative expected position: (30, 30) x dpr.
  expect(Math.abs(m.minX - 30 * dpr)).toBeLessThanOrEqual(2);
  expect(Math.abs(m.minY - 30 * dpr)).toBeLessThanOrEqual(2);
});

test('annotate editor upscales a small area-captured shot to fill the overlay (×4 cap)', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('everframe-bubble').click();
  await expect(page.getByTestId('reporter-modal')).toBeVisible();
  await expect(page.getByTestId('capture-pending')).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId('screenshot-thumb-0')).toBeVisible();

  await page.getByTestId('screenshot-add').click();
  const overlay = page.getByTestId('area-capture-overlay');
  await expect(overlay).toBeVisible();

  // A small ~150x120 CSS-px drag — well under AnnotateCanvas's overlay
  // container width, so the upscale path (scale = min(container/img.w, 4))
  // kicks in rather than the downscale-to-fit path.
  await page.mouse.move(120, 160);
  await page.mouse.down();
  await page.mouse.move(270, 280, { steps: 5 });
  await page.mouse.up();

  // The new shot becomes active automatically (ReporterDialog.handleAreaSelect).
  await expect(page.getByTestId('screenshot-thumb-1')).toBeVisible({ timeout: 15_000 });
  await expect(overlay).toBeHidden();

  const naturalWidth = await page.evaluate(() => {
    const img = document.querySelector(
      '[data-testid="screenshot-thumb-1"] img',
    ) as HTMLImageElement;
    return img.naturalWidth;
  });

  await page.getByTestId('annotate-open').click();
  await expect(page.getByTestId('annotate-overlay')).toBeVisible();

  const stageCanvas = page.getByTestId('annotate-canvas-stage').locator('canvas').first();
  const box = (await stageCanvas.boundingBox())!;

  expect(box.width).toBeGreaterThanOrEqual(naturalWidth * 2);
});

test('full-page capture appends up to the 5-shot cap, then hides the add tile', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('everframe-bubble').click();
  await expect(page.getByTestId('capture-pending')).toBeHidden({ timeout: 15_000 });
  for (let i = 1; i <= 4; i++) {
    await page.getByTestId('screenshot-add').click();
    await page.getByTestId('area-capture-full').click();
    await expect(page.getByTestId(`screenshot-thumb-${i}`)).toBeVisible({ timeout: 15_000 });
  }
  await expect(page.getByTestId('screenshot-add')).toHaveCount(0);
});
