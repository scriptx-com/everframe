// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { test, expect } from '@playwright/test';
import { gunzipSync } from 'node:zlib';

/**
 * Phase-1 redaction engine + sdk-core safety net (PRIV-01 / PRIV-03).
 *
 * The home page renders a Luhn-valid Visa test card number (4111-1111-1111-1111)
 * and a Bearer-prefixed JWT. After capture + submit, the multipart envelope MUST
 * NOT contain those values verbatim. The sdk-core redaction engine applies
 * regex-based pattern-matching against the JSON envelope BEFORE the SDK transport
 * layer assembles the multipart body.
 */
test('seeded-PII: envelope JSON does NOT contain canonical PII verbatim', async ({ page }) => {
  // Surface SDK-side errors so a silent capture/submit failure produces a useful trace
  page.on('pageerror', (e) => console.error('[page]', e.message));

  // Intercept the ingest POST via page.route() — postDataBuffer() can be null on
  // requests that Playwright didn't have time to spool to disk before the route
  // handler fires, but route() gives us guaranteed access to the request body via
  // the route's request().postDataBuffer() at handler entry.
  let capturedBody: Buffer | null = null;
  await page.route('**/api/ingest', async (route, req) => {
    if (req.method() === 'POST') {
      const buf = req.postDataBuffer();
      if (buf && buf.length > 0) capturedBody = buf;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ eventId: 'evt_test', status: 'received' }),
    });
  });

  await page.goto('/');
  await expect(page.getByTestId('cc-number')).toBeVisible();
  await page.getByTestId('traceitx-bubble').click();
  await expect(page.getByTestId('reporter-modal')).toBeVisible();
  await page.getByTestId('report-title').fill('seeded pii test');
  await page.getByTestId('submit-report').click();

  // Wait for the route handler to capture the body
  await expect.poll(() => capturedBody !== null, { timeout: 30_000 }).toBe(true);
  const buf = capturedBody as unknown as Buffer;

  // Parse the multipart body to extract the envelope JSON part (which may be gzipped if
  // its byteLength > 8KB per sdk-core/transport/multipart.ts GZIP_THRESHOLD). The PII
  // assertions must run against the DECODED envelope JSON — searching the raw body
  // would false-positive PASS on gzipped bytes (PII obscured by compression, not redaction).
  const text = buf.toString('latin1');
  const envelopeStart = text.indexOf('name="envelope"');
  if (envelopeStart < 0) throw new Error('no envelope part in multipart body');
  // Find the body of the envelope part: after the trailing \r\n\r\n
  const bodyStart = text.indexOf('\r\n\r\n', envelopeStart) + 4;
  // End of part: next boundary marker. Boundary chars per RFC 2046: alphanumeric + a few
  // specials (' ( ) + _ , - . / : = ?) — match conservatively.
  const boundaryMarker = text.match(/^------[A-Za-z0-9'()+_,\-./:=?]+/m)?.[0];
  if (!boundaryMarker) throw new Error('no multipart boundary');
  const bodyEnd = text.indexOf(`\r\n${boundaryMarker}`, bodyStart);
  const envelopePartBytes = buf.subarray(bodyStart, bodyEnd);

  // Detect gzip via magic header (1f 8b) and decompress if present
  let envelopeJson: string;
  if (envelopePartBytes[0] === 0x1f && envelopePartBytes[1] === 0x8b) {
    envelopeJson = gunzipSync(envelopePartBytes).toString('utf8');
  } else {
    envelopeJson = envelopePartBytes.toString('utf8');
  }

  // The Luhn-Visa test number MUST be redacted by sdk-core's redaction engine.
  // Both dashed and undashed forms are checked because the redaction normalises
  // before pattern-match.
  expect(envelopeJson).not.toContain('4111-1111-1111-1111');
  expect(envelopeJson).not.toContain('4111111111111111');

  // Full Bearer-token verbatim must be redacted.
  expect(envelopeJson).not.toContain('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.fake-signature');
});
