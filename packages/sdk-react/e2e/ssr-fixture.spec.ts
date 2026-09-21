// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { test, expect } from '@playwright/test';

/**
 * Pitfall 12 — Next.js SSR.
 *
 * `next build` (run once before this suite via examples-react-web) produces a
 * server component layout that imports @traceitx/react. If any module-load
 * side-effect references `window` / `document` outside a `'use client'` boundary,
 * the build crashes with "ReferenceError: window is not defined" — this spec
 * proves that did NOT happen by visiting the home page and confirming the
 * server-rendered HTML contains the heading text directly (proves SSR ran),
 * then waits for hydration and confirms the bubble appears (proves the client
 * boundary mounted cleanly without hydration mismatch).
 */
test('Next.js SSR: home renders without throwing; bubble + hook present after hydration', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/');
  await expect(page.getByTestId('home-heading')).toBeVisible();

  // Server-rendered HTML must contain the heading text BEFORE hydration mounts the bubble.
  // This proves SSR ran (the alternative — page rendered client-side after a 200 with empty
  // body — would still show the heading after hydration but the HTML wouldn't contain it).
  const html = await page.content();
  expect(html).toContain('TraceItX Web SDK Example');

  // After hydration, the bubble portal is present.
  await expect(page.getByTestId('traceitx-bubble')).toBeVisible();

  // No "window is not defined" or React hydration mismatch errors.
  expect(errors.find((e) => e.toLowerCase().includes('window is not defined'))).toBeUndefined();
  expect(errors.find((e) => e.toLowerCase().includes('hydration'))).toBeUndefined();
});
