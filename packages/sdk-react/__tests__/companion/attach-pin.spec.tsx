// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 6 (spec 2026-08-19) — attach-PIN challenge state, wired end-to-end:
// relay frame (`ws-client.ts`) → `CompanionAPI` (`state.ts`) → the built-in
// `CompanionPinCard` render surface, gated by `AttachPinUiMode`.
//
// The ws-client-level cases below crib the fake-WebSocket harness straight
// from `ws-client.spec.ts` (same shape, duplicated per that file's own
// convention of not exporting a shared harness). The render-level cases crib
// `render`/`screen` the way `provider.spec.tsx` does.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createCompanion, createRelayWSClient } from '@traceitx/web';
import { CompanionPinCard } from '@traceitx/web/ui';
import {
  start,
  stop,
  __getCompanionApi,
  __getAttachPinUiMode,
} from '@traceitx/web';

interface FakeWS {
  url: string;
  readyState: number;
  binaryType: string;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  addEventListener: (name: string, handler: (ev: unknown) => void) => void;
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

/**
 * Minimal WebSocket stub for singleton-level tests (`CompanionStartOptions`
 * has no `webSocketCtor` test seam — only `RelayWSClientOpts` does — so we
 * stub the global the singleton's `createRelayWSClient(...)` call reads).
 * Never fires any event; a real connection is never attempted.
 */
function makeNoopWSCtor(): typeof WebSocket {
  return class NoopWS {
    readyState = 0;
    binaryType = 'blob';
    addEventListener(): void {}
    send(): void {}
    close(): void {}
  } as unknown as typeof WebSocket;
}

describe('companion/ws-client — attach-PIN frames', () => {
  it('attach.challenge sets state and attach.challenge.cleared clears it', () => {
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

    expect(companion.getAttachChallenge()).toBeNull();

    lastWS!._message(
      JSON.stringify({
        type: 'attach.challenge',
        code: '0427',
        ttl_ms: 60_000,
        requested_by_name: 'Aurimas',
      }),
    );

    expect(companion.getAttachChallenge()).toEqual({
      code: '0427',
      requestedByName: 'Aurimas',
      ttlMs: 60_000,
    });

    lastWS!._message(
      JSON.stringify({ type: 'attach.challenge.cleared', reason: 'attached' }),
    );

    expect(companion.getAttachChallenge()).toBeNull();
  });

  it('fires onAttachChallenge subscribers on the challenge and the clear', () => {
    const companion = createCompanion();
    const handler = vi.fn();
    companion.onAttachChallenge(handler);
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
        type: 'attach.challenge',
        code: '9911',
        ttl_ms: 30_000,
        requested_by_name: 'Bob',
      }),
    );
    expect(handler).toHaveBeenNthCalledWith(1, {
      code: '9911',
      requestedByName: 'Bob',
      ttlMs: 30_000,
    });

    lastWS!._message(
      JSON.stringify({ type: 'attach.challenge.cleared', reason: 'expired' }),
    );
    expect(handler).toHaveBeenNthCalledWith(2, null);
  });

  it('a terminal close clears a live challenge', () => {
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
        type: 'attach.challenge',
        code: '0427',
        ttl_ms: 60_000,
        requested_by_name: 'Aurimas',
      }),
    );
    expect(companion.getAttachChallenge()).not.toBeNull();

    lastWS!._close(4002);

    expect(companion.getAttachChallenge()).toBeNull();
  });

  it('a single NON-terminal close also clears a live challenge immediately', () => {
    // The server deletes the pair on ANY TV-socket close, terminal or not —
    // so a retained challenge past a single non-terminal drop is already
    // stale; it must not wait for the reconnect budget to exhaust.
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
        type: 'attach.challenge',
        code: '0427',
        ttl_ms: 60_000,
        requested_by_name: 'Aurimas',
      }),
    );
    expect(companion.getAttachChallenge()).not.toBeNull();

    lastWS!._close(1006); // non-terminal — would normally schedule a reconnect

    expect(companion.getAttachChallenge()).toBeNull();
  });

  it('stop() clears a live challenge', () => {
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
        type: 'attach.challenge',
        code: '0427',
        ttl_ms: 60_000,
        requested_by_name: 'Aurimas',
      }),
    );
    expect(companion.getAttachChallenge()).not.toBeNull();

    client.stop();

    expect(companion.getAttachChallenge()).toBeNull();
  });

  it('reconnect-budget exhaustion also clears a live challenge', () => {
    vi.useFakeTimers();
    try {
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
          type: 'attach.challenge',
          code: '0427',
          ttl_ms: 60_000,
          requested_by_name: 'Aurimas',
        }),
      );
      expect(companion.getAttachChallenge()).not.toBeNull();

      // Drive repeated non-terminal closes (each re-arms `scheduleReconnect`,
      // which is the only place that re-checks elapsed time against the
      // 5-min wall budget) until it blows.
      for (let i = 0; i < 40 && companion.getAttachChallenge() !== null; i++) {
        lastWS!._close(1006);
        vi.advanceTimersByTime(10_000); // >= the 10s backoff ceiling
      }

      expect(companion.getAttachChallenge()).toBeNull();
      expect(companion.getState()).toBe('unpaired');
    } finally {
      vi.useRealTimers();
    }
  });
});

