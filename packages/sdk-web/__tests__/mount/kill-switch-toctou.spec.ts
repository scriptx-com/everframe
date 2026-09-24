// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Codex round-3 finding 3 (P1) — the in-app submit kill gate was TOCTOU.
//
// `kill-switch-submit.spec.ts` (round 2) covers the case where the switch is
// pulled BEFORE Send. This covers the case it could not: the switch pulled
// AFTER Send, while the submit path is still doing its asynchronous
// preparation — identity capture (which may invoke the host's provider),
// replay completion (scrub + gzip of the whole recorded window), SHA-256
// hashing. On a real replay that is hundreds of milliseconds, and the entry
// gate at the top of `submitFromIsland` had long since passed.
//
// Two distinct holes, two describes:
//   1. the report itself still POSTed / queued;
//   2. even when it did not, a submit that SUCCEEDED before the kill landed
//      then started an ungated outbox drain, flushing every OTHER queued
//      report off the device.
//
// Both are paired with a live control on the identical (deferred) harness, so
// a gate that swallowed the whole submit flow fails as loudly as no gate.
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ReporterCompletePayload } from '../../src/reporter-ui/ReporterDialog.js';
import type { CaptureBundle } from '../../src/transport/draft-to-envelope.js';

interface IslandOpts {
  onComplete(payload: ReporterCompletePayload): void;
  onCancel(): void;
  onNewReport(): void;
}

