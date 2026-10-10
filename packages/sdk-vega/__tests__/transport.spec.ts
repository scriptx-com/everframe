// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classify, sendReport, SEND_TIMEOUT_MS } from '../src/transport.js';
import { createFetch } from './fakes.js';

const deps = (fetch: Parameters<typeof sendReport>[0]['fetch']) => ({
  fetch,
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('transport', () => {
  it.each([
    [200, 'sent'], [202, 'sent'],
    [400, 'drop'], [401, 'drop'], [403, 'drop'], [413, 'drop'], [426, 'drop'], [301, 'drop'],
    [0, 'retry'], [408, 'retry'], [429, 'retry'], [500, 'retry'], [503, 'retry'],
  ] as const)('classifies %i as %s', (status, outcome) => {
    expect(classify(status)).toBe(outcome);
  });

  it('posts the envelope as JSON with the SDK key, never multipart', async () => {
    const fetch = createFetch([200]);
    const result = await sendReport(deps(fetch), 'https://everframe.dev/api/ingest', 'evf_live_key', '{"a":1}');
    expect(result).toEqual({ outcome: 'sent', status: 200 });
    expect(fetch.requests[0]).toMatchObject({
      url: 'https://everframe.dev/api/ingest',
      headers: { Authorization: 'Bearer evf_live_key', 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
  });

  it('retries after a network error', async () => {
    const fetch = createFetch([0]);
    expect(await sendReport(deps(fetch), 'https://x/api/ingest', 'k', '{}')).toEqual({ outcome: 'retry', status: 0 });
  });

  it('gives up on a request that never answers', async () => {
    vi.useFakeTimers();
    const hanging = (() => new Promise<never>(() => undefined)) as unknown as Parameters<typeof sendReport>[0]['fetch'];
    const pending = sendReport(deps(hanging), 'https://x/api/ingest', 'k', '{}');
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    expect(await pending).toEqual({ outcome: 'retry', status: 0 });
  });
});
