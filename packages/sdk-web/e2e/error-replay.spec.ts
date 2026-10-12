// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Error with replay (spec 2026-10-11, "Testing"). A page that records a replay
// and reports an error it survives (a handled `captureException`, or an uncaught
// error that reaches `window.onerror`) sends the replay with the error. The stub answers
// /api/config with replay on and keeps the bytes of the POST to /api/ingest, so
// every assertion is on what the SDK really uploaded:
//   - one `session-replay` part that matches its attachment ref;
//   - rrweb events that start from a full snapshot and contain the change made
//     before the error;
//   - no input value anywhere in them;
//   - and they play to the final frame in rrweb's own Replayer, in a second page.
import { test, expect, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { ESM_FIXTURE, stubIngestApi } from './_helpers.js';

// WebKit does not materialise Blob-backed FormData under route interception
// (microsoft/playwright#24077, see e2e/vue/_helpers.ts), so the body it hands
// back is an empty skeleton. Real Safari is unaffected.

const CORS = { 'Access-Control-Allow-Origin': '*' };
const SECRET = 'SECRET-4111-1111-1111-1111';
const CHANGED_HEADLINE = 'Order #4471 failed again';

interface Part { name: string; body: Buffer }

/** Split a multipart/form-data body into its named parts. */
function multipartParts(body: Buffer, contentType: string): Part[] {
  const boundary = contentType.match(/boundary=([^;]+)/)?.[1]?.replace(/^"|"$/g, '');
  if (!boundary) throw new Error(`no multipart boundary in "${contentType}"`);
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Part[] = [];
  let cursor = body.indexOf(delimiter);
  while (cursor !== -1) {
    const start = cursor + delimiter.length;
    if (body.subarray(start, start + 2).toString('latin1') === '--') break;
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    // Skip the CRLF after the boundary and the CRLF before the next one.
    const part = body.subarray(start + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    const name = part.subarray(0, split).toString('latin1').match(/[; ]name="([^"]+)"/)?.[1];
    if (name) parts.push({ name, body: part.subarray(split + 4) });
    cursor = next;
  }
  return parts;
}

const unzip = (bytes: Buffer): Buffer => (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes);

const TRIGGERS = [
  { name: 'a handled error', handled: true, fire: () => (
    window as unknown as { __everframe: { captureException(error: Error): void } }
  ).__everframe.captureException(new Error('error replay e2e')) },
  { name: 'an uncaught error', handled: false, fire: () => { setTimeout(() => { throw new Error('error replay e2e (uncaught)'); }, 0); } },
] as const;

for (const trigger of TRIGGERS) test(`${trigger.name} in a recording session sends a replay that plays to the final frame`, async ({ page, context, browserName }) => {
  test.skip(browserName === 'webkit', 'multipart bodies are not readable under WebKit route interception');
  await stubIngestApi(page);
  // Registered after the 404 stub, so these two win for their paths.
  await page.route(/\/api\/config(?:\?|$)/, (route: Route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: CORS,
    body: JSON.stringify({ replayEnabled: true, replayDurationSec: 30, samplingRate: 1 }),
  }));
  const uploads: Array<{ body: Buffer; contentType: string }> = [];
  await page.route('**/api/ingest', async (route: Route) => {
    const request = route.request();
    const body = request.method() === 'POST' ? request.postDataBuffer() : null;
    if (body && body.length > 0) uploads.push({ body, contentType: request.headers()['content-type'] ?? '' });
    await route.fulfill({
      status: 200, contentType: 'application/json', headers: CORS,
      body: JSON.stringify({ eventId: 'evt_error_replay', status: 'received' }),
    });
  });

  // Observe the recorder's own readiness: BUFFERING precedes the lazy rrweb import.
  await page.route(`**${ESM_FIXTURE}`, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("sdkKey: 'pk_e2e'", "debug: true, sdkKey: 'pk_e2e'") });
  });
  await page.goto(ESM_FIXTURE);
  // The replay is recording once its lifecycle is buffering.
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __everframe: { __adapter: { __replayLifecycle?: { state: string } } } }
  ).__everframe.__adapter.__replayLifecycle?.state), { timeout: 30_000 }).toBe('BUFFERING');

  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __everframeDebug: { replayState(): { recorder: { recording: boolean; hasAnchor: boolean } } } }
  ).__everframeDebug.replayState().recorder.hasAnchor), { timeout: 30_000 }).toBe(true);

  // A page change, and an input value that must never leave the browser.
  await page.evaluate(({ headline, secret }) => {
    document.getElementById('headline')!.textContent = headline;
    const input = document.createElement('input');
    input.id = 'card-number';
    document.body.append(input);
    input.value = secret;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { headline: CHANGED_HEADLINE, secret: SECRET });
  await page.waitForTimeout(500);

  await page.evaluate(trigger.fire);

  // The SDK may hold the error up to 3 s for its replay, so allow for that.
  await expect.poll(() => uploads.length, { timeout: 20_000 }).toBeGreaterThan(0);
  const upload = uploads[0]!;
  const parts = multipartParts(upload.body, upload.contentType);
  const envelope = JSON.parse(unzip(parts.find((part) => part.name === 'envelope')!.body).toString('utf8')) as {
    source: string;
    payload: { crash: { handled: boolean } };
    attachments: Array<{ kind: string; format: string; partName: string; sha256: string; byteLength: number; durationMs: number }>;
    captureControl?: { replayOmitted?: boolean };
  };
  expect(envelope.source).toBe('error');
  expect(envelope.payload.crash.handled).toBe(trigger.handled);
  expect(envelope.captureControl?.replayOmitted, 'the replay must not be omitted').toBeUndefined();

  const refs = envelope.attachments.filter((ref) => ref.kind === 'session-replay');
  expect(refs).toHaveLength(1);
  const ref = refs[0]!;
  expect(ref.format).toBe('rrweb');
  expect(ref.durationMs).toBeGreaterThan(0);
  const replay = parts.find((part) => part.name === ref.partName)!.body;
  expect(replay.length).toBe(ref.byteLength);
  expect(createHash('sha256').update(replay).digest('hex')).toBe(ref.sha256);

  const text = unzip(replay).toString('utf8');
  const events = JSON.parse(text) as Array<{ type: number }>;
  expect(events.length).toBeGreaterThan(2);
  expect(events.some((event) => event.type === 2), 'the replay starts from a full snapshot').toBe(true);
  expect(text, 'the change made before the error is in the replay').toContain(CHANGED_HEADLINE);
  expect(text, 'no input value leaves the browser').not.toContain(SECRET);

  // Play it in a second page with rrweb's own Replayer, jumping to the last frame.
  const viewer = await context.newPage();
  await viewer.route('**/error-replay-viewer', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body></body></html>',
  }));
  await viewer.goto('/error-replay-viewer');
  const played = await viewer.evaluate(async ({ recorded, rrwebUrl }) => {
    const rr = await import(rrwebUrl) as unknown as {
      Replayer: new (events: unknown[]) => {
        getMetaData(): { totalTime: number };
        pause(offset: number): void;
        iframe: HTMLIFrameElement;
      };
    };
    const problems: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { problems.push(args.map(String).join(' ')); original(...args); };
    try {
      const replayer = new rr.Replayer(recorded);
      // rrweb casts events strictly before the seek offset; include the last event.
      replayer.pause(replayer.getMetaData().totalTime + 1);
      return { problems, finalText: replayer.iframe.contentDocument?.body?.textContent ?? '' };
    } finally {
      console.error = original;
    }
  }, { recorded: events, rrwebUrl: '/vendor/rrweb.js' });
  expect(played.problems, 'the Replayer reported no problem').toEqual([]);
  expect(played.finalText).toContain(CHANGED_HEADLINE);
});
