// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Codex round-1 finding 4 (P2) — a failed lazy-island download used to wedge
// reporting permanently. The island is a hashed chunk fetched over the
// network: it 404s behind a stale CDN deploy, is refused by a strict CSP, or
// simply misses on a flaky connection. Three consequences, all from one
// unhandled rejection cached in the single-flight slot:
//
//   1. `open()` never settled — the host's `await open()` hung for the life
//      of the page;
//   2. the replay / breadcrumb / network-body buffers stayed FROZEN, because
//      `openModal()` freezes synchronously BEFORE the import is awaited — so
//      the reporter had silently stopped recording, with no error anywhere;
//   3. every later `open()` re-awaited the SAME rejected promise instead of
//      retrying the download, so a single transient failure was terminal.
//
// The import is mocked with a per-test switch so the same spec can fail it,
// observe the unwind, then succeed and prove the retry actually re-imports.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

let importAttempts = 0;
let failNextImport = true;
const islandHandlers: Array<{ onCancel(): void }> = [];
const setInboxOpenCalls: boolean[] = [];

vi.mock('../src/mount/react-island.js', () => ({
  // The factory runs on the dynamic import itself, so throwing here is a
  // faithful stand-in for a chunk that never arrives.
  get mountIsland() {
    importAttempts++;
    if (failNextImport) throw new Error('chunk 404');
    return (_root: ShadowRoot | HTMLElement, _adapter: unknown, handlers: { onCancel(): void }) => {
      islandHandlers.push(handlers);
      return {
        setOpen: () => undefined,
        setInboxOpen: (v: boolean) => setInboxOpenCalls.push(v),
        toast: () => undefined,
        unmount: () => undefined,
      };
    };
  },
}));

import { init, type TraceItXHandle, type InternalHandle } from '../src/init.js';
import { __internalClientState } from '@traceitx/sdk-core';
import { REPORTER_TOKEN_STORAGE_KEY } from '../src/reporter/credential-store.js';

let handles: TraceItXHandle[] = [];
function mount(): InternalHandle {
  const h = init({ apiKey: 'txx_live_island_failure' });
  handles.push(h);
  return h as InternalHandle;
}

beforeEach(() => {
  importAttempts = 0;
  failNextImport = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ),
  );
});

afterEach(() => {
  handles.forEach((h) => h.destroy());
  handles = [];
  islandHandlers.length = 0;
  setInboxOpenCalls.length = 0;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Resolve to the settled value, or 'PENDING' after `ms` — an un-settled
 *  promise becomes a readable assertion failure rather than a spec timeout. */
async function settledWithin<T>(p: Promise<T>, ms = 60): Promise<T | 'PENDING'> {
  return Promise.race([p, new Promise<'PENDING'>((r) => setTimeout(() => r('PENDING'), ms))]);
}

/**
 * Is a freeze currently held? sdk-core's buffers expose no `isFrozen`, so this
 * reads the only observable: `takeFrozen()` returns the snapshot when one is
 * held and `null` when it is not. DESTRUCTIVE — it clears the freeze, so each
 * test below calls it exactly once, at the end.
 */
function freezeHeld(handle: InternalHandle): { breadcrumbs: boolean; bodies: boolean } {
  const state = __internalClientState.get(handle.__client)!;
  return {
    breadcrumbs: state.breadcrumbs.takeFrozen() !== null,
    bodies: state.networkBodies.takeFrozen() !== null,
  };
}

/**
 * Collect promise rejections that escape during `fn` (plus a settle window).
 *
 * NODE-level, deliberately. Under jsdom a V8 unhandled rejection does not
 * surface as a `window` `unhandledrejection` event, so the window-listener
 * version of this assertion could never fail — see finding 6. Vitest keeps its
 * own listener, so a genuine escape ALSO fails the file; both signals point at
 * the same missing handler.
 */
async function watchUnhandledRejections(fn: () => void | Promise<void>): Promise<unknown[]> {
  const escaped: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    escaped.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 40));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  return escaped;
}

/** The shadow root init() mounted into. */
function shadow(): ShadowRoot {
  const root = document.getElementById('traceitx-host')?.shadowRoot;
  if (!root) throw new Error('no shadow root');
  return root;
}

/**
 * Mount with ONE existing reply thread, which is the only state in which the
 * FAB renders (`count > 0` — it is an inbox entry point, not a report
 * trigger). The real ambient DOM is used, not a stub, so what is under test is
 * the click a user actually performs.
 */
