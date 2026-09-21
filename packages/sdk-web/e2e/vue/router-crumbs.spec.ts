// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// installNavigationCrumbs patches history.pushState/replaceState and listens
// for popstate. A client-side router is the only thing that exercises that;
// the static fixtures are single pages.
//
// The third test pins a documented LIMITATION rather than a feature: a
// hash-only route change emits nothing, because screen names are built from
// pathname + search. /docs/web/screen-tracking/ says so. Pinning it here is
// what keeps it a known gap instead of a silent regression. It opens with an
// in-test positive control (a real History-API navigation) before asserting
// the negative, so a broken probe — a renamed seam, an unassigned handle —
// fails loudly on the control instead of passing by measuring nothing.
import { test, expect, type Page } from '@playwright/test';
import { stubIngest } from './_helpers';

/**
 * The live breadcrumb buffer, read through the adapter seam. The buffer is
 * reached via `__getBreadcrumbBuffer()`, NOT a `getBreadcrumbs()` method —
 * see packages/sdk-web/src/adapter.ts.
 */
async function navigationCrumbs(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __traceitx: {
        __adapter: {
          __getBreadcrumbBuffer(): { snapshot(): { kind: string; message: string }[] } | undefined;
        };
      };
    };
    return (w.__traceitx.__adapter.__getBreadcrumbBuffer()?.snapshot() ?? [])
      .filter((c) => c.kind === 'navigation')
      .map((c) => c.message);
  });
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => console.error('[page]', e.message));
  stubIngest(page);
});

test('History-API navigation produces navigation crumbs', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('home-heading')).toBeVisible();

  await page.getByTestId('nav-specimens').click();
  await expect(page).toHaveURL(/\/specimens$/);
  await page.getByTestId('specimen-link-txx-001').click();
  await expect(page).toHaveURL(/\/specimens\/txx-001$/);

  const crumbs = await navigationCrumbs(page);
  expect(crumbs.some((m) => m.includes('/specimens'))).toBe(true);
  expect(crumbs.some((m) => m.includes('/specimens/txx-001'))).toBe(true);
});

test('back navigation is recorded too', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('nav-specimens').click();
  await expect(page).toHaveURL(/\/specimens$/);
  const before = (await navigationCrumbs(page)).length;

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);

  await expect.poll(async () => (await navigationCrumbs(page)).length).toBeGreaterThan(before);
});

test('a hash-only change adds no crumb beyond a proven-working baseline', async ({ page }) => {
  await page.goto('/');

  // Positive control: a real History-API navigation must produce a crumb
  // here, on this page, right now. If it doesn't, the probe itself is
  // broken (wrong seam, undefined buffer, handle not yet assigned) and the
  // test fails right here instead of silently passing the negative check
  // below by comparing two empty lists.
  await page.getByTestId('nav-specimens').click();
  await expect(page).toHaveURL(/\/specimens$/);
  const baseline = await navigationCrumbs(page);
  expect(baseline.some((m) => m.includes('/specimens'))).toBe(true);

  // Now the negative case: a hash-only change must add nothing beyond that
  // proven baseline.
  await page.evaluate(() => {
    window.location.hash = '#/checkout';
  });
  await page.waitForTimeout(500);

  expect(await navigationCrumbs(page)).toEqual(baseline);
});
