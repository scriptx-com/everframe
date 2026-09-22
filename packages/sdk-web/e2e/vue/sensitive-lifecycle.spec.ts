// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// React hosts mark sensitive content with <Sensitive>, which unregisters on
// unmount for free. A vanilla host calls sensitiveRegistry.addRef() and must
// call removeRef() itself; nothing else in this repo proves that half.
//
// A host that forgets removeRef leaks a reference to a detached node and keeps
// masking a rect that is no longer on screen — so this is the spec that makes
// the docs' warning real.
import { test, expect, type Page } from '@playwright/test';
import { stubIngest } from './_helpers';

/** How many elements the registry currently holds. */
function registrySize(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __traceitxSensitive: { snapshotElements(): Element[] };
    };
    return w.__traceitxSensitive.snapshotElements().length;
  });
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => console.error('[page]', e.message));
  stubIngest(page);
});

test('the attribute-marked fixture is present in the DOM with its marker attribute', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('sensitive-attr-block')).toBeVisible();
  // The attribute path is a capture-time scan, not a registry entry — so it is
  // visible in the DOM rather than in snapshotElements().
  const marked = await page.locator('[data-traceitx-sensitive]').count();
  expect(marked).toBeGreaterThan(0);
});

test('the directive registers on mount', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('sensitive-block')).toBeVisible();
  // The registry also holds two pre-existing HomeView fixtures picked up by
  // the OTHER two feeds into snapshotElements() — the data-traceitx-sensitive
  // scan (sensitive-attr-block) and the SDK's own PRIV-01 auto-mask of
  // input[type=password] (the member-password field). Those two are scanned
  // live from the DOM and need no addRef/removeRef of their own; this
  // directive's ref is the third.
  await expect.poll(() => registrySize(page), { timeout: 10_000 }).toBe(3);
});

test('the directive UNREGISTERS on unmount — the vanilla-host obligation', async ({ page }) => {
  await page.goto('/');
  // See the comment above: 3 = this directive's ref + the attribute-scanned
  // block + the auto-masked password input, all currently on HomeView.
  await expect.poll(() => registrySize(page), { timeout: 10_000 }).toBe(3);

  // Navigating away unmounts HomeView and with it the v-sensitive element.
  await page.getByTestId('nav-specimens').click();
  await expect(page).toHaveURL(/\/specimens$/);

  await expect.poll(() => registrySize(page), { timeout: 10_000 }).toBe(0);
});
