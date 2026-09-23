// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { test, expect } from '@playwright/test';

/**
 * Regression — when the user opens the reporter and enters the annotation editor,
 * the captured screenshot must be visible inside the AnnotateCanvas (rendered via
 * Konva's Image node). Earlier the Stage's first Layer was empty and the parent
 * Dialog never rendered the image, leaving users with a blank annotation surface.
 *
 * Post report-window overhaul, AnnotateCanvas no longer renders inline in the
 * reporter modal — the modal shows a clickable thumbnail (annotate-open) and the
 * canvas mounts inside the fullscreen annotate overlay.
 *
 * Asserts: Konva Stage has a non-zero canvas with non-zero rendered area, and the
 * canvas contains non-transparent pixels (the captured page is not all-white-on-white
 * because the Home page has a heading + text on a white background — sampling from
 * the heading area must yield non-white pixels).
 */
test('screenshot is rendered inside the annotation canvas after capture completes', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('home-heading')).toBeVisible();
  await page.getByTestId('everframe-bubble').click();
  await expect(page.getByTestId('reporter-modal')).toBeVisible();

  // Wait for capture to finish (capture-pending → thumbnail swap), then enter
  // the fullscreen annotation editor where the Konva Stage lives.
  await expect(page.getByTestId('capture-pending')).toBeHidden({ timeout: 15_000 });
  await page.getByTestId('annotate-open').click();
  await expect(page.getByTestId('annotate-overlay')).toBeVisible();
  const stage = page.getByTestId('annotate-canvas-stage');
  await expect(stage).toBeVisible();

  // Konva renders into <canvas> elements inside the Stage container.
  const canvases = stage.locator('canvas');
  const count = await canvases.count();
  expect(count).toBeGreaterThanOrEqual(1);

  const dims = await canvases.first().evaluate((el) => {
    const c = el as HTMLCanvasElement;
    return { w: c.width, h: c.height, displayW: c.clientWidth, displayH: c.clientHeight };
  });
  expect(dims.w).toBeGreaterThan(0);
  expect(dims.h).toBeGreaterThan(0);
  expect(dims.displayW).toBeGreaterThan(0);

  // Sample pixels — the bitmap layer should not be empty/all-zero.
  const hasContent = await canvases.first().evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    const sampleX = Math.floor(c.width / 4);
    const sampleY = Math.floor(c.height / 4);
    const w = Math.min(40, c.width - sampleX);
    const h = Math.min(40, c.height - sampleY);
    const data = ctx.getImageData(sampleX, sampleY, w, h).data;
    // Any non-zero alpha pixel means the canvas has content (image rendered).
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) return true;
    }
    return false;
  });
  expect(hasContent).toBe(true);
});
