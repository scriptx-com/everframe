// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The claim the static fixtures cannot make: the SDK mounts correctly when a
// FRAMEWORK owns the lifecycle — init() from onMounted rather than module
// scope, with a component tree above it.
import { test, expect } from '@playwright/test';
import { stubIngest, openReporter, hostCount } from './_helpers';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => console.error('[page]', e.message));
  stubIngest(page);
});

test('a Vue host mounts exactly one ambient SDK host', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('home-heading')).toBeVisible();
  await expect(page.getByTestId('home-heading')).toHaveText('TraceItX Web SDK Example');
  await expect.poll(() => page.evaluate(hostCount), { timeout: 15_000 }).toBe(1);
});

test('init() ran from onMounted, so the handle exists after paint', async ({ page }) => {
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => typeof (window as never as Record<string, unknown>)['__traceitx']))
    .toBe('object');
});

test('the reporter opens from the host-owned trigger', async ({ page }) => {
  await page.goto('/');
  await openReporter(page);
  await expect(page.getByTestId('report-title')).toBeVisible();
});

test('unmount then remount leaves exactly one host, not two', async ({ page }) => {
  // The failure this guards is silent accumulation: an incomplete destroy()
  // leaves the old host and listeners in place, and the second init() adds
  // another. A single-page fixture can never see it.
  await page.goto('/');
  await expect.poll(() => page.evaluate(hostCount), { timeout: 15_000 }).toBe(1);

  await page.evaluate(() => {
    (window as unknown as { __traceitxRemount: () => void }).__traceitxRemount();
  });

  await expect.poll(() => page.evaluate(hostCount), { timeout: 15_000 }).toBe(1);
  await openReporter(page);
});
