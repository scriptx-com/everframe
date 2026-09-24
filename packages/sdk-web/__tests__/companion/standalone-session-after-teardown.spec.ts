// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Codex round-5 finding 3 (P2) — a teardown retired the companion for the life
// of the page.
//
// Round 4 made the seam fail CLOSED once a published host had been torn down,
// which is right: a companion session that outlives its host's `destroy()` must
// not silently downgrade to the standalone screenshot handler and keep
// photographing the user's screen. But the latch was a page-global boolean
// cleared only by another SDK-host publication, so the OTHER supported entry
// point — `companion.stop()` then `companion.start()`, a deliberate
// companion-only session with no Provider and no `init()` — answered
// `submit_unavailable` to every `report.request` until the page reloaded. That
// degraded the published `@everframe/react` package too, which re-exports this
// singleton.
//
// The seam carries identity now: `companion.start()` takes a ticket, so the
// question is "has a host been torn down since MY session opened?" rather than
// "has one ever been torn down here?". This spec drives BOTH answers through
// the real singleton, the real ws-client and a real relay frame — the session
// that predates the teardown is still refused (round 4, unregressed), and the
// one started after it works.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The standalone `report.request` path captures through the module-level
// screenshot helper, which jsdom cannot render. Its call count IS the
// "were the user's pixels read?" assertion.
vi.mock('../../src/capture/screenshot.js', () => ({
  captureScreenshot: vi.fn(async () => ({
    blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47]) as BlobPart], {
      type: 'image/png',
    }),
    width: 1280,
    height: 720,
    sha256: 'deadbeef',
  })),
}));

// Nothing here opens the reporter; stub the island so a stray open cannot drag
// React into a companion spec.
vi.mock('../../src/mount/react-island.js', () => ({
  mountIsland: () => ({
    setOpen: () => undefined,
    setInboxOpen: () => undefined,
    toast: () => undefined,
    unmount: () => undefined,
  }),
}));

import { captureScreenshot } from '../../src/capture/screenshot.js';
import * as companion from '../../src/companion/singleton.js';
import { __resetPinSurfaceStateForTests } from '../../src/companion/singleton.js';
import { __resetDeviceIdForTests } from '../../src/companion/device-id.js';
import { __resetCompanionHostForTests } from '../../src/companion/host-seam.js';
import { init, type Everframe } from '../../src/init.js';

const screenshotMock = vi.mocked(captureScreenshot);

interface FakeWS {
  url: string;
  readyState: number;
  binaryType: string;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  addEventListener: (name: string, handler: (ev: unknown) => void) => void;
  _open: () => void;
  _message: (data: string) => void;
}

let lastWS: FakeWS | null = null;

function fakeWebSocketCtor(): typeof WebSocket {
  return function FakeWSCtor(url: string): FakeWS {
    const handlers: Record<string, ((ev: unknown) => void)[]> = {
      open: [],
      message: [],
      close: [],
      error: [],
    };
    const ws: FakeWS = {
      url,
      readyState: 0,
      binaryType: 'blob',
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: (name, handler) => {
        handlers[name]?.push(handler);
      },
      _open: () => {
        ws.readyState = 1;
        for (const h of handlers.open!) h({});
      },
      _message: (data) => {
        for (const h of handlers.message!) h({ data });
      },
    };
    (ws as unknown as { OPEN: number }).OPEN = 1;
    lastWS = ws;
    return ws;
  } as unknown as typeof WebSocket;
}

const START_OPTS = { endpoint: 'https://relay.example.com' };

/** Open the socket and bond, so `report.request` is accepted by the state machine. */
function bond(): void {
  lastWS!._open();
  lastWS!._message(
    JSON.stringify({
      type: 'pair.bonded',
      pair_id: 'p-1',
      device_token: 'dev-xyz',
      device_token_expires_at: '2026-12-31T00:00:00Z',
    }),
  );
}

/** Deliver a `report.request` and wait for the device to answer the phone. */
async function requestReport(correlationId: string): Promise<string[]> {
  const before = lastWS!.send.mock.calls.length;
  lastWS!._message(JSON.stringify({ type: 'report.request', correlation_id: correlationId }));
  await vi.waitFor(() => expect(lastWS!.send.mock.calls.length).toBeGreaterThan(before));
  return lastWS!.send.mock.calls
    .slice(before)
    .filter((c) => typeof c[0] === 'string')
    .map((c) => (JSON.parse(c[0] as string) as { type: string }).type);
}

let handle: Everframe | null = null;

beforeEach(() => {
  lastWS = null;
  screenshotMock.mockClear();
  __resetCompanionHostForTests();
  __resetPinSurfaceStateForTests();
  __resetDeviceIdForTests();
  vi.stubGlobal('WebSocket', fakeWebSocketCtor());
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ),
  );
});

afterEach(() => {
  companion.stop();
  handle?.destroy();
  handle = null;
  __resetCompanionHostForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('a companion-only session started after a teardown', () => {
  it('LIVE control: a session on a page that never had a host captures', async () => {
    // The never-started standalone posture round 4 deliberately preserved.
    companion.start(START_OPTS);
    bond();

    expect(await requestReport('c-0')).toContain('report.assembled');
    expect(screenshotMock).toHaveBeenCalledTimes(1);
  });

  it('DISCRIMINATOR: the session that outlived the teardown is still refused', async () => {
    // Round 4's finding, unregressed: `destroy()` under a LIVE companion
    // session must not leave that session falling back to standalone capture.
    handle = init({ apiKey: 'txx_live_test' });
    companion.start(START_OPTS);
    bond();

    handle.destroy();
    handle = null;

    expect(await requestReport('c-1')).toContain('report.failed');
    expect(screenshotMock).not.toHaveBeenCalled();
  });

  it('works again after stop() → start(), without a reload', async () => {
    handle = init({ apiKey: 'txx_live_test' });
    companion.start(START_OPTS);
    bond();

    handle.destroy();
    handle = null;

    // The supported standalone entry point, taken deliberately after the SDK
    // mount is gone. Before the fix this session inherited the previous host's
    // teardown and answered `submit_unavailable` to every report for the life
    // of the page.
    companion.stop();
    companion.start(START_OPTS);
    bond();

    expect(await requestReport('c-2')).toContain('report.assembled');
    expect(screenshotMock).toHaveBeenCalledTimes(1);
  });

  it('and a LATER teardown still closes that session down', async () => {
    // The fix must not be a one-way door: a session started after teardown A
    // is legitimate, but if it then acquires and loses a host of its own, the
    // round-4 refusal has to apply to it too.
    handle = init({ apiKey: 'txx_live_test' });
    handle.destroy();
    handle = null;

    companion.start(START_OPTS); // clean session — teardown A predates it
    bond();

    handle = init({ apiKey: 'txx_live_test' }); // a host publishes
    handle.destroy(); // …and is torn down under the running session
    handle = null;

    expect(await requestReport('c-3')).toContain('report.failed');
    expect(screenshotMock).not.toHaveBeenCalled();
  });
});
