// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// kill() is the consent/GDPR control: after it lands, nothing is captured and
// nothing leaves the device — including a reporter that is ALREADY OPEN.
//
// This is the branch's headline defect. kill() never worked, on this branch or
// on main: __openReporter and crashSink never checked killed state, so a
// customer calling it for consent reasons was never protected.
// __tests__/kill-switch-gates.spec.ts covers the choke points; this is the
// only thing that drives the full open -> kill -> Send path through a real UI.
import { test, expect } from '@playwright/test';
import { stubIngest, openReporter } from './_helpers';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => console.error('[page]', e.message));
});

test('a report written before kill() is NOT submitted after it', async ({ page }) => {
  const ingest = stubIngest(page);

  await page.goto('/');
  await openReporter(page);
  await page.getByTestId('report-title').fill('written before the kill');

  // Kill through the SDK surface the settings page wires up, not through a
  // test-only backdoor — the whole point is to exercise what a host calls.
  await page.evaluate(() => {
    (window as unknown as { __everframe: { kill(): void } }).__everframe.kill();
  });

  await page.getByTestId('submit-report').click();

  // The notice is a statement of fact about the app, not an error: the host
  // turning reporting off is not a failure. Copy is pinned because both SDKs
  // show the same reporter to the same end user.
  await expect(page.getByText('Reporting is turned off — this report was not sent.')).toBeVisible({
    timeout: 15_000,
  });

  await page.waitForTimeout(3000);
  expect(ingest.body()).toBeNull();
});

test('a report submitted WITHOUT kill() does reach ingest — the control', async ({ page }) => {
  // Without this case the test above passes on a broken submit path just as
  // happily as on a working kill gate.
  const ingest = stubIngest(page);

  await page.goto('/');
  await openReporter(page);
  await page.getByTestId('report-title').fill('control: no kill');
  await page.getByTestId('submit-report').click();

  await expect.poll(() => ingest.body() !== null, { timeout: 30_000 }).toBe(true);
});

test('the settings page kill button stops the bubble opening the reporter, proven live first', async ({
  page,
}) => {
  const ingest = stubIngest(page);

  // Positive control, on THIS page, moments before the kill: prove the bubble
  // is wired to a live SDK and opens the real reporter. Without this, a
  // passing assertion that the modal does not open after kill() is equally
  // consistent with an unwired bubble, a broken settings kill button, or the
  // kill gate itself never having done anything — this is what closes all
  // three holes at once.
  await page.goto('/');
  await openReporter(page);
  await page.getByTestId('cancel-report').click();
  await expect(page.getByTestId('reporter-modal')).not.toBeVisible();

  // kill() is irreversible within a page load, so the kill must happen on
  // this same page, after the control above, via client-side navigation
  // (no reload) to /settings.
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('kill-sdk').click();
  await expect(page.getByTestId('settings-status')).toContainText('killed');

  // Same page, same SDK instance: the bubble that just proved itself live
  // must now refuse to open the reporter at all.
  await page.getByTestId('nav-home').click();
  await page.getByTestId('everframe-bubble').click();
  await page.waitForTimeout(2000);
  await expect(page.getByTestId('reporter-modal')).not.toBeVisible();

  expect(ingest.body()).toBeNull();
});
