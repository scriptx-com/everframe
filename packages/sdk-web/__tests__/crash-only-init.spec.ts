// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Crash-only sessions (spec 2026-10-12), vanilla host. `init()` with
// `reporter: { disabled: true }` binds no hotkey, rejects `open()`, shows no
// replies FAB (so no inbox) even when the device has threads, and keeps
// replay at the crash-only rate (Companion, which used to upgrade it, has
// been removed). Each refusal is paired with a live control on a
// report session so a broken harness fails as loudly as a missing gate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface IslandOpts {
  onCancel(): void;
  onNewReport?: () => void;
}
const islands: Array<{ opts: IslandOpts }> = [];
vi.mock('../src/mount/react-island.js', () => ({
  mountIsland: (_shadow: ShadowRoot, _adapter: unknown, opts: IslandOpts) => {
    islands.push({ opts });
    return {
      setOpen: () => undefined,
      setInboxOpen: () => undefined,
      toast: () => undefined,
      unmount: () => undefined,
    };
  },
}));

import { init, type Everframe, type InternalHandle } from '../src/init.js';
import { EverframeReporterDisabledError } from '../src/reporter-types.js';
import { scopedReporterTokenStorageKey } from '../src/reporter/credential-store.js';
import { start as startCompanion } from '../src/companion/singleton.js';

let handles: Everframe[] = [];

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  handles.forEach((h) => h.destroy());
  handles = [];
  islands.length = 0;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function stubFetch(config: Record<string, unknown>, threads: unknown[] = []): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        return new Response(JSON.stringify(config), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/reporter/threads')) {
        return new Response(JSON.stringify({ threads }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

const replayOn = { replayEnabled: true, replayDurationSec: 30, samplingRate: 1 };
const replayOff = { replayEnabled: false, replayDurationSec: 30, samplingRate: 1 };

function mount(reporterDisabled: boolean): Everframe {
  const h = init({
    sdkKey: 'txx_live_test',
    ...(reporterDisabled ? { reporter: { disabled: true } } : {}),
  });
  handles.push(h);
  return h;
}

const pressHotkey = (): void => {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'B', ctrlKey: true, shiftKey: true, bubbles: true }),
  );
};

describe('crash-only init(): entry points', () => {
  it('LIVE control: the hotkey opens the reporter in a report session', async () => {
    stubFetch(replayOff);
    mount(false);
    await flush();
    pressHotkey();
    await vi.waitFor(() => expect(islands).toHaveLength(1));
  });

  it('binds no hotkey', async () => {
    stubFetch(replayOff);
    mount(true);
    await flush();
    pressHotkey();
    await flush();
    expect(islands).toHaveLength(0);
  });

  it('open() rejects with EverframeReporterDisabledError and mounts nothing', async () => {
    stubFetch(replayOff);
    const handle = mount(true);
    await expect(handle.open()).rejects.toBeInstanceOf(EverframeReporterDisabledError);
    await flush();
    expect(islands).toHaveLength(0);
  });

  describe('inbox', () => {
    const thread = {
      id: 'thread-1',
      status: 'open',
      reportTitle: 'Broken checkout',
      createdAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      unreadCount: 1,
    };

    const fabEl = (): Element | null | undefined =>
      document
        .getElementById('everframe-host')
        ?.shadowRoot?.querySelector('[data-testid=reporter-fab]');

    function mountWithThread(reporterDisabled: boolean): Everframe {
      localStorage.setItem(scopedReporterTokenStorageKey('txx_live_test'), `evr_${'0'.repeat(36)}`);
      stubFetch({ ...replayOff, replies: { enabled: true } }, [thread]);
      return mount(reporterDisabled);
    }

    async function openInbox(reporterDisabled: boolean): Promise<IslandOpts> {
      mountWithThread(reporterDisabled);
      const fab = await vi.waitFor(
        () => {
          const el = document
            .getElementById('everframe-host')
            ?.shadowRoot?.querySelector('[data-testid=reporter-fab]');
          expect(el).toBeTruthy();
          return el as HTMLButtonElement;
        },
        { timeout: 3000 },
      );
      fab.click();
      await vi.waitFor(() => expect(islands).toHaveLength(1));
      return islands[0]!.opts;
    }

    it('LIVE control: a report session offers "New report"', async () => {
      const opts = await openInbox(false);
      expect(typeof opts.onNewReport).toBe('function');
    });

    it('shows no FAB, so no inbox, even though the device has a thread', async () => {
      const handle = mountWithThread(true);
      // The poll really ran and the device really has a thread: the hidden
      // FAB is the crash-only gate, not an empty list.
      await vi.waitFor(() => expect(handle.threads?.list()).toHaveLength(1), { timeout: 3000 });
      await flush();
      expect(fabEl()).toBeFalsy();
      expect(islands).toHaveLength(0);
    });
  });
});

describe('crash-only init(): no companion upgrade', () => {
  it('records nothing at the default crash-only rate, and the deprecated companion.start() changes nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubFetch(replayOn);
    const handle = mount(true) as InternalHandle;
    await flush();
    const lifecycle = handle.__adapter.__replayLifecycle!;
    expect(lifecycle.state).toBe('IDLE');

    startCompanion();
    await flush();
    expect(lifecycle.state).toBe('IDLE');
    await expect(handle.open()).rejects.toBeInstanceOf(EverframeReporterDisabledError);
  });
});
