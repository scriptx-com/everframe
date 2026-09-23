// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { test, expect } from '@playwright/test';

/**
 * ROADMAP success criterion 3 — submitted report is accepted by the ingest service.
 *
 * Asserts the WIRE SHAPE of the request leaving the SDK:
 *   - method POST
 *   - URL endsWith /api/ingest
 *   - Authorization: Bearer txx_live_test
 *   - Content-Type: multipart/form-data; boundary=...
 *
 * Does NOT depend on a stub server receiving the request — page.waitForRequest
 * captures the request shape directly off the browser's network stack, which is
 * sufficient to prove the SDK emits a correctly-shaped multipart POST. End-to-end
 * delivery against the actual Everframe ingest service is the dogfood path
 * (see examples/react-web/README.md and the manual-only verification table in
 * 03-VALIDATION.md).
 */
test('Real multipart POST hits ingest URL with Bearer auth + multipart body', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('everframe-bubble').click();
  await expect(page.getByTestId('reporter-modal')).toBeVisible();
  await page.getByTestId('report-title').fill('ingest submit test');

  const requestPromise = page.waitForRequest(
    (req) => req.url().includes('/api/ingest') && req.method() === 'POST',
    { timeout: 30_000 },
  );
  await page.getByTestId('submit-report').click();
  const req = await requestPromise;

  const headers = req.headers();
  expect(headers['authorization']).toBe('Bearer txx_live_test');
  expect(headers['content-type']).toMatch(/multipart\/form-data;\s*boundary=/);
});
