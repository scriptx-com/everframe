// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Codex round-2 finding 1 (P1, kill switch). Round 1 gated OPENING the
// reporter — `__openReporter()` in the shared adapter, and `openModal()` for
// the hotkey — but not SUBMITTING a reporter that was already open.
//
// The sequence that shipped user pixels after consent was withdrawn:
//
//   1. the user opens the reporter (screenshot, logs, network entries and the
//      breadcrumb chain are captured and frozen at that instant);
//   2. the host calls `kill()` — consent withdrawal, a GDPR erasure request,
//      a privacy toggle flipping off;
//   3. the user presses Send.
//
// `submitFromIsland` had no gate at all, so everything captured in step 1 was
// POSTed — or, offline, written to the origin-wide outbox to be POSTed later —
// while README.md's `kill()` row promises "stops this instance from capturing
// or submitting anything further".
//
// Every test below is paired with a LIVE control running the identical path on
// a non-killed handle, so a gate that swallowed the whole submit flow (or a
// harness that never reached it) fails exactly as loudly as the missing gate.
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

/**
 * `/api/config` and `/api/reporter/threads` answer; ANY other URL is the
 * ingest POST — which is the single thing these tests are counting.
 */
function stubFetch(): { ingestCalls: () => string[] } {
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

const payload = (): ReporterCompletePayload => ({
  title: 'Broken checkout',
  description: '',
  excludedArtifacts: [],
  annotations: [],
  redactions: [],
  screenshotBlob: null,
  bundle: { ...bundle },
  capturedIdentityToken: null,
  capturedUser: null,
});

/**
 * Open the reporter and wait for the island the dialog would have mounted.
 * The `open()` promise is returned WRAPPED — an `async` function flattens a
 * returned promise, which would silently await the very thing under test.
 */
async function openReporter(): Promise<{ opened: Promise<unknown> }> {
  handle = init({ apiKey: 'txx_live_kill_submit' }) as InternalHandle;
  const opened = handle.open();
  await vi.waitFor(() => expect(islands).toHaveLength(1));
  return { opened };
}

/** Resolve to the settled value, or 'PENDING' after `ms` — a promise that
 *  never settles becomes a readable diff instead of a spec timeout. */
async function settledWithin<T>(p: Promise<T>, ms = 80): Promise<T | 'PENDING'> {
  return Promise.race([p, new Promise<'PENDING'>((r) => setTimeout(() => r('PENDING'), ms))]);
}

describe('finding 1 — a reporter already open when kill() lands must not submit', () => {
  it('LIVE control: the same Send POSTs the report and toasts success', async () => {
    const { ingestCalls } = stubFetch();
    const { opened } = await openReporter();

    islands[0]!.opts.onComplete(payload());

    await vi.waitFor(() => expect(ingestCalls()).toHaveLength(1));
    await vi.waitFor(() => expect(islands[0]!.toast).toHaveBeenCalledWith('success', 'Report sent'));
    expect(await settledWithin(opened)).toMatchObject({ status: 'submitted' });
  });

  it('sends nothing to ingest once the switch is pulled', async () => {
    const { ingestCalls } = stubFetch();
    await openReporter();

    handle!.kill();
    islands[0]!.opts.onComplete(payload());

    // A generous settle window: the LIVE control's POST lands well inside it.
    await new Promise((r) => setTimeout(r, 80));
    expect(ingestCalls()).toEqual([]);
  });

  it('queues nothing either — the outbox is not a way around the switch', async () => {
    stubFetch();
    await openReporter();

    handle!.kill();
    islands[0]!.opts.onComplete(payload());

    await new Promise((r) => setTimeout(r, 80));
    expect(await handle!.__adapter.outbox!.list()).toEqual([]);
  });

  it('tells the user their report was not sent rather than dropping it silently', async () => {
    stubFetch();
    await openReporter();

    handle!.kill();
    islands[0]!.opts.onComplete(payload());

    await vi.waitFor(() =>
      expect(islands[0]!.toast).toHaveBeenCalledWith(
        'warning',
        'Reporting is turned off — this report was not sent.',
      ),
    );
  });

  it("settles open() with cancelled/killed instead of hanging the host's await", async () => {
    stubFetch();
    const { opened } = await openReporter();

    handle!.kill();
    islands[0]!.opts.onComplete(payload());

    expect(await settledWithin(opened)).toEqual({ status: 'cancelled', reason: 'killed' });
  });

  // The freeze `openModal()` takes is released on this path too. It costs
  // nothing here (a killed client captures nothing anyway) but it is the same
  // `unwindOpen` the cancel and island-failure paths use, and a submit gate
  // that left the buffers frozen would be a latent bug the moment the gate
  // moved to a revivable flag.
  it("resolves sdk-core's showReporterUI promise as a discarded report", async () => {
    stubFetch();
    await openReporter();
    const viaCore = handle!.__adapter.showReporterUI({
      title: '',
      description: '',
      excludedArtifacts: [],
      annotations: [],
      redactions: [],
    } as never);

    handle!.kill();
    islands[0]!.opts.onComplete(payload());

    expect(await settledWithin(viaCore)).toBeNull();
  });
});
