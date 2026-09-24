// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 06.2-09 Task 1 — ws-client.ts unit specs. Mocks `WebSocket` and
// drives the message handlers directly; no live network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCompanion } from '../../src/companion/state.js';
import { createRelayWSClient } from '../../src/companion/ws-client.js';
import {
  resolveCompanionDeviceId,
  __resetDeviceIdForTests,
} from '../../src/companion/device-id.js';

interface FakeWS {
  url: string;
  readyState: number;
  binaryType: string;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  addEventListener: (name: string, handler: (ev: unknown) => void) => void;
  // test handles
  _open: () => void;
  _message: (data: string | ArrayBuffer) => void;
  _close: (code: number) => void;
}

let lastWS: FakeWS | null = null;

function makeFakeWSCtor(): typeof WebSocket {
  return function FakeWS(url: string): FakeWS {
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
      _close: (code) => {
        ws.readyState = 3;
        for (const h of handlers.close!) h({ code });
      },
    };
    lastWS = ws;
    // OPEN constant on instance (matches WebSocket browser shape).
    (ws as unknown as { OPEN: number }).OPEN = 1;
    return ws;
  } as unknown as typeof WebSocket;
}

function makeStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

describe('companion/ws-client', () => {
  beforeEach(() => {
    lastWS = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects on start() and pair.created updates pairUrl', () => {
    const companion = createCompanion();
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
    });

    client.start();
    expect(lastWS).not.toBeNull();
    expect(lastWS!.url).toBe('wss://relay.example.com/relay/tv');
    expect(lastWS!.binaryType).toBe('arraybuffer');

    lastWS!._open();
    lastWS!._message(
      JSON.stringify({
        type: 'pair.created',
        pair_id: 'p-1',
        pair_token: 'tok-abc',
      }),
    );

    expect(companion.getPairUrl()).toBe(
      'https://relay.example.com/r/tok-abc',
    );
    expect(companion.getState()).toBe('unpaired');
  });

  it('refuses preview.start and shot.request explicitly instead of ignoring them', () => {
    // The web device side of live preview is not built yet (plan Task 9), but
    // the shared reporter sends these to EVERY device. Falling through to the
    // default branch left the phone's preview viewport open on an empty frame
    // until its ten-second timeout, and left a snapped shot `pending` forever
    // — which the submit's ready-filter then silently dropped.
    const companion = createCompanion();
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
    });
    client.start();
    lastWS!._open();

    lastWS!._message(
      JSON.stringify({ type: 'preview.start', correlation_id: 'c1' }),
    );
    lastWS!._message(
      JSON.stringify({ type: 'shot.request', correlation_id: 'c1', shot_id: 's1' }),
    );

    const sent = (lastWS!.send as unknown as { mock: { calls: string[][] } }).mock.calls.map(
      (c) => JSON.parse(c[0]!) as { type: string; reason?: string; shot_id?: string },
    );
    const stop = sent.find((m) => m.type === 'preview.stop');
    expect(stop, 'preview.start must be answered, not ignored').toBeDefined();
    expect(stop!.reason).toBe('capture_unavailable');
    const failed = sent.find((m) => m.type === 'shot.failed');
    expect(failed, 'shot.request must be answered so the shot leaves pending').toBeDefined();
    expect(failed!.shot_id).toBe('s1');
    expect(failed!.reason).toBe('capture_unavailable');
  });

  it('pair.bonded sets state=paired, retains pairUrl, stores device_token', () => {
    const companion = createCompanion();
    const storage = makeStorage();
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage,
    });
    client.start();
    lastWS!._open();

    // Create the pair first so a pairUrl is present to retain.
    lastWS!._message(
      JSON.stringify({ type: 'pair.created', pair_id: 'p-1', pair_token: 'tok-abc' }),
    );
    expect(companion.getPairUrl()).toBe('https://relay.example.com/r/tok-abc');

    lastWS!._message(
      JSON.stringify({
        type: 'pair.bonded',
        pair_id: 'p-1',
        device_token: 'dev-xyz',
        device_token_expires_at: '2026-12-31T00:00:00Z',
      }),
    );

    expect(companion.getState()).toBe('paired');
    // pairUrl is RETAINED on bond — nulled only on socket close. Hosts hide
    // the QR off `state === 'paired'`, not off a null pairUrl.
    expect(companion.getPairUrl()).toBe('https://relay.example.com/r/tok-abc');
    expect(storage.getItem('everframe-companion:device-token')).toBe('dev-xyz');
  });

  it('surfaces inbound binary to onBinary as ArrayBuffer (incl. Blob delivery)', async () => {
    vi.useRealTimers(); // Blob.arrayBuffer() resolves on a real microtask
    const companion = createCompanion();
    const onBinary = vi.fn();
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      onBinary,
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
    });
    client.start();
    lastWS!._open();

    // ArrayBuffer delivery (binaryType honored) — synchronous.
    const ab = new Uint8Array([1, 2, 3]).buffer;
    lastWS!._message(ab);
    expect(onBinary).toHaveBeenCalledWith(ab);

    // Blob delivery (Tizen/WebOS may ignore binaryType) — converted to ArrayBuffer.
    const blob = new Blob([new Uint8Array([4, 5, 6])]);
    lastWS!._message(blob as unknown as ArrayBuffer);
    await vi.waitFor(() => expect(onBinary).toHaveBeenCalledTimes(2));
    const second = onBinary.mock.calls[1]![0] as ArrayBuffer;
    expect(second).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(second)).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('report.request fires onReportRequest and flips state to report_in_progress', () => {
    const companion = createCompanion();
    const onReportRequest = vi.fn();
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest,
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
    });
    client.start();
    lastWS!._open();
    // Move into paired first.
    lastWS!._message(
      JSON.stringify({
        type: 'pair.bonded',
        pair_id: 'p-1',
        device_token: 'dev-xyz',
        device_token_expires_at: '2026-12-31T00:00:00Z',
      }),
    );

    lastWS!._message(
      JSON.stringify({
        type: 'report.request',
        correlation_id: 'corr-1',
      }),
    );

    expect(onReportRequest).toHaveBeenCalledWith('corr-1');
    expect(companion.getState()).toBe('report_in_progress');
  });

  it('report.request carrying a fresh attribution_token overwrites the bond-time one (round-5 fix)', () => {
    const companion = createCompanion();
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
    });
    client.start();
    lastWS!._open();
    lastWS!._message(
      JSON.stringify({
        type: 'pair.bonded',
        pair_id: 'p-1',
        device_token: 'dev-xyz',
        device_token_expires_at: '2026-12-31T00:00:00Z',
        attribution_token: 'bond-time-token',
      }),
    );
    expect(client.getCompanionAttribution()).toBe('bond-time-token');

    lastWS!._message(
      JSON.stringify({
        type: 'report.request',
        correlation_id: 'corr-1',
        attribution_token: 'fresh-report-request-token',
      }),
    );

    expect(client.getCompanionAttribution()).toBe('fresh-report-request-token');
  });

  it('report.request with no attribution_token leaves the bond-time token in place — old server / QR pair degrade gracefully', () => {
    const companion = createCompanion();
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
    });
    client.start();
    lastWS!._open();
    lastWS!._message(
      JSON.stringify({
        type: 'pair.bonded',
        pair_id: 'p-1',
        device_token: 'dev-xyz',
        device_token_expires_at: '2026-12-31T00:00:00Z',
        attribution_token: 'bond-time-token',
      }),
    );

    // Old server (or an ordinary QR pair, which never gets one) — no field.
    lastWS!._message(
      JSON.stringify({ type: 'report.request', correlation_id: 'corr-1' }),
    );

    // NEVER FATAL / never a hard failure: the report still proceeds using
    // whatever token was already captured, degraded but not broken.
    expect(client.getCompanionAttribution()).toBe('bond-time-token');
  });

  it('close code 4002 drops to unpaired and clears device_token', () => {
    const companion = createCompanion();
    const storage = makeStorage();
    storage.setItem('everframe-companion:device-token', 'stale');
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage,
    });
    client.start();
    lastWS!._open();
    // create + bond first so state is `paired` and a pairUrl is present
    lastWS!._message(
      JSON.stringify({ type: 'pair.created', pair_id: 'p-1', pair_token: 'tok-abc' }),
    );
    lastWS!._message(
      JSON.stringify({
        type: 'pair.bonded',
        pair_id: 'p-1',
        device_token: 'dev-xyz',
        device_token_expires_at: '2026-12-31T00:00:00Z',
      }),
    );
    expect(companion.getState()).toBe('paired');
    expect(companion.getPairUrl()).toBe('https://relay.example.com/r/tok-abc');

    lastWS!._close(4002);

    expect(companion.getState()).toBe('unpaired');
    // Socket close is the one place pairUrl is nulled.
    expect(companion.getPairUrl()).toBeNull();
    expect(storage.getItem('everframe-companion:device-token')).toBeNull();
  });

  it('drops malformed text frames silently (zod safeParse failure)', () => {
    const companion = createCompanion();
    const onReportRequest = vi.fn();
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest,
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
    });
    client.start();
    lastWS!._open();

    // Missing required `type`
    lastWS!._message('{"foo":"bar"}');
    // Not JSON at all
    lastWS!._message('not-json');

    expect(onReportRequest).not.toHaveBeenCalled();
    expect(companion.getState()).toBe('unpaired');
  });

  it('send / sendBinary forward to socket when open', () => {
    const companion = createCompanion();
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
    });
    client.start();
    lastWS!._open();

    client.send({
      type: 'report.assembled',
      correlation_id: 'c-1',
      mime: 'image/png',
      size: 4,
      toggles: {
        logs: true,
        network: true,
        uiTree: true,
        metadata: true,
        screenshot: true,
      },
      counts: { logs: 0, network: 0, uiTreeNodes: 0 },
    });
    expect(lastWS!.send).toHaveBeenCalledTimes(1);
    expect(typeof (lastWS!.send.mock.calls[0]![0] as string)).toBe('string');

    const buf = new ArrayBuffer(8);
    client.sendBinary(buf);
    expect(lastWS!.send).toHaveBeenCalledTimes(2);
    expect(lastWS!.send.mock.calls[1]![0]).toBe(buf);
  });

  // Companion discovery (spec 2026-08-07, Task 16). These use the
  // `announceImpl` test seam (mirrors `webSocketCtor`/`storage`) rather than
  // mocking the `announce.js` module or global `fetch` — same idiom as the
  // rest of this file.
  it('announces before connecting when sdkKey is set, encoding the ticket in the URL', async () => {
    const companion = createCompanion();
    const announceImpl = vi.fn(async () => ({ ticket: 'tkt-1', code: 'C0DE', resolvedName: null }));
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
      sdkKey: 'txx_live_x',
      deviceLabel: 'Lobby TV',
      announceImpl,
    });

    client.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(announceImpl).toHaveBeenCalledTimes(1);
    expect(announceImpl).toHaveBeenCalledWith({
      endpoint: 'https://relay.example.com',
      sdkKey: 'txx_live_x',
      label: 'Lobby TV',
    });
    expect(lastWS).not.toBeNull();
    expect(lastWS!.url).toBe('wss://relay.example.com/relay/tv/tkt-1');
    expect(companion.getCode()).toBe('C0DE');
  });

  it('falls back to the plain /relay/tv URL (and clears code) when announce fails', async () => {
    const companion = createCompanion();
    // Every announce failure mode collapses to null — this stands in for
    // offline / revoked key / 404-on-an-older-server / timeout alike.
    const announceImpl = vi.fn(async () => null);
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
      sdkKey: 'txx_live_x',
      announceImpl,
    });

    client.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(announceImpl).toHaveBeenCalledTimes(1);
    expect(lastWS).not.toBeNull();
    // Exactly the ticketless URL a device with no sdkKey at all would use —
    // discovery failed, reporting did not.
    expect(lastWS!.url).toBe('wss://relay.example.com/relay/tv');
    expect(companion.getCode()).toBeNull();
  });

  it('re-announces on every connect attempt — a single-use ticket is never reused across a reconnect', async () => {
    const companion = createCompanion();
    let calls = 0;
    const announceImpl = vi.fn(async () => {
      calls += 1;
      return { ticket: `tkt-${calls}`, code: `CODE${calls}`, resolvedName: null };
    });
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
      sdkKey: 'txx_live_x',
      announceImpl,
    });

    client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(announceImpl).toHaveBeenCalledTimes(1);
    expect(lastWS!.url).toBe('wss://relay.example.com/relay/tv/tkt-1');

    // Transient drop (non-terminal close code) schedules a 1s-backoff
    // reconnect — that reconnect attempt must fetch its OWN ticket. If the
    // client instead reused the first ticket, this would be exactly the
    // "closes 4004 forever" bug the spec calls out.
    lastWS!._close(1006);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(announceImpl).toHaveBeenCalledTimes(2);
    expect(lastWS!.url).toBe('wss://relay.example.com/relay/tv/tkt-2');
  });

  // Device naming (naming spec 2026-08-24).
  it('a companion.name frame updates resolvedName', () => {
    const companion = createCompanion();
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
    });
    client.start();
    lastWS!._open();

    lastWS!._message(JSON.stringify({ type: 'companion.name', name: 'QA Lobby TV' }));

    expect(companion.getResolvedName()).toBe('QA Lobby TV');
  });

  it('ignores a companion.name frame whose name is empty or over 80 chars', () => {
    const companion = createCompanion();
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
    });
    client.start();
    lastWS!._open();

    lastWS!._message(JSON.stringify({ type: 'companion.name', name: '' }));
    lastWS!._message(JSON.stringify({ type: 'companion.name', name: 'x'.repeat(81) }));

    expect(companion.getResolvedName()).toBeNull();
  });

  it('announce resolvedName lands in state; deviceProvider result rides the announce body', async () => {
    const companion = createCompanion();
    const DEVICE = {
      id: '11111111-2222-4333-8444-555555555555', platform: 'web' as const,
      model: 'Samsung TV', osName: 'Tizen', osVersion: '7.0',
    };
    const announceImpl = vi.fn(async (o: Record<string, unknown>) => {
      expect(o.device).toEqual(DEVICE);
      return { ticket: 't1', code: 'AAAA', resolvedName: 'Samsung TV · Tizen 7.0' };
    });
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
      sdkKey: 'txx_live_x',
      deviceProvider: async () => DEVICE,
      announceImpl: announceImpl as never,
    });

    client.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(announceImpl).toHaveBeenCalledTimes(1);
    expect(companion.getResolvedName()).toBe('Samsung TV · Tizen 7.0');
  });

  it('a rejecting deviceProvider omits the device block rather than failing announce', async () => {
    const companion = createCompanion();
    const announceImpl = vi.fn(async (o: Record<string, unknown>) => {
      expect('device' in o).toBe(false);
      return { ticket: 't1', code: 'AAAA', resolvedName: null };
    });
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
      sdkKey: 'txx_live_x',
      deviceProvider: async () => { throw new Error('nope'); },
      announceImpl: announceImpl as never,
    });

    client.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(announceImpl).toHaveBeenCalledTimes(1);
    expect(companion.getResolvedName()).toBeNull();
  });

  // External review W1: a deviceProvider that never settles must not strand
  // the connect — the whole device-resolution step is bounded to
  // DEVICE_PREFLIGHT_TIMEOUT_MS (4s, round 2 W1), after which the attempt
  // proceeds WITHOUT a device block, same as any other preflight failure.
  it('a never-settling deviceProvider falls through after the 4s preflight timeout — announce still happens and the socket opens', async () => {
    const companion = createCompanion();
    const announceImpl = vi.fn(async (o: Record<string, unknown>) => {
      expect('device' in o).toBe(false);
      return { ticket: 't1', code: 'AAAA', resolvedName: null };
    });
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
      sdkKey: 'txx_live_x',
      deviceProvider: () => new Promise(() => {}), // never settles
      announceImpl: announceImpl as never,
    });

    client.start();
    await vi.advanceTimersByTimeAsync(4_000);

    expect(announceImpl).toHaveBeenCalledTimes(1);
    expect(lastWS).not.toBeNull();
    expect(lastWS!.url).toBe('wss://relay.example.com/relay/tv/t1');
  });

  // Round 2 W1: the outer preflight bound (4s) MUST exceed the slowest inner
  // adapter's own timeout (webOS Luna, 2s) so a hung platform bridge degrades
  // to the NEXT source in the chain (localStorage UUID) rather than to no
  // device block at all. Drives the REAL resolveCompanionDeviceId chain (not
  // a stub deviceProvider) through a webOS bridge whose Luna request never
  // fires onSuccess/onFailure, backstopped by working localStorage.
  it('a hung webOS Luna bridge still resolves to the localStorage id within the outer preflight bound', async () => {
    (window as { webOS?: unknown }).webOS = {
      service: {
        request: () => {
          // Deliberately never invoke onSuccess or onFailure — same hang
          // shape as device-id.spec.ts's Luna test.
        },
      },
    };
    __resetDeviceIdForTests();

    const companion = createCompanion();
    const announceImpl = vi.fn(async (o: Record<string, unknown>) => {
      // The localStorage UUID resolved inside the 4s outer bound (Luna's own
      // 2s timeout fired first) — the announce body DOES include a device
      // block, unlike the "never resolves at all" case above.
      expect(o.device).toMatchObject({ platform: 'web' });
      return { ticket: 't1', code: 'AAAA', resolvedName: null };
    });
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
      sdkKey: 'txx_live_x',
      deviceProvider: async () => {
        const id = await resolveCompanionDeviceId();
        return id === null ? null : { id, platform: 'web' as const, model: null, osName: null, osVersion: null };
      },
      announceImpl: announceImpl as never,
    });

    client.start();
    await vi.advanceTimersByTimeAsync(4_000);

    expect(announceImpl).toHaveBeenCalledTimes(1);
    expect(lastWS).not.toBeNull();
    expect(lastWS!.url).toBe('wss://relay.example.com/relay/tv/t1');

    delete (window as { webOS?: unknown }).webOS;
    localStorage.removeItem('everframe.companionDeviceId');
    __resetDeviceIdForTests();
  });

  // External review W1: a deviceProvider that throws SYNCHRONOUSLY (not an
  // async function returning a rejected promise) must not blow up
  // connectWithAnnounce before announce() is ever called — the sync throw
  // has to be converted to a rejection at the await boundary.
  it('a synchronously-throwing deviceProvider falls through — announce still happens and the socket opens', async () => {
    const companion = createCompanion();
    const announceImpl = vi.fn(async (o: Record<string, unknown>) => {
      expect('device' in o).toBe(false);
      return { ticket: 't1', code: 'AAAA', resolvedName: null };
    });
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
      sdkKey: 'txx_live_x',
      deviceProvider: (() => {
        throw new Error('sync boom');
      }) as never,
      announceImpl: announceImpl as never,
    });

    client.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(announceImpl).toHaveBeenCalledTimes(1);
    expect(lastWS).not.toBeNull();
    expect(lastWS!.url).toBe('wss://relay.example.com/relay/tv/t1');
  });

  // External review W2: a released bond ends the attach — the badge (gated
  // on attachedUserName) must not survive a detach. resolvedName is
  // deliberately kept: it's device identity, not attach state.
  it('pair.expired clears attachedUserName but keeps resolvedName — badge must not survive a detach', () => {
    const companion = createCompanion();
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
    });
    client.start();
    lastWS!._open();
    lastWS!._message(
      JSON.stringify({ type: 'pair.created', pair_id: 'p-1', pair_token: 'tok-abc' }),
    );
    lastWS!._message(
      JSON.stringify({
        type: 'pair.bonded',
        pair_id: 'p-1',
        device_token: 'dev-xyz',
        device_token_expires_at: '2026-12-31T00:00:00Z',
        companion_user: { display_name: 'Aurimas' },
      }),
    );
    expect(companion.getAttachedUserName()).toBe('Aurimas');
    companion.__setResolvedName('QA Lobby TV');

    lastWS!._message(
      JSON.stringify({ type: 'pair.expired', pair_id: 'p-1', reason: 'tv_disconnect' }),
    );

    expect(companion.getAttachedUserName()).toBeNull();
    expect(companion.getState()).toBe('unpaired');
    // Identity, not attach state — deliberately retained (REJECTED sub-point:
    // a missing display_name is guaranteed non-empty server-side, out of scope here).
    expect(companion.getResolvedName()).toBe('QA Lobby TV');
  });

  // Round 2 W2: the server destroys the pair record on ANY TV-socket close
  // (not just terminal codes), so a fresh `pair.created` arriving after a
  // non-terminal reconnect is, by construction, unbonded — yet
  // attachedUserName was previously left untouched by this handler, leaving
  // the badge claiming the old user is still attached indefinitely.
  it('a non-terminal reconnect that destroyed the bond clears attachedUserName on the fresh pair.created', () => {
    const companion = createCompanion();
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
    });
    client.start();
    lastWS!._open();
    lastWS!._message(
      JSON.stringify({ type: 'pair.created', pair_id: 'p-1', pair_token: 'tok-abc' }),
    );
    lastWS!._message(
      JSON.stringify({
        type: 'pair.bonded',
        pair_id: 'p-1',
        device_token: 'dev-xyz',
        device_token_expires_at: '2026-12-31T00:00:00Z',
        companion_user: { display_name: 'Aurimas' },
      }),
    );
    expect(companion.getAttachedUserName()).toBe('Aurimas');

    // Non-terminal close (e.g. 1006) — the server has already destroyed the
    // pair by the time the reconnect lands.
    lastWS!._close(1006);
    vi.advanceTimersByTime(1_000);

    lastWS!._message(
      JSON.stringify({ type: 'pair.created', pair_id: 'p-2', pair_token: 'tok-def' }),
    );
    expect(companion.getAttachedUserName()).toBeNull();

    // A rebond arrives as its own pair.bonded and re-sets the attach state.
    lastWS!._message(
      JSON.stringify({
        type: 'pair.bonded',
        pair_id: 'p-2',
        device_token: 'dev-uvw',
        device_token_expires_at: '2026-12-31T00:00:00Z',
        companion_user: { display_name: 'Someone Else' },
      }),
    );
    expect(companion.getAttachedUserName()).toBe('Someone Else');
  });

  it('announce failure clears resolvedName, same lifecycle as code', async () => {
    const companion = createCompanion();
    const announceImpl = vi.fn(async () => null);
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
      sdkKey: 'txx_live_x',
      announceImpl,
    });

    client.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(announceImpl).toHaveBeenCalledTimes(1);
    expect(companion.getResolvedName()).toBeNull();
  });

  it('resolvedName clears on terminal close, same lifecycle as code', () => {
    const companion = createCompanion();
    const storage = makeStorage();
    storage.setItem('everframe-companion:device-token', 'stale');
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage,
    });
    client.start();
    lastWS!._open();
    lastWS!._message(JSON.stringify({ type: 'companion.name', name: 'QA Lobby TV' }));
    expect(companion.getResolvedName()).toBe('QA Lobby TV');

    lastWS!._close(4002);

    expect(companion.getState()).toBe('unpaired');
    expect(companion.getResolvedName()).toBeNull();
  });

  it('resolvedName clears on the ticketless reconnect path (no sdkKey) after a companion.name push', () => {
    // Fix round 1: the companion.name pre-switch handler applies pushes
    // unconditionally, independent of sdkKey/announce — so a no-sdkKey
    // client can still pick up a resolvedName. A non-terminal reconnect on
    // that client re-enters connect()'s no-sdkKey branch, which must clear
    // resolvedName the same way it already clears code, or a stale name
    // survives the reconnect while code does not.
    const companion = createCompanion();
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
      // No sdkKey — this client never announces.
    });
    client.start();
    lastWS!._open();

    lastWS!._message(JSON.stringify({ type: 'companion.name', name: 'X' }));
    expect(companion.getResolvedName()).toBe('X');

    // Non-terminal drop schedules a 1s-backoff reconnect, which re-enters
    // connect()'s no-sdkKey branch (no deviceToken, no sdkKey).
    lastWS!._close(1006);
    vi.advanceTimersByTime(1_000);

    expect(companion.getResolvedName()).toBeNull();
  });

  it('stop() closes the socket and prevents reconnect', () => {
    const companion = createCompanion();
    const client = createRelayWSClient({
      endpoint: 'https://relay.example.com',
      companion,
      onReportRequest: vi.fn(),
      onReportSubmit: vi.fn(),
      webSocketCtor: makeFakeWSCtor(),
      storage: makeStorage(),
    });
    client.start();
    lastWS!._open();
    const firstWS = lastWS!;

    client.stop();
    expect(firstWS.close).toHaveBeenCalledWith(1000, 'client_close');

    // Drive a transient close — should NOT reconnect because stop set the flag.
    firstWS._close(1006);
    vi.advanceTimersByTime(60_000);
    expect(lastWS).toBe(firstWS);
  });
});
