// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// MAI meter Plan 2b-ii, D3 — the identifier rides at most one config read per
// UTC day. At 100k installs the five-minute poll is ~28.8M insert attempts a
// day; this cuts it ~288x.
//
// Dedupe is an OPTIMISATION, not correctness: the server's unique constraint
// makes repeat sends free, and it deduplicates per calendar MONTH, so a lost
// day costs nothing. Nothing here may retry, queue, or otherwise try to make
// a send "land".
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  makeWebInstallIdSupplier,
  scopedInstallDayStorageKey,
  deriveWebInstallId,
} from '../../src/reporter/credential-store.js';
import { createWebPlatformAdapter, type WebPlatformAdapter } from '../../src/adapter.js';

const SCOPE = 'txx_live_daily_scope';
const DAY_MS = 86_400_000;

afterEach(() => localStorage.clear());

describe('web install identifier: daily dedupe', () => {
  it('yields the identifier on the first call of a day', () => {
    const supplier = makeWebInstallIdSupplier(SCOPE, () => 10 * DAY_MS);
    expect(supplier()).toBe(deriveWebInstallId(SCOPE));
  });

  it('yields nothing on a second call the same day', () => {
    const supplier = makeWebInstallIdSupplier(SCOPE, () => 10 * DAY_MS);
    expect(supplier()).not.toBeNull();
    expect(supplier()).toBeNull();
    expect(supplier()).toBeNull();
  });

  it('yields again once the UTC day rolls over', () => {
    let nowMs = 10 * DAY_MS;
    const supplier = makeWebInstallIdSupplier(SCOPE, () => nowMs);
    expect(supplier()).not.toBeNull();
    nowMs = 10 * DAY_MS + DAY_MS - 1; // last millisecond of the same UTC day
    expect(supplier()).toBeNull();
    nowMs = 11 * DAY_MS; // first millisecond of the next UTC day
    expect(supplier()).not.toBeNull();
  });

  it('records the day at the moment it hands the value over, so a failed fetch does not re-send', () => {
    // Recorded on dispatch, not on a 200: recording on success would re-send
    // through every failed fetch, and a lost day costs nothing against
    // per-month server dedupe.
    const supplier = makeWebInstallIdSupplier(SCOPE, () => 10 * DAY_MS);
    supplier();
    expect(localStorage.getItem(scopedInstallDayStorageKey(SCOPE))).toBe('10');
  });

  it('survives a page reload — the marker is persisted, not in memory', () => {
    expect(makeWebInstallIdSupplier(SCOPE, () => 10 * DAY_MS)()).not.toBeNull();
    // A fresh supplier stands in for a fresh page load with the same storage.
    expect(makeWebInstallIdSupplier(SCOPE, () => 10 * DAY_MS)()).toBeNull();
  });

  it('is scoped per api key, like the seed', () => {
    expect(makeWebInstallIdSupplier('keyA', () => 10 * DAY_MS)()).not.toBeNull();
    expect(makeWebInstallIdSupplier('keyB', () => 10 * DAY_MS)()).not.toBeNull();
  });

  it('treats a malformed stored marker as "not sent today" rather than trusting it', () => {
    localStorage.setItem(scopedInstallDayStorageKey(SCOPE), 'not-a-number');
    expect(makeWebInstallIdSupplier(SCOPE, () => 10 * DAY_MS)()).not.toBeNull();
  });

  it('treats a numeric-prefix-plus-garbage marker as malformed, not as a loose match', () => {
    // Number.parseInt('10abc', 10) === 10, so a naive parse would treat this
    // as a legitimate "already sent on day 10" marker and wrongly suppress.
    // Swift's Int(String) and Kotlin's toLongOrNull() are both strict and
    // return nil/null for "10abc" — validation here must match that
    // strictness so web isn't the one platform that disagrees on what
    // counts as a valid marker.
    localStorage.setItem(scopedInstallDayStorageKey(SCOPE), '10abc');
    expect(makeWebInstallIdSupplier(SCOPE, () => 10 * DAY_MS)()).not.toBeNull();
  });

  it('returns null rather than throwing when the clock throws', () => {
    const supplier = makeWebInstallIdSupplier(SCOPE, () => {
      throw new Error('clock exploded');
    });
    expect(supplier()).toBeNull();
  });
});

describe('web adapter: the identifier rides at most one refetch per day', () => {
  const adapters: WebPlatformAdapter[] = [];
  afterEach(() => {
    while (adapters.length) adapters.pop()!.__testCleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  // `__forceConfigRefreshForTesting` (as sketched in the task brief) does not
  // exist on this adapter. The real seam that forces a second, TTL-bypassing
  // config read is `__testRefreshConfigNow` (adapter.ts) — it is what
  // `refreshGate`/wake also delegates to, so this exercises the same forced
  // refresh path production code uses, not a parallel copy of it.
  it('sends installId on the first config read and omits it on an immediate refetch', async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return new Response(
        JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'txx_live_daily_adapter' });
    adapters.push(adapter);
    await adapter.__initReplay();
    await adapter.__testRefreshConfigNow();

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toContain('installId=');
    for (const url of seen.slice(1)) expect(url).not.toContain('installId=');
  });
});
