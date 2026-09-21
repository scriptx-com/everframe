// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Helpers for the specs that run against examples/vue-web. Kept separate from
// e2e/_helpers.ts, which serves the two static fixtures and stubs /api/** as
// 404 — these specs need ingest to answer 200 so a submit completes.
//
// Not named *.spec.ts, so Playwright's testMatch does not collect it.
import { expect, type Page } from '@playwright/test';

/**
 * Answer every ingest POST with 200 and hand the raw multipart body back.
 * The ingest ORIGIN is baked into dist/ at build time, so this matches by PATH
 * — the stub then holds whichever URL the local dist/ happens to carry.
 */
export function stubIngest(page: Page): { body: () => Buffer | null } {
  let captured: Buffer | null = null;
  void page.route('**/api/ingest', async (route, req) => {
    if (req.method() === 'POST') {
      // KNOWN GAP under vue-webkit (see examples/vue-web/README.md's
      // "Known result: 49/51" section): a real listening server sees
      // byte-identical bytes on the wire from WebKit vs. Chromium
      // (total=3403 envelopePart=2037 screenshotPart=1024, confirmed
      // experimentally), but postDataBuffer() returns only a 342-byte
      // skeleton with empty parts under WebKit route interception —
      // matching microsoft/playwright#24077 (Blob-backed FormData not
      // materialised under WebKit route interception). Real Safari users are
      // unaffected. Fix shape: point the two body-asserting specs
      // (ingest-submit.spec.ts, seeded-pii.spec.ts) at a real listening
      // server — packages/sdk-react/e2e/_fixtures/test-server.ts's
      // startStubIngest — instead of this route-interception stub. Do NOT
      // "fix" this by skipping WebKit for those specs; that re-hides the gap
      // instead of closing it.
      const buf = req.postDataBuffer();
      if (buf && buf.length > 0) captured = buf;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ eventId: 'evt_vue', status: 'received' }),
    });
  });
  // Everything else under /api/ (config, reply poll) is fail-closed by design,
  // so 404 keeps the run off the network without changing SDK behaviour.
  void page.route('**/api/config**', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
  );
  return { body: () => captured };
}

/** Click the host-owned trigger and wait for the dialog inside the shadow root. */
export async function openReporter(page: Page): Promise<void> {
  await page.getByTestId('traceitx-bubble').click();
  await expect(page.getByTestId('reporter-modal')).toBeVisible({ timeout: 30_000 });
}

/** How many ambient SDK hosts are attached to the document. */
export function hostCount(): number {
  return document.querySelectorAll('#traceitx-host').length;
}
