// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Fix round 1, findings 2 and 3 — the two surfaces `provider.tsx` renders that
// the vanilla island was missing.
//
// Finding 2: the FAB is gated on `count > 0` and labelled "Your reports — N
// unread", so it only ever appears on a device that HAS conversations. Wiring
// it to `openModal()` gave that user a blank report form, no way to read a
// reply, and an unread count that never cleared. provider.tsx opens
// `InboxDialog` and refreshes the poller; the new-report path is reached from
// INSIDE the inbox, and routes through `openModal()` so REPLAY-02's freeze
// still happens.
//
// Finding 3: `provider.tsx` raises a toast at each of the three submit
// outcomes. Without one, a successful send, an offline queue and a hard
// failure are indistinguishable — `ReporterDialog.onComplete` closes the
// dialog first, so it just vanishes. The outcome does reach a host that
// awaited `open()`, but the FAB and hotkey call `openModal()` directly and
// never stage that promise, so on the two triggers a real user actually uses
// nobody learns anything.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { __internalClientState } from '@traceitx/sdk-core';
import type { ReporterCompletePayload } from '../../src/reporter-ui/ReporterDialog.js';
import type { CaptureBundle } from '../../src/transport/draft-to-envelope.js';
import { REPORTER_TOKEN_STORAGE_KEY } from '../../src/reporter/credential-store.js';

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

/**
 * A retryable failure is genuinely retryable: `submitReportFromDraft` walks
 * sdk-core's DEFAULT_RETRY_SCHEDULE_MS ([1s, 2s, 4s, 8s, 16s], ~31s) before it
 * reports `retryable: true`, and init() has no seam to shorten that. So for
 * that ONE case the transport is overridden to return the outcome directly —
 * what is under test there is init.ts's routing from outcome to toast, not the
 * retry walk, which transport/submit.spec.ts already covers. Every other case
 * here runs the real transport against a stubbed fetch.
 */
let submitOverride: ((opts: unknown) => Promise<unknown>) | null = null;
vi.mock('../../src/transport/submit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/transport/submit.js')>();
  return {
    ...actual,
    submitReportFromDraft: (opts: Parameters<typeof actual.submitReportFromDraft>[0]) =>
      submitOverride
        ? (submitOverride(opts) as ReturnType<typeof actual.submitReportFromDraft>)
        : actual.submitReportFromDraft(opts),
  };
});

vi.mock('../../src/mount/react-island.js', () => ({
  mountIsland: (_shadow: ShadowRoot, _adapter: unknown, opts: IslandOpts) => {
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

import { init, type TraceItXHandle, type InternalHandle } from '../../src/init.js';

let handle: TraceItXHandle | null = null;

afterEach(() => {
  handle?.destroy();
  handle = null;
  submitOverride = null;
  islands.length = 0;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

const oneOpenThread = [
  {
    id: 'thread-1',
    status: 'open',
    reportTitle: 'Broken checkout',
    createdAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    unreadCount: 2,
  },
];

/** `/api/config` + `/api/reporter/threads`; the ingest POST answers per `ingest`. */
function stubFetch(opts: {
  threads?: unknown[];
  ingest?: { status: number; body?: string };
}): ReturnType<typeof vi.fn> {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/config')) {
      return new Response(
        JSON.stringify({
          replayEnabled: false,
          replayDurationSec: 30,
          samplingRate: 1,
          replies: { enabled: true },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/api/reporter/threads')) {
      return new Response(JSON.stringify({ threads: opts.threads ?? [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const ingest = opts.ingest ?? { status: 200 };
    return new Response(ingest.body ?? JSON.stringify({ status: 'received', reportId: 'r_1' }), {
      status: ingest.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', impl);
  return impl;
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

function shadow(): ShadowRoot {
  const root = document.getElementById('traceitx-host')?.shadowRoot;
  if (!root) throw new Error('no shadow root');
  return root;
}

async function fabWithThread(): Promise<HTMLButtonElement> {
  localStorage.setItem(REPORTER_TOKEN_STORAGE_KEY, `txr_${'0'.repeat(36)}`);
  stubFetch({ threads: oneOpenThread });
  handle = init({ apiKey: 'txx_live_test' });
  return await vi.waitFor(
    () => {
      const fab = shadow().querySelector('[data-testid=reporter-fab]');
      expect(fab).not.toBeNull();
      return fab as HTMLButtonElement;
    },
    { timeout: 3000 },
  );
}

describe('finding 2 — the FAB opens the inbox, mirroring provider.tsx', () => {
  it('opens InboxDialog, NOT a blank report form', async () => {
    const fab = await fabWithThread();
    fab.click();
    await vi.waitFor(() => expect(islands).toHaveLength(1));
    await vi.waitFor(() => expect(islands[0]!.setInboxOpen).toHaveBeenCalledWith(true));
    expect(islands[0]!.setOpen).not.toHaveBeenCalled();
  });

  it('refreshes the thread poller immediately, so the inbox is not stale', async () => {
    const fab = await fabWithThread();
    const refresh = vi.spyOn((handle as InternalHandle).__adapter.threads!, 'refresh');
    fab.click();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("routes the inbox's onNewReport through openModal — REPLAY-02 freeze included", async () => {
    const fab = await fabWithThread();
    fab.click();
    await vi.waitFor(() => expect(islands).toHaveLength(1));

    const buffers = __internalClientState.get((handle as InternalHandle).__client);
    const freeze = vi.spyOn(buffers!.breadcrumbs, 'freeze');

    islands[0]!.opts.onNewReport();

    // A bare `setOpen(true)` would open the reporter without freezing, and the
    // reporter would then be recorded into its own breadcrumb chain.
    expect(freeze).toHaveBeenCalled();
    await vi.waitFor(() => expect(islands[0]!.setOpen).toHaveBeenCalledWith(true));
  });
});

describe('finding 3 — every submit outcome is visible', () => {
  async function openAndComplete(ingest: { status: number; body?: string }): Promise<void> {
    stubFetch({ ingest });
    handle = init({ apiKey: 'txx_live_test' });
    void handle.open();
    await vi.waitFor(() => expect(islands).toHaveLength(1));
    islands[0]!.opts.onComplete(payload());
  }

  it('raises the success toast, in provider.tsx’s exact copy', async () => {
    await openAndComplete({ status: 200 });
    await vi.waitFor(() =>
      expect(islands[0]!.toast).toHaveBeenCalledWith('success', 'Report sent'),
    );
  });

  it('says the team can reply when the submit provisioned a thread', async () => {
    await openAndComplete({
      status: 200,
      body: JSON.stringify({ status: 'received', reportId: 'r_1', thread: { id: 'th_1' } }),
    });
    await vi.waitFor(() =>
      expect(islands[0]!.toast).toHaveBeenCalledWith(
        'success',
        'Report sent — the team can reply here.',
      ),
    );
  });

  it('warns that a retryable failure was queued offline', async () => {
    submitOverride = async () => ({
      ok: false,
      retryable: true,
      reportId: 'r_queued',
      threadId: null,
    });
    await openAndComplete({ status: 503 });
    await vi.waitFor(() =>
      expect(islands[0]!.toast).toHaveBeenCalledWith(
        'warning',
        "Saved offline — will retry when you're back online.",
      ),
    );
  });

  it('reports a non-retryable failure as an error', async () => {
    await openAndComplete({ status: 401 });
    await vi.waitFor(() =>
      expect(islands[0]!.toast).toHaveBeenCalledWith(
        'error',
        "Couldn't send report. Check your SDK key configuration.",
      ),
    );
  });
});
