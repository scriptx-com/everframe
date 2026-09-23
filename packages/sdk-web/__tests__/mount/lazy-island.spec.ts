// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// The invariant the whole bundle argument rests on: `init()` reaches no React
// module. React is behind a single dynamic `import()` in init.ts, which is
// also the chunk split point that keeps react/react-dom out of dist/index.js.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const islandLoaded = vi.fn();
const mountCalls: Array<{
  shadow: ShadowRoot;
  handlers: { onComplete(payload: unknown): void; onCancel(): void; onNewReport(): void };
  setOpen: ReturnType<typeof vi.fn>;
  setInboxOpen: ReturnType<typeof vi.fn>;
  toast: ReturnType<typeof vi.fn>;
  unmount: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('../../src/mount/react-island.js', async () => {
  islandLoaded();
  return {
    mountIsland: (
      shadow: ShadowRoot,
      _adapter: unknown,
      handlers: { onComplete(payload: unknown): void; onCancel(): void; onNewReport(): void },
    ) => {
      const island = {
        shadow,
        handlers,
        setOpen: vi.fn(),
        setInboxOpen: vi.fn(),
        toast: vi.fn(),
        unmount: vi.fn(),
      };
      mountCalls.push(island);
      return {
        setOpen: island.setOpen,
        setInboxOpen: island.setInboxOpen,
        toast: island.toast,
        unmount: island.unmount,
      };
    },
  };
});

import { init, type Everframe } from '../../src/init.js';

let handle: Everframe | null = null;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ),
  );
});

afterEach(() => {
  handle?.destroy();
  handle = null;
  islandLoaded.mockClear();
  mountCalls.length = 0;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('lazy React island', () => {
  it('does NOT load the island during init()', () => {
    handle = init({ apiKey: 'pk_test', appVersion: '1.0.0' });
    expect(islandLoaded).not.toHaveBeenCalled();
  });

  it('loads the island on the first open, and only once', async () => {
    handle = init({ apiKey: 'pk_test', appVersion: '1.0.0' });
    void handle.open();
    void handle.open();
    await vi.waitFor(() => expect(islandLoaded).toHaveBeenCalled());
    expect(islandLoaded).toHaveBeenCalledTimes(1);
  });

  it('single-flights the mount — two rapid opens create ONE root', async () => {
    handle = init({ apiKey: 'pk_test', appVersion: '1.0.0' });
    void handle.open();
    void handle.open();
    await vi.waitFor(() => expect(mountCalls).toHaveLength(1));
    // …and a third open, well after the first has settled, still reuses it.
    void handle.open();
    await vi.waitFor(() => expect(mountCalls[0]?.setOpen).toHaveBeenCalled());
    expect(mountCalls).toHaveLength(1);
  });

  it('opens the mounted island rather than only mounting it', async () => {
    handle = init({ apiKey: 'pk_test', appVersion: '1.0.0' });
    void handle.open();
    await vi.waitFor(() => expect(mountCalls[0]?.setOpen).toHaveBeenCalledWith(true));
  });

  it('mounts into the SAME shadow root init() created', async () => {
    handle = init({ apiKey: 'pk_test', appVersion: '1.0.0' });
    void handle.open();
    await vi.waitFor(() => expect(mountCalls).toHaveLength(1));
    expect(mountCalls[0]?.shadow).toBe(document.getElementById('everframe-host')?.shadowRoot);
  });

  it('destroy() unmounts the island', async () => {
    handle = init({ apiKey: 'pk_test', appVersion: '1.0.0' });
    void handle.open();
    await vi.waitFor(() => expect(mountCalls).toHaveLength(1));
    handle.destroy();
    handle = null;
    expect(mountCalls[0]?.unmount).toHaveBeenCalled();
  });

  it('cancelling from the island settles the pending open() as cancelled', async () => {
    handle = init({ apiKey: 'pk_test', appVersion: '1.0.0' });
    const pending = handle.open();
    await vi.waitFor(() => expect(mountCalls).toHaveLength(1));
    mountCalls[0]?.handlers.onCancel();
    await expect(pending).resolves.toEqual({ status: 'cancelled' });
  });
});
