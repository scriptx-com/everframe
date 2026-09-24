// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// The ordering and teardown invariants that define `init()`. The React package
// covers the same ground for its Provider in provider-poll-arm.spec.tsx,
// provider-poll-arm-hidden.spec.tsx and provider-kill-threads.spec.tsx; these
// are the vanilla equivalents, so a future edit that moves `startPolling()`
// out of the `settled.then(...)` — or drops the visibility gate, or stops
// tearing the poller down — fails here instead of shipping.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { POLL_FLOOR_MS } from '@everframe/sdk-core';

// Task 7 gave `init()` a real reporter UI, reached through a dynamic import
// of the React island. This file is about lifecycle ordering and teardown, so
// the island is stubbed: rendering the actual dialog here would drag React
// (and a real screenshot capture) into every one of these specs for no signal.
// The lazy boundary itself is asserted in __tests__/mount/lazy-island.spec.ts.
const islandHandlers: Array<{ onCancel(): void }> = [];
vi.mock('../src/mount/react-island.js', () => ({
  mountIsland: (_shadow: ShadowRoot, _adapter: unknown, handlers: { onCancel(): void }) => {
    islandHandlers.push(handlers);
    return {
      setOpen: () => undefined,
      setInboxOpen: () => undefined,
      toast: () => undefined,
      unmount: () => undefined,
    };
  },
}));
import { init, type Everframe, type InternalHandle } from '../src/init.js';
import { EverframeNotMountedError } from '../src/reporter-types.js';
import { REPORTER_TOKEN_STORAGE_KEY } from '../src/reporter/credential-store.js';

const TEST_TOKEN = 'evr_test0000000000000000000000000000000000';
const config = { apiKey: 'txx_live_test' };

let handles: Everframe[] = [];
function mount(): Everframe {
  const h = init(config);
  handles.push(h);
  return h;
}

beforeEach(() => {
  localStorage.clear();
  // A device token must already be present or pollOnce() idles on the
  // (unrelated) missing-token path before it ever reaches isEnabled().
  localStorage.setItem(REPORTER_TOKEN_STORAGE_KEY, TEST_TOKEN);
});

