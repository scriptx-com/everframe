// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { test, expect, type Page } from '@playwright/test';

/** Open the reporter and enter the fullscreen annotation editor. */
async function openEditor(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('everframe-bubble').click();
  await expect(page.getByTestId('reporter-modal')).toBeVisible();
  await expect(page.getByTestId('capture-pending')).toBeHidden({ timeout: 15_000 });
  await page.getByTestId('annotate-open').click();
  await expect(page.getByTestId('annotate-overlay')).toBeVisible();
}

/**
 * The fullscreen overlay's canvas frame + toolbar column is often taller than
 * the viewport for a full-page capture (the Home fixture is long), and
 * `.everframe-annotate-overlay-stage` is its own `overflow: auto` scroll region. A
 * toolbar button click auto-scrolls that region (Playwright's actionability
 * check, mirroring a real scrollIntoView) to make the button visible — which
 * scrolls the CANVAS TOP out of view. Raw `page.mouse.*` calls (unlike
 * `.click()`) don't get that same auto-scroll, so reset scroll to the top
 * before any coordinate-based interaction with the canvas.
 */
async function scrollStageTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelector('.everframe-annotate-overlay-stage')?.scrollTo(0, 0);
  });
}

/** Drag from (fx,fy) to (tx,ty) expressed as fractions of the stage box. */
async function dragOnStage(
  page: Page,
  fx: number,
  fy: number,
  tx: number,
  ty: number,
): Promise<void> {
  await scrollStageTop(page);
  const stage = page.getByTestId('annotate-canvas-stage').locator('canvas').first();
  const box = (await stage.boundingBox())!;
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * tx, box.y + box.height * ty, { steps: 5 });
  await page.mouse.up();
}

test('draw rect → auto-selected → delete via toolbar → undo restores', async ({ page }) => {
  await openEditor(page);
  await expect(page.getByTestId('tool-undo')).toBeDisabled();

  await page.getByTestId('tool-rect').click();
  await dragOnStage(page, 0.2, 0.2, 0.5, 0.4);

  // Finished shape is auto-selected: delete button is enabled.
  await expect(page.getByTestId('tool-delete')).toBeEnabled();
  await expect(page.getByTestId('tool-undo')).toBeEnabled();

  await page.getByTestId('tool-delete').click();
  await expect(page.getByTestId('tool-delete')).toBeDisabled();

  // Undo brings the rect back (undo covers deletes, not just draws).
  await page.getByTestId('tool-undo').click();
  await expect(page.getByTestId('tool-redo')).toBeEnabled();
});

test('pointer tool selects a drawn shape by clicking it', async ({ page }) => {
  await openEditor(page);
  await page.getByTestId('tool-rect').click();
  await dragOnStage(page, 0.2, 0.2, 0.5, 0.4);
  // Deselect by switching tool, then re-select with the pointer.
  await page.getByTestId('tool-pen').click();
  await expect(page.getByTestId('tool-delete')).toBeDisabled();
  await page.getByTestId('tool-pointer').click();
  await scrollStageTop(page);
  const stage = page.getByTestId('annotate-canvas-stage').locator('canvas').first();
  const box = (await stage.boundingBox())!;
  // Click the shape's geometric CENTER (0.35, 0.3 for a rect drawn
  // 0.2–0.5 × 0.2–0.4 by dragOnStage above). The rect must have an
  // interior hit area (transparent fill, not fillEnabled=false) so an
  // ordinary click anywhere inside the shape selects it — not just the
  // stroke band. Regression lock for the "can't reselect a drawn shape"
  // bug.
  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.3);
  await expect(page.getByTestId('tool-delete')).toBeEnabled();
  // Delete/Backspace also removes the selection.
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('tool-delete')).toBeDisabled();
});

test('clicking a shape with a drawing tool selects it; empty click deselects', async ({
  page,
}) => {
  await openEditor(page);
  await page.getByTestId('tool-rect').click();
  await dragOnStage(page, 0.2, 0.2, 0.5, 0.4);
  // Finished shape is auto-selected; the rect tool stays active.
  await expect(page.getByTestId('tool-delete')).toBeEnabled();
  await expect(page.getByTestId('tool-undo')).toBeEnabled();

  await scrollStageTop(page);
  const stage = page.getByTestId('annotate-canvas-stage').locator('canvas').first();
  const box = (await stage.boundingBox())!;

  // Click EMPTY canvas far from the shape — rect tool is still active. This
  // is a degenerate drag (a plain click), so it cancels cleanly and must NOT
  // leave a stray history entry (that's verified by the single-undo check
  // below), but it DOES drop the selection.
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.9);
  await expect(page.getByTestId('tool-delete')).toBeDisabled();

  // Click ON the shape's interior — rect tool is STILL active (no switch to
  // pointer). This must select the shape rather than start a new draw.
  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.3);
  await expect(page.getByTestId('tool-delete')).toBeEnabled();

  // Prove no stray shape was drawn: a single undo removes the ORIGINAL rect
  // (the only history entry — the empty-canvas click's degenerate gesture
  // popped its own entry via cancelGesture, and the on-shape click never
  // reached the Stage's drawing branch at all). If either click had left a
  // stray history entry, undo would still be enabled afterward.
  await page.getByTestId('tool-undo').click();
  await expect(page.getByTestId('tool-delete')).toBeDisabled();
  await expect(page.getByTestId('tool-undo')).toBeDisabled();
});