const islands: Array<{
  opts: IslandOpts;
  setOpen: ReturnType<typeof vi.fn>;
  setInboxOpen: ReturnType<typeof vi.fn>;
  toast: ReturnType<typeof vi.fn>;
  unmount: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('../../src/mount/react-island.js', () => ({
  mountIsland: (_root: ShadowRoot, _adapter: unknown, opts: IslandOpts) => {
    const island = {
      opts,
      setOpen: vi.fn(),
      setInboxOpen: vi.fn(),
      toast: vi.fn(),
      unmount: vi.fn(),
    };
    islands.push(island);
    return {
      setOpen: island.setOpen,
      setInboxOpen: island.setInboxOpen,
      toast: island.toast,
      unmount: island.unmount,
    };
  },
}));

import { init, type Everframe, type InternalHandle } from '../../src/init.js';

let handle: InternalHandle | null = null;

afterEach(() => {
  (handle as Everframe | null)?.destroy();
  handle = null;
  islands.length = 0;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const bundle: CaptureBundle = {
  screenshotBlob: null,
  screenshotSha256: null,
  screenshotWidth: 0,
  screenshotHeight: 0,
  focused: null,
  logs: [],
  network: [],
  metadata: {
    os: 'macOS',
    osVersion: '14.0',
    screenSize: { width: 1, height: 1 },
    pixelRatio: 1,
    locale: 'en',
    timezone: 'UTC',
  },
};

/**
 * `capturedIdentityToken: undefined` is what routes the submit through
 * `adapter.__captureIdentityAtSubmitBoundary()` — the await this spec hijacks
 * to hold the submit open. `null` (what the round-2 spec uses) short-circuits
 * it and there would be no window to test.
 */
const payload = (): ReporterCompletePayload => ({
  title: 'Broken checkout',
  description: '',
  excludedArtifacts: [],
  annotations: [],
  redactions: [],
  screenshotBlob: null,
  bundle: { ...bundle },
  capturedIdentityToken: undefined,
  capturedUser: null,
});

/** Config/threads answer immediately; anything else is the ingest POST. */
function stubFetch(ingest?: () => Promise<Response>): { ingestCalls: () => string[] } {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/config')) {
      return new Response(
        JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/api/reporter/threads')) {
      return new Response(JSON.stringify({ threads: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (ingest) return ingest();
    return new Response(JSON.stringify({ status: 'received', reportId: 'r_1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', impl);
  return {
    ingestCalls: () =>
      impl.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => !u.includes('/api/config') && !u.includes('/api/reporter/threads')),
  };
}

async function openReporter(): Promise<{ opened: Promise<unknown> }> {
  handle = init({ apiKey: 'txx_live_toctou' }) as InternalHandle;
  const opened = handle.open();
  await vi.waitFor(() => expect(islands).toHaveLength(1));
  return { opened };
}

async function settledWithin<T>(p: Promise<T>, ms = 80): Promise<T | 'PENDING'> {
  return Promise.race([p, new Promise<'PENDING'>((r) => setTimeout(() => r('PENDING'), ms))]);
}

describe('kill() landing DURING submit preparation', () => {
  /** Hold the submit open at the identity-capture await, the way a slow
   *  host token provider or a large replay gzip does in the field. */
  async function openWithHeldPrep(): Promise<{
    opened: Promise<unknown>;
    releasePrep: (v: string | null) => void;
  }> {
    const { opened } = await openReporter();
    const prep = deferred<string | null>();
    // Replaced on the adapter object rather than stubbed at the module: this
    // is the exact property init.ts reads, at call time.
    (
      handle!.__adapter as unknown as {
        __captureIdentityAtSubmitBoundary: () => Promise<string | null>;
      }
    ).__captureIdentityAtSubmitBoundary = () => prep.promise;
    return { opened, releasePrep: prep.resolve };
  }

  it('LIVE control: the same held prep, released without a kill, POSTs', async () => {
    const { ingestCalls } = stubFetch();
    const { opened, releasePrep } = await openWithHeldPrep();

    islands[0]!.opts.onComplete(payload());
    await new Promise((r) => setTimeout(r, 10)); // parked on the prep await
    expect(ingestCalls()).toEqual([]); // …proving the harness really holds it

    releasePrep(null);

    await vi.waitFor(() => expect(ingestCalls()).toHaveLength(1));
    expect(await settledWithin(opened)).toMatchObject({ status: 'submitted' });
  });

  it('sends nothing once the switch is pulled mid-preparation', async () => {
    const { ingestCalls } = stubFetch();
    const { releasePrep } = await openWithHeldPrep();

    islands[0]!.opts.onComplete(payload());
    await new Promise((r) => setTimeout(r, 10));
    handle!.kill(); // the user withdraws consent while compression/hashing runs
    releasePrep(null);

    await new Promise((r) => setTimeout(r, 80));
    expect(ingestCalls()).toEqual([]);
  });

  // NOTE — deliberately no separate "and queues nothing either" case here.
  // The gate sits BEFORE `submitReportFromDraft`, and queueing only happens
  // inside it, after a retry burst it never gets to start; an outbox
  // assertion would therefore pass whether the gate existed or not. The
  // ingest-call assertion above is the one that can actually fail.

  it('tells the user, and settles open() rather than hanging it', async () => {
    stubFetch();
    const { opened, releasePrep } = await openWithHeldPrep();

    islands[0]!.opts.onComplete(payload());
    await new Promise((r) => setTimeout(r, 10));
    handle!.kill();
    releasePrep(null);

    await vi.waitFor(() =>
      expect(islands[0]!.toast).toHaveBeenCalledWith(
        'warning',
        'Reporting is turned off — this report was not sent.',
      ),
    );
    expect(await settledWithin(opened)).toEqual({ status: 'cancelled', reason: 'killed' });
  });
});

describe('kill() landing while the ingest POST is in flight', () => {
  /**
   * The second half of the finding: the report's own POST had already left,
   * so the switch cannot un-send it — but its success branch then drained the
   * ORIGIN-WIDE outbox, shipping every other queued report off a device whose
   * owner had just withdrawn consent.
   */
  async function submitWithHeldIngest(kill: boolean): Promise<{
    ingestCalls: () => string[];
    queuedIds: () => Promise<string[]>;
  }> {
    const gate = deferred<Response>();
    const { ingestCalls } = stubFetch(() => gate.promise);
    await openReporter();

    // A report queued by an earlier (offline) session, waiting on the drain.
    await handle!.__adapter.outbox!.enqueue({
      reportId: 'queued_from_last_session',
      enqueuedAt: Date.now(),
      attempts: 0,
      payload: new TextEncoder().encode('{}'),
      metadata: { url: 'https://ingest.test/api/ingest', sdkKey: 'txx_live_toctou' },
    });

    islands[0]!.opts.onComplete(payload());
    await vi.waitFor(() => expect(ingestCalls()).toHaveLength(1)); // the POST is out
    if (kill) handle!.kill();
    gate.resolve(
      new Response(JSON.stringify({ status: 'received', reportId: 'r_1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await new Promise((r) => setTimeout(r, 80));
    return {
      ingestCalls,
      queuedIds: async () => (await handle!.__adapter.outbox!.list()).map((i) => i.reportId),
    };
  }

  it('LIVE control: a successful submit drains the queued report', async () => {
    const { ingestCalls, queuedIds } = await submitWithHeldIngest(false);

    expect(ingestCalls().length).toBeGreaterThan(1); // the report AND the drain
    expect(await queuedIds()).toEqual([]);
  });

  it('does not drain the outbox when the switch was pulled mid-flight', async () => {
    const { ingestCalls, queuedIds } = await submitWithHeldIngest(true);

    expect(ingestCalls()).toHaveLength(1); // only the report already in flight
    expect(await queuedIds()).toEqual(['queued_from_last_session']);
  });
});