// The card reads the module-scope companion singleton, so these tests share
// its state within this file. Reset it after every test.
describe('CompanionPinCard', () => {
  afterEach(() => {
    cleanup();
    __getCompanionApi().__setAttachChallenge(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('renders nothing when there is no live challenge', () => {
    const { container } = render(<CompanionPinCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the code + requester while a challenge is live (builtin mode)', () => {
    __getCompanionApi().__setAttachChallenge({
      code: '0427',
      requestedByName: 'Aurimas',
      ttlMs: 60_000,
    });

    render(<CompanionPinCard />);

    expect(screen.getByText('0427')).toBeInTheDocument();
    expect(screen.getByText(/Aurimas/)).toBeInTheDocument();
  });

  it('is excluded from capture and replay via both mechanisms', () => {
    __getCompanionApi().__setAttachChallenge({
      code: '0427',
      requestedByName: 'Aurimas',
      ttlMs: 60_000,
    });

    const { getByRole } = render(<CompanionPinCard />);
    const root = getByRole('status');

    // Screenshot + ui-tree exclusion (screenshot.ts filterNode, ui-tree-dom.ts).
    expect(root.getAttribute('data-traceitx-skip-capture')).toBe('true');
    // Replay blockSelector (sensitive/registry.ts SENSITIVE_ATTR).
    expect(root.getAttribute('data-traceitx-sensitive')).toBe('');
    // rrweb blockClass (recorder.ts RR_BLOCK_CLASS) — checked dynamically per
    // node, unlike the one-shot `sensitiveElements()` mapping applied only at
    // recorder.start(). Required because this card can mount after recording
    // has already started.
    expect(root.classList.contains('rr-block')).toBe(true);
  });

  it('unmounts its content when the challenge clears', () => {
    const api = __getCompanionApi();
    api.__setAttachChallenge({
      code: '0427',
      requestedByName: 'Aurimas',
      ttlMs: 60_000,
    });
    render(<CompanionPinCard />);
    expect(screen.getByText('0427')).toBeInTheDocument();

    act(() => {
      api.__setAttachChallenge(null);
    });

    expect(screen.queryByText('0427')).not.toBeInTheDocument();
  });

  it('auto-dismisses locally once ttlMs elapses, ahead of any server frame', () => {
    vi.useFakeTimers();
    const api = __getCompanionApi();
    api.__setAttachChallenge({
      code: '9999',
      requestedByName: 'Bob',
      ttlMs: 5_000,
    });
    render(<CompanionPinCard />);
    expect(screen.getByText('9999')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(screen.getByText('9999')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText('9999')).not.toBeInTheDocument();

    // The state surface itself is untouched by local expiry — only the
    // card's own render state hides it. A later server frame (or none at
    // all) is a no-op either way.
    expect(api.getAttachChallenge()).not.toBeNull();
  });

  it('renders nothing in custom/off modes even with a live challenge', () => {
    vi.stubGlobal('WebSocket', makeNoopWSCtor());

    try {
      start({ attachPinUi: 'custom' });
      expect(__getAttachPinUiMode()).toBe('custom');
      __getCompanionApi().__setAttachChallenge({
        code: '0427',
        requestedByName: 'Aurimas',
        ttlMs: 60_000,
      });
      const custom = render(<CompanionPinCard />);
      expect(custom.container).toBeEmptyDOMElement();
      custom.unmount();

      // Mode changes require stop() + start() (Task review finding 5) — a
      // no-op start() on a live socket must not mutate the announced mode.
      stop();
      start({ attachPinUi: 'off' });
      expect(__getAttachPinUiMode()).toBe('off');
      const off = render(<CompanionPinCard />);
      expect(off.container).toBeEmptyDOMElement();
      off.unmount();

      // Restore builtin so this module-scope mode doesn't leak into other
      // test files sharing the same singleton within this worker.
      stop();
      start({ attachPinUi: 'builtin' });
      expect(__getAttachPinUiMode()).toBe('builtin');
    } finally {
      stop();
    }
  });
});

// Task 6 review, Important finding 2 — the singleton→ws-client hop:
// `start()`'s `supportsAttachPin: _attachPinUiMode !== 'off'` line has to
// actually reach `createRelayWSClient(...)`'s opts and, from there, the
// announce request body. Stub `fetch` (the default `announceImpl` reads
// `globalThis.fetch`) and `WebSocket` (no `webSocketCtor` seam on
// `CompanionStartOptions`) to drive `start()` through the real
// connect→announce path without any network I/O.
describe('companion singleton — supportsAttachPin plumbing (start → announce body)', () => {
  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
    __getCompanionApi().__setAttachChallenge(null);
  });

  it('threads supportsAttachPin: true for builtin/custom, and omits it for off', async () => {
    vi.stubGlobal('WebSocket', makeNoopWSCtor());
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse((init?.body as string | undefined) ?? '{}'));
        return new Response(
          JSON.stringify({ ticket: `tkt-${bodies.length}`, code: `C0D${bodies.length}` }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    // Default — `attachPinUi` omitted, same as explicit 'builtin'.
    start({ sdkKey: 'txx_live_x', endpoint: 'https://relay.example.com' });
    await vi.waitFor(() => expect(bodies.length).toBe(1));
    expect(bodies[0]).toMatchObject({ supportsAttachPin: true });
    stop();

    // 'custom' still promises a rendered PIN (host-owned) — still announces.
    start({
      sdkKey: 'txx_live_x',
      endpoint: 'https://relay.example.com',
      attachPinUi: 'custom',
    });
    await vi.waitFor(() => expect(bodies.length).toBe(2));
    expect(bodies[1]).toMatchObject({ supportsAttachPin: true });
    stop();

    // 'off' — device does not announce PIN support at all; legacy one-click
    // attach is what the dashboard falls back to.
    start({
      sdkKey: 'txx_live_x',
      endpoint: 'https://relay.example.com',
      attachPinUi: 'off',
    });
    await vi.waitFor(() => expect(bodies.length).toBe(3));
    expect(bodies[2]).not.toHaveProperty('supportsAttachPin');
  });

  it('a repeat start() on a live socket does not mutate the announced mode', () => {
    vi.stubGlobal('WebSocket', makeNoopWSCtor());

    start({ attachPinUi: 'builtin' });
    expect(__getAttachPinUiMode()).toBe('builtin');

    // _ws is already non-null — this is a no-op start; it must NOT flip the
    // local mode to 'off', which would silently diverge from the
    // `supportsAttachPin: true` already announced for this session.
    start({ attachPinUi: 'off' });
    expect(__getAttachPinUiMode()).toBe('builtin');
  });
});
