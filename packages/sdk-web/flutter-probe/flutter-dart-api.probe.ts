// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { expect, test } from '@playwright/test';

test('Flutter Dart bridge starts and opens the browser reporter', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as { __everframeProbe?: unknown }).__everframeProbe));
  await page.mouse.click(350, 250);
  await expect(page.getByTestId('report-title')).toBeVisible();
});
