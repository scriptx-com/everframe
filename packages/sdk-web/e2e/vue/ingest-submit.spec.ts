// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The envelope a Vue host produces. The `sdk.name` assertion is the one that
// matters beyond this repo: prod ingest must accept the widened enum value
// `traceitx-web` BEFORE @traceitx/web publishes, or every vanilla report 400s.
// PUBLISHING.md records that release ordering; this pins the value it depends
// on so a rename cannot slip through unnoticed.
import { test, expect } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { stubIngest, openReporter } from './_helpers';

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

test('a Vue host submits an envelope identifying itself as traceitx-web', async ({ page }) => {
  page.on('pageerror', (e) => console.error('[page]', e.message));
  const ingest = stubIngest(page);

  await page.goto('/');
  await openReporter(page);
  await page.getByTestId('report-title').fill('ingest submit test');
  await page.getByTestId('submit-report').click();

  await expect.poll(() => ingest.body() !== null, { timeout: 30_000 }).toBe(true);
  const envelope = JSON.parse(envelopeJsonFrom(ingest.body() as Buffer)) as {
    sdk: { name: string; version: string };
    payload: { breadcrumbs: unknown[] };
  };

  // NOT 'traceitx-react'. A Vue host that identified itself as the React SDK
  // would be invisible in every per-SDK metric downstream.
  expect(envelope.sdk.name).toBe('traceitx-web');
  expect(envelope.sdk.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(Array.isArray(envelope.payload.breadcrumbs)).toBe(true);
});