test('text tool places an editable text box', async ({ page }) => {
  await openEditor(page);
  await page.getByTestId('tool-text').click();
  await scrollStageTop(page);
  const stage = page.getByTestId('annotate-canvas-stage').locator('canvas').first();
  const box = (await stage.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
  const editor = page.getByTestId('text-editor');
  await expect(editor).toBeVisible();
  await editor.fill('needs fixing');
  await editor.press('Escape');
  await expect(editor).toBeHidden();
  // Escape commits the text box but must NOT close the fullscreen annotate
  // overlay — regression lock for the escapeStack fix (LIFO: text editor's
  // handler wins over the overlay's while it's open).
  await expect(page.getByTestId('annotate-overlay')).toBeVisible();
  // Committed text is an annotation: undo is available, delete enabled (selected).
  await expect(page.getByTestId('tool-undo')).toBeEnabled();
});

test('text editor auto-grows past its 80px min-width as the user types', async ({ page }) => {
  await openEditor(page);
  await page.getByTestId('tool-text').click();
  await scrollStageTop(page);
  const stage = page.getByTestId('annotate-canvas-stage').locator('canvas').first();
  const box = (await stage.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.1);
  const editor = page.getByTestId('text-editor');
  await expect(editor).toBeVisible();
  // The mount-time autosize runs on the NEXT animation frame (after focus),
  // outside the placing pointerdown's own event cycle — wait for two rAFs so
  // the read below isn't racing that effect (flaky otherwise: it would catch
  // the raw un-sized textarea, whose default width happens to already match
  // the container in some browsers).
  await editor.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const widthBefore = await editor.evaluate((el: HTMLTextAreaElement) => el.clientWidth);
  await editor.type(
    'this is a much longer string than the editor starts at — it must grow to show it all',
  );
  const widthAfter = await editor.evaluate((el: HTMLTextAreaElement) => el.clientWidth);
  expect(widthAfter).toBeGreaterThan(widthBefore);
});

test('Enter commits the text box (overlay stays open, undo enabled); Shift+Enter inserts a newline', async ({
  page,
}) => {
  await openEditor(page);
  await page.getByTestId('tool-text').click();
  await scrollStageTop(page);
  const stage = page.getByTestId('annotate-canvas-stage').locator('canvas').first();
  const box = (await stage.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.1);
  const editor = page.getByTestId('text-editor');
  await expect(editor).toBeVisible();
  await editor.type('line one');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
  await editor.type('line two');
  await expect(editor).toHaveValue('line one\nline two');
  await page.keyboard.press('Enter');
  await expect(editor).toBeHidden();
  await expect(page.getByTestId('annotate-overlay')).toBeVisible();
  await expect(page.getByTestId('tool-undo')).toBeEnabled();
});

test('clicking the canvas with the text tool active commits the in-flight edit — both texts survive', async ({
  page,
}) => {
  await openEditor(page);
  await page.getByTestId('tool-text').click();
  await scrollStageTop(page);
  const stage = page.getByTestId('annotate-canvas-stage').locator('canvas').first();
  const box = (await stage.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.1);
  let editor = page.getByTestId('text-editor');
  await expect(editor).toBeVisible();
  await editor.type('first box');
  // The first click elsewhere deterministically commits the in-flight edit
  // and is swallowed; the second click places the next box (regression lock
  // for the unmount-before-blur race that silently dropped typed text).
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6);
  await expect(page.getByTestId('text-editor')).toBeHidden();
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6);
  editor = page.getByTestId('text-editor');
  await expect(editor).toBeVisible();
  await editor.type('second box');
  await editor.press('Escape');
  await expect(editor).toBeHidden();

  // Both texts committed with real content: two independent undo steps are
  // needed to clear them (an empty/dropped annotation would need only one).
  await expect(page.getByTestId('tool-undo')).toBeEnabled();
  await page.getByTestId('tool-undo').click();
  await expect(page.getByTestId('tool-undo')).toBeEnabled();
  await page.getByTestId('tool-undo').click();
  await expect(page.getByTestId('tool-undo')).toBeDisabled();
});