async function fabWithThread(): Promise<HTMLButtonElement> {
  localStorage.setItem(REPORTER_TOKEN_STORAGE_KEY, `txr_${'0'.repeat(36)}`);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/api/reporter/threads')
        ? JSON.stringify({
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
          })
        : JSON.stringify({
            replayEnabled: false,
            replayDurationSec: 30,
            samplingRate: 1,
            replies: { enabled: true },
          });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  mount();
  return await vi.waitFor(
    () => {
      const fab = shadow().querySelector('[data-testid=reporter-fab]');
      expect(fab).not.toBeNull();
      return fab as HTMLButtonElement;
    },
    { timeout: 3000 },
  );
}

describe('finding 4 — a failed island download must not wedge the reporter', () => {
  it('settles open() instead of hanging it', async () => {
    const handle = mount();

    const result = await settledWithin(handle.open());

    expect(result).toEqual({ status: 'cancelled', reason: 'error' });
  });

  // The pair below is one assertion split across two handles, because reading
  // the freeze state consumes it. Together they say: the freeze IS taken at
  // open (so the second test cannot pass vacuously), and it is GONE once the
  // failed download has unwound — which is what "the reporter is still
  // recording" means. Pre-fix only the second went red.
  it('LIVE control: open() freezes replay, breadcrumbs and network bodies synchronously', () => {
    const handle = mount();

    void handle.open();

    expect(freezeHeld(handle)).toEqual({ breadcrumbs: true, bodies: true });
  });

  it('leaves capture RUNNING — the freeze taken at open() is unwound', async () => {
    const handle = mount();

    await settledWithin(handle.open());

    expect(freezeHeld(handle)).toEqual({ breadcrumbs: false, bodies: false });
  });

  it('retries the download on the next open() rather than replaying the rejection', async () => {
    const handle = mount();

    expect(await settledWithin(handle.open())).toEqual({ status: 'cancelled', reason: 'error' });
    expect(importAttempts).toBe(1);

    // The network recovers.
    failNextImport = false;
    const second = handle.open();
    await vi.waitFor(() => expect(islandHandlers).toHaveLength(1));
    // A SECOND import actually happened — the single-flight slot did not hand
    // back the cached rejection.
    expect(importAttempts).toBe(2);

    // And the retried open is a real, answerable open.
    islandHandlers[0]!.onCancel();
    expect(await settledWithin(second)).toEqual({ status: 'cancelled' });
  });

  it('a failed toast/reporter path raises no unhandled rejection', async () => {
    const handle = mount();

    const escaped = await watchUnhandledRejections(async () => {
      await settledWithin(handle.open());
    });

    expect(escaped).toEqual([]);
  });
});

// ── Codex round-2 finding 6 (P3) ────────────────────────────────────────────
//
// The block above exercises `handle.open()` only, i.e. init.ts's `showModal`
// rejection handler. The AMBIENT path — the FAB, which opens the replies inbox
// — has its own, SEPARATE `ensureIsland().then(ok, () => undefined)` in
// init.ts's `createAmbientUI({ onOpen })`, and nothing covered it: delete that
// second handler and the suite stayed green while a real host got an
// `unhandledrejection` in its page (and, with crash reporting on, a report
// about our own chunk).
//
// It is also the path a user is MORE likely to hit — the FAB only appears on a
// device that already has conversations, so it is the entry point for someone
// mid-thread with the team.
//
// Rejections are watched at the NODE level, not through
// `window.addEventListener('unhandledrejection', …)`: jsdom does not bridge V8
// promise rejections onto the window, so a window listener never fires here
// and an assertion built on one cannot fail. That was the second half of this
// finding.
describe('finding 6 — the ambient inbox path unwinds a failed download too', () => {
  it('LIVE control: the FAB opens the inbox once the island loads', async () => {
    failNextImport = false;
    const fab = await fabWithThread();

    fab.click();

    await vi.waitFor(() => expect(setInboxOpenCalls).toEqual([true]));
  });

  it('raises no unhandled rejection when the chunk never arrives', async () => {
    const fab = await fabWithThread();

    const escaped = await watchUnhandledRejections(async () => {
      fab.click();
    });

    expect(escaped).toEqual([]);
    // ...and the failure was real: the inbox genuinely did not open.
    expect(setInboxOpenCalls).toEqual([]);
  });

  it('retries the download on the next click rather than replaying the rejection', async () => {
    const fab = await fabWithThread();

    fab.click();
    await vi.waitFor(() => expect(importAttempts).toBe(1));

    failNextImport = false;
    fab.click();

    await vi.waitFor(() => expect(setInboxOpenCalls).toEqual([true]));
    expect(importAttempts).toBe(2);
  });
});