afterEach(() => {
  handles.forEach((h) => h.destroy());
  handles = [];
  islandHandlers.length = 0;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function configResponse(replies: boolean, reportHotkeyBinding?: string): Response {
  return new Response(
    JSON.stringify({
      replayEnabled: false,
      replayDurationSec: 30,
      samplingRate: 1,
      ...(replies ? { replies: { enabled: true } } : {}),
      ...(reportHotkeyBinding
        ? { reportHotkey: { binding: reportHotkeyBinding } }
        : {}),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function threadsResponse(): Response {
  return new Response(
    JSON.stringify({
      threads: [
        {
          id: 'thread-1',
          status: 'open',
          reportTitle: 'Broken checkout',
          createdAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          unreadCount: 1,
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * Stub `fetch`: `/api/config` resolves when the caller says so (or immediately),
 * `/api/reporter/threads` always returns one open thread. Returns the URL log.
 */
function stubFetch(
  cfg?: Deferred<Response>,
  replies = true,
  reportHotkeyBinding?: string,
): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/api/config'))
        return cfg ? cfg.promise : configResponse(replies, reportHotkeyBinding);
      if (url.includes('/api/reporter/threads')) return threadsResponse();
      return new Response('{}', { status: 200 });
    }),
  );
  return { calls };
}

const pollCount = (calls: string[]): number =>
  calls.filter((u) => u.includes('/api/reporter/threads')).length;
const polled = (calls: string[]): boolean => pollCount(calls) > 0;

/** Let microtasks and the real 0 ms poll timer run. */
const flush = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Resolve to the settled value, or 'PENDING' after `ms`. Turns a promise that
 *  never settles into a readable assertion failure instead of a spec timeout. */
async function settledWithin<T>(p: Promise<T>, ms = 60): Promise<T | 'PENDING'> {
  return Promise.race([p, new Promise<'PENDING'>((r) => setTimeout(() => r('PENDING'), ms))]);
}

describe('init(): thread polling arms only after the config gate settles', () => {
  it('does not poll while /api/config is pending, and polls once it resolves', async () => {
    const cfg = deferred<Response>();
    const { calls } = stubFetch(cfg);

    mount();
    // A 0 ms tick armed at init would land right here, read the fail-closed
    // OFF gate, return nextDelayMs=null and idle the poller to zero
    // PERMANENTLY — nothing re-arms it without a tab hide/show.
    await flush(20);
    expect(polled(calls)).toBe(false);

    cfg.resolve(configResponse(true));
    await vi.waitFor(() => expect(polled(calls)).toBe(true));
  });

  // DISCRIMINATION NOTE. `expect(polled(calls)).toBe(false)` ALONE cannot fail
  // here: with replies off, pollOnce() returns at thread-client.ts's
  // `if (!enabledNow || readOnly) return { nextDelayMs: null }` guard, strictly
  // BEFORE the listThreads() call — so zero /api/reporter/threads requests fire
  // whether or not startPolling() was ever armed. The spy is what separates the
  // two: "armed, then idled by the gate" (the real behaviour) from "never
  // armed". Both halves are load-bearing — drop the arm and the spy goes red;
  // drop the enabled gate and the request assertion goes red.
  it('an app with replies off still arms the poller, which then idles to zero', async () => {
    const { calls } = stubFetch(undefined, false);
    const h = mount() as InternalHandle;
    // Installed synchronously, in the same tick init() returned: the arm lives
    // in a `settled.then(...)` continuation, so no microtask has run yet.
    const threads = h.__adapter.threads;
    expect(threads).toBeDefined();
    const startPolling = vi.spyOn(threads!, 'startPolling');

    await flush(40);

    expect(startPolling).toHaveBeenCalled();
    expect(polled(calls)).toBe(false);
  });
});

describe('init(): a page initialised while hidden does not poll in the background', () => {
  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
  });

  it('mounted hidden: no poll after config settles; a later visible transition starts one', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const { calls } = stubFetch();

    mount();
    await flush(40);
    // Config has resolved with replies enabled, but the tab was hidden the
    // whole time and no visibilitychange transition ever fired — there is
    // nothing that would have stopped an unconditionally-armed poller.
    expect(polled(calls)).toBe(false);

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(polled(calls)).toBe(true));
  });

  it('mounted visible (jsdom default): polls after config settles', async () => {
    const { calls } = stubFetch();
    mount();
    await vi.waitFor(() => expect(polled(calls)).toBe(true));
  });
});

describe('destroy()', () => {
  it('stops the poller — nothing polls again even past the poll floor', async () => {
    // FAKE timers, and advanced past POLL_FLOOR_MS (60_000): a live poller
    // re-arms its next tick at that floor, so a real-timer window of tens of
    // milliseconds would show zero further polls whether or not teardown
    // actually stopped anything. Round-1's version of this test had exactly
    // that hole — it could not fail under its own regression.
    //
    // What this locks is the invariant a host cares about: after destroy(),
    // no poll EVER fires again. Two mechanisms deliver it and either alone is
    // sufficient — `threads.stopPolling()` here, and `client.kill()`, which
    // reaches `threads.shutdown()` inside sdk-core (client.ts:233) and
    // permanently disarms the client. Removing just one of them therefore
    // keeps this green; removing the teardown is what turns it red. Both are
    // kept deliberately: stopPolling() halts the loop synchronously, before
    // the seams are cleared, mirroring provider.tsx's own cleanup order.
    vi.useFakeTimers();
    try {
      const { calls } = stubFetch();
      const handle = mount();
      await vi.advanceTimersByTimeAsync(50);
      expect(polled(calls)).toBe(true);

      const before = pollCount(calls);
      handle.destroy();
      await vi.advanceTimersByTimeAsync(POLL_FLOOR_MS * 2 + 1_000);
      expect(pollCount(calls)).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex round-4 finding 3 (P2) — the poll arm's `disposed` guard used to run
  // SECOND, after `document.visibilityState` had already been read, while the
  // comment above it claimed it guarded "a destroy() that lands while config
  // was still in flight". Nothing visibly broke (destroy() leaves the document
  // alone), which is exactly why an ordering claim needs a test rather than a
  // comment: the whole point of the flag is that a torn-down instance touches
  // nothing outside itself, and a guard that runs second is not that guard.
  it('reads nothing off the document once destroyed mid-config-fetch', async () => {
    const cfg = deferred<Response>();
    stubFetch(cfg);
    const h = mount() as InternalHandle;
    const threads = h.__adapter.threads;
    expect(threads).toBeDefined();
    const startPolling = vi.spyOn(threads!, 'startPolling');

    h.destroy();

    // Installed AFTER teardown so it counts only what the settle continuation
    // does — the arm is the sole reader left on this path.
    let reads = 0;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get(): string {
        reads += 1;
        return 'visible';
      },
    });
    try {
      cfg.resolve(configResponse(true));
      await flush(40);

      expect(startPolling).not.toHaveBeenCalled();
      expect(reads).toBe(0);
    } finally {
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
      });
    }
  });

  it('kills the sdk-core client, so the thread facade goes inert', async () => {
    stubFetch();
    const handle = mount();
    await flush(30);
    handle.destroy();
    // `kill()` shuts the client down and empties its thread list; an inert
    // facade is how a killed client is observable from outside.
    expect(handle.threads.list()).toEqual([]);
    expect(handle.threads.unreadCount()).toBe(0);
  });

  // Codex round-1 finding 7. This test exists to prove a REAL leak found
  // earlier on this branch — repeated init/destroy cycles accumulating
  // 'online' listeners, each firing a concurrent `drainOutbox` over one
  // origin-wide outbox, i.e. a duplicate-submit path. Its first version
  // compared only event-NAME counts, so `removeEventListener('online',
  // someOtherFunction)` kept it green while every real listener piled up.
  // It now matches CALLBACK IDENTITY: a registration counts as cleaned up
  // only if the exact function object was handed back to removeEventListener.
  it('does not accumulate window listeners across init/destroy cycles', () => {
    stubFetch();
    type Reg = [type: string, fn: unknown];
    const added: Reg[] = [];
    const removed: Reg[] = [];
    vi.spyOn(window, 'addEventListener').mockImplementation(
      ((type: string, fn: unknown) => {
        added.push([type, fn]);
      }) as unknown as typeof window.addEventListener,
    );
    vi.spyOn(window, 'removeEventListener').mockImplementation(
      ((type: string, fn: unknown) => {
        removed.push([type, fn]);
      }) as unknown as typeof window.removeEventListener,
    );

    const CYCLES = 3;
    for (let i = 0; i < CYCLES; i++) init(config).destroy();

    const online = (log: Reg[]): Reg[] => log.filter(([type]) => type === 'online');
    // One per init(), and the count is pinned rather than merely > 0: an
    // adapter that stopped installing the drain listener at all would
    // otherwise satisfy "everything added was removed" vacuously.
    expect(online(added)).toHaveLength(CYCLES);
    // The page-global capture patchers are install-once (Symbol markers) and
    // are meant to survive; the adapter's OWN 'online' drain listener is not.
    // Every registration must be matched by a removal carrying THE SAME
    // function object — same-name/different-callback is exactly the leak.
    const stillLive = online(added).filter(
      ([type, fn]) => !removed.some(([rType, rFn]) => rType === type && rFn === fn),
    );
    expect(stillLive).toEqual([]);
    // And each listener is taken off exactly once — a destroy() that removed
    // the same callback N times would mask N-1 leaked registrations under the
    // identity check above.
    expect(online(removed)).toHaveLength(CYCLES);
    expect(new Set(online(removed).map(([, fn]) => fn)).size).toBe(CYCLES);
  });

  it('a stale handle destroyed after a re-init leaves the live instance alone', () => {
    stubFetch();
    const stale = mount();
    stale.destroy();
    const live = mount();

    stale.destroy(); // second call on a handle that is no longer current
    expect(document.getElementById('everframe-host')).not.toBeNull();
    // Still the live instance's own host, and still exactly one.
    expect(document.querySelectorAll('#everframe-host')).toHaveLength(1);
    live.destroy();
    expect(document.getElementById('everframe-host')).toBeNull();
  });
});

describe('handle.open() before a UI mount / after destroy', () => {
  it('no longer rejects up front — Task 7 mounts a reporter UI during init()', async () => {
    // Before Task 7 there was no UI to show, so `open()` refused rather than
    // handing back a promise nothing could ever settle. Now the ambient UI is
    // mounted at init() and the dialog is one dynamic import away, so the
    // promise is genuinely pending until the user answers it — asserted here
    // by settling it through the island's own cancel path.
    stubFetch();
    const handle = mount();
    const pending = handle.open();
    await vi.waitFor(() => expect(islandHandlers).toHaveLength(1));
    islandHandlers[0]!.onCancel();
    await expect(pending).resolves.toEqual({ status: 'cancelled' });
  });

  it('rejects after destroy()', async () => {
    stubFetch();
    const handle = mount();
    handle.destroy();
    await expect(handle.open()).rejects.toBeInstanceOf(EverframeNotMountedError);
  });

  // Codex round-1 finding 5 (P2). The case above is the LATER open(); this is
  // the one already in flight when teardown lands. Nothing could settle it
  // once the island was unmounted, so the host's `await open()` hung for the
  // life of the page. Resolved rather than rejected on purpose — see the
  // comment at the settle site in init.ts's destroy().
  it('settles an open() that was already in flight when destroy() landed', async () => {
    stubFetch();
    const handle = mount();
    const pending = handle.open();
    await vi.waitFor(() => expect(islandHandlers).toHaveLength(1));

    handle.destroy();

    expect(await settledWithin(pending)).toEqual({ status: 'cancelled', reason: 'destroyed' });
  });
});

// Codex round-1 finding 1 (P1, kill switch), vanilla half. The adapter-level
// gate is covered by kill-switch-gates.spec.ts; what is proven here is that
// the HOTKEY — which calls init.ts's `openModal` directly, never touching
// `__openReporter` — is gated too. Each case is paired with a live control on
// an un-killed instance so a broken harness fails as loudly as a missing gate.
describe('kill(): a killed instance opens nothing', () => {
  const hotkeyConfig = { apiKey: 'txx_live_test' };
  function mountWithHotkey(): Everframe {
    const h = init(hotkeyConfig);
    handles.push(h);
    return h;
  }
  const pressHotkey = (): void => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'B', ctrlKey: true, shiftKey: true, bubbles: true }),
    );
  };

  it('LIVE control: the hotkey mounts the reporter island', async () => {
    stubFetch();
    mountWithHotkey();
    pressHotkey();
    await vi.waitFor(() => expect(islandHandlers).toHaveLength(1));
  });

  it('the hotkey captures nothing after kill()', async () => {
    stubFetch();
    const handle = mountWithHotkey();

    handle.kill();
    pressHotkey();

    await flush(30);
    // Pre-fix this mounted the dialog and took a screenshot of the user's page
    // after the consent switch had been pulled.
    expect(islandHandlers).toHaveLength(0);
  });

  it('open() resolves cancelled/killed after kill() instead of hanging', async () => {
    stubFetch();
    const handle = mountWithHotkey();

    handle.kill();

    expect(await settledWithin(handle.open())).toEqual({ status: 'cancelled', reason: 'killed' });
    expect(islandHandlers).toHaveLength(0);
  });
});

describe('dashboard-owned report hotkey', () => {
  it('opens only from the remotely configured binding once config resolves', async () => {
    stubFetch(undefined, false, 'Alt+R');
    const handle = init({
      apiKey: 'txx_live_test',
      // A legacy JavaScript caller may still pass the removed local option.
      // The dashboard binding must win at runtime as well as in the TS API.
      hotkey: { binding: 'Ctrl+Shift+B' },
    } as unknown as Parameters<typeof init>[0]);
    handles.push(handle);
    await flush(30);

    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'B',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    await flush(10);
    expect(islandHandlers).toHaveLength(0);

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'R', altKey: true, bubbles: true }),
    );
    await vi.waitFor(() => expect(islandHandlers).toHaveLength(1));
  });
});
