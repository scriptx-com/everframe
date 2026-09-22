// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The sdk-core redaction engine, exercised through a non-React host. The home
// page renders a Luhn-valid Visa test number and a Bearer JWT; after capture
// and submit, the envelope must not contain either verbatim.
import { test, expect } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { stubIngest, openReporter } from './_helpers';

/** Pull the envelope JSON out of a multipart body, decompressing if gzipped. */
function envelopeJsonFrom(buf: Buffer): string {
  const text = buf.toString('latin1');
  const envelopeStart = text.indexOf('name="envelope"');
  if (envelopeStart < 0) throw new Error('no envelope part in multipart body');
  const bodyStart = text.indexOf('\r\n\r\n', envelopeStart) + 4;
  const boundaryMarker = text.match(/^------[A-Za-z0-9'()+_,\-./:=?]+/m)?.[0];
  if (!boundaryMarker) throw new Error('no multipart boundary');
  const bodyEnd = text.indexOf(`\r\n${boundaryMarker}`, bodyStart);
  const part = buf.subarray(bodyStart, bodyEnd);
  return part[0] === 0x1f && part[1] === 0x8b
    ? gunzipSync(part).toString('utf8')
    : part.toString('utf8');
}

test('seeded PII never reaches the envelope from a Vue host', async ({ page }) => {
  page.on('pageerror', (e) => console.error('[page]', e.message));
  const ingest = stubIngest(page);

  await page.goto('/');
  await expect(page.getByTestId('cc-number')).toBeVisible();
  await expect(page.getByTestId('bearer-token')).toBeVisible();

  await openReporter(page);
  await page.getByTestId('report-title').fill('seeded pii test');
  await page.getByTestId('submit-report').click();

  await expect.poll(() => ingest.body() !== null, { timeout: 30_000 }).toBe(true);
  const envelopeJson = envelopeJsonFrom(ingest.body() as Buffer);

  // Both forms: redaction normalises before matching.
  expect(envelopeJson).not.toContain('4111-1111-1111-1111');
  expect(envelopeJson).not.toContain('4111111111111111');
  expect(envelopeJson).not.toContain(
    'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.fake-signature',
  );

  // Guard against the assertion passing because nothing was captured: the
  // envelope must actually be an envelope.
  expect(envelopeJson.length).toBeGreaterThan(500);
  expect(envelopeJson).toContain('"breadcrumbs"');
});
