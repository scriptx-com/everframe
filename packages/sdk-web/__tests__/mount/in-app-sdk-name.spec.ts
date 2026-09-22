// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// RULING 18 — `submitReportFromDraft`'s `sdkName` defaults to
// `traceitx-react` (every caller predated `@traceitx/web`'s own `init()`), and
// nothing on the vanilla handle carries the name for it. If `init()`'s in-app
// submit path omits the argument, EVERY report a Vue / Svelte / plain-HTML
// host files through the reporter dialog — the highest-volume path there is —
// lands on ingest labelled as a React report, silently.
//
// sdk-identity.spec.ts asserts the same property for the CRASH path (which is
// closed by construction: the name is passed into the adapter alongside the
// handlers). This is its in-app twin, and it has to drive the real submit to
// be worth anything: asserting the constant, or that `init()` passes it
// somewhere, would not have caught the default.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { CaptureBundle } from '../../src/transport/draft-to-envelope.js';
import type { ReporterCompletePayload } from '../../src/reporter-ui/ReporterDialog.js';

const mountCalls: Array<{
  handlers: {
    onComplete(payload: ReporterCompletePayload): void;
    onCancel(): void;
  };
}> = [];

vi.mock('../../src/mount/react-island.js', () => ({
  mountIsland: (
    _shadow: ShadowRoot,
    _adapter: unknown,
    handlers: { onComplete(p: ReporterCompletePayload): void; onCancel(): void },
  ) => {
    mountCalls.push({ handlers });
    return {
      setOpen: () => undefined,
      setInboxOpen: () => undefined,
      toast: () => undefined,
      unmount: () => undefined,
    };
  },
}));

import { init, type TraceItXHandle } from '../../src/init.js';

let handle: TraceItXHandle | null = null;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ status: 'received', reportId: 'r_1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  handle?.destroy();
  handle = null;
  mountCalls.length = 0;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

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

/** The envelope of the first request that actually carried one. */
async function submittedEnvelope(): Promise<{ sdk: { name: string; version: string } }> {
  const call = await vi.waitFor(() => {
    const found = fetchMock.mock.calls.find(
      (c) => c[1]?.body instanceof FormData && (c[1].body as FormData).get('envelope'),
    );
    expect(found).toBeTruthy();
    return found!;
  });
  const body = call[1].body as FormData;
  return JSON.parse(await (body.get('envelope') as Blob).text());
}

describe('in-app report submitted from the island', () => {
  it("stamps envelope.sdk.name as 'traceitx-web', not the traceitx-react default", async () => {
    handle = init({ apiKey: 'pk_test', appVersion: '1.0.0' });
    void handle.open();
    await vi.waitFor(() => expect(mountCalls).toHaveLength(1));

    mountCalls[0]!.handlers.onComplete(payload());

    const envelope = await submittedEnvelope();
    expect(envelope.sdk.name).toBe('traceitx-web');
  });

  it('settles the pending open() with the submitted report id', async () => {
    handle = init({ apiKey: 'pk_test', appVersion: '1.0.0' });
    const pending = handle.open();
    await vi.waitFor(() => expect(mountCalls).toHaveLength(1));

    mountCalls[0]!.handlers.onComplete(payload());

    await expect(pending).resolves.toMatchObject({ status: 'submitted' });
  });
});
