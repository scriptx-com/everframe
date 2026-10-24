// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOverlayStore,
  installRootWrapper,
  TOAST_MS,
  TOAST_QUEUE_MAX,
  type AppRegistryLike,
  type HWEventLike,
  type OverlayStore,
} from '../src/overlay.js';
import { tvEventHandlers } from './stubs/react-native.js';

function store(): OverlayStore {
  return createOverlayStore({
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
}

interface FakeRegistry extends AppRegistryLike {
  providers: Array<(params: unknown) => unknown>;
}

function registry(): FakeRegistry {
  const r: FakeRegistry = {
    providers: [],
    setWrapperComponentProvider(provider) {
      r.providers.push(provider);
    },
  };
  return r;
}

type Wrapper = (props: { children?: ReactNode }) => ReactNode;

function render(provider: (params: unknown) => unknown, child = 'APP'): string {
  const Root = provider({ rootTag: 1 }) as Wrapper;
  return renderToStaticMarkup(createElement(Root, { initialProps: {} } as never, child));
}

beforeEach(() => {
  vi.useFakeTimers();
  tvEventHandlers.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('overlay store', () => {
  it('bannerOwnedByClaim', () => {
    const s = store();
    const owner = {};
    s.showBanner(owner, 47);
    expect(s.snapshot().banner).toEqual({
      title: 'Linking to Everframe · 47',
      subline: "A teammate is linking a device. If that's not you, ignore this.",
    });
    s.hideBanner({});
    expect(s.snapshot().banner).not.toBeNull();
    s.hideBanner(owner);
    expect(s.snapshot().banner).toBeNull();
  });

  it('toastsQueueAndExpire', () => {
    const s = store();
    s.toast('one');
    s.toast('two');
    s.toast('three');
    expect(s.snapshot().toast).toBe('one');
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(s.snapshot().toast).toBe('one');
    vi.advanceTimersByTime(1);
    expect(s.snapshot().toast).toBe('two');
    vi.advanceTimersByTime(TOAST_MS);
    expect(s.snapshot().toast).toBe('three');
    vi.advanceTimersByTime(TOAST_MS);
    expect(s.snapshot().toast).toBeNull();
    s.toast('four');
    expect(s.snapshot().toast).toBe('four');
  });

  it('toastOverflowDropsOldestPending', () => {
    const s = store();
    s.toast('showing');
    for (let i = 1; i <= TOAST_QUEUE_MAX + 2; i++) s.toast(`p${i}`);
    const seen: Array<string | null> = [s.snapshot().toast];
    for (let i = 0; i < TOAST_QUEUE_MAX + 1; i++) {
      vi.advanceTimersByTime(TOAST_MS);
      seen.push(s.snapshot().toast);
    }
    expect(seen).toEqual(['showing', 'p3', 'p4', 'p5', null]);
  });

  it('subscribersNotified', () => {
    const s = store();
    let calls = 0;
    const off = s.subscribe(() => calls++);
    s.toast('x');
    s.showBanner({}, 1);
    expect(calls).toBe(2);
    off();
    s.toast('y');
    vi.advanceTimersByTime(TOAST_MS);
    expect(calls).toBe(2);
  });

  it('aThrowingSubscriberDoesNotStopOthers', () => {
    const s = store();
    let calls = 0;
    s.subscribe(() => {
      throw new Error('x');
    });
    s.subscribe(() => calls++);
    s.toast('x');
    expect(calls).toBe(1);
  });
});

describe('root wrapper', () => {
  it('installsWrapperAndChainsLaterHostProvider', () => {
    const r = registry();
    const s = store();
    installRootWrapper(r, { store: s, onKey: () => undefined });
    expect(r.providers).toHaveLength(1);
    const ours = r.providers[0]!;
    function HostWrapper(props: { children?: ReactNode }) {
      return createElement('section', { id: 'host' }, props.children);
    }
    const hostProvider = vi.fn(() => HostWrapper);
    r.setWrapperComponentProvider(hostProvider);
    expect(r.providers).toHaveLength(1);
    const html = render(ours);
    expect(hostProvider).toHaveBeenCalledWith({ rootTag: 1 });
    expect(html).toContain('<section id="host">APP</section>');
  });

  it('rendersChildrenAloneWhenIdle', () => {
    const r = registry();
    installRootWrapper(r, { store: store(), onKey: () => undefined });
    expect(render(r.providers[0]!)).toBe('APP');
  });

  it('rendersBannerAndToastWithoutTakingFocus', () => {
    const r = registry();
    const s = store();
    s.showBanner({}, 47);
    s.toast('Captured · Aurimas');
    installRootWrapper(r, { store: s, onKey: () => undefined });
    const html = render(r.providers[0]!);
    expect(html.startsWith('APP')).toBe(true);
    expect(html).toContain('Linking to Everframe · 47');
    expect(html).toContain('A teammate is linking a device.');
    expect(html).toContain('Captured · Aurimas');
  });

  it('aThrowingHostProviderStillRendersTheApp', () => {
    const r = registry();
    installRootWrapper(r, { store: store(), onKey: () => undefined });
    r.setWrapperComponentProvider(() => {
      throw new Error('host');
    });
    expect(render(r.providers[0]!)).toBe('APP');
  });

  it('installNeverThrows', () => {
    const throwing: AppRegistryLike = {
      setWrapperComponentProvider() {
        throw new Error('registry');
      },
    };
    expect(() =>
      installRootWrapper(throwing, { store: store(), onKey: () => undefined }),
    ).not.toThrow();
    const frozen = Object.freeze({ setWrapperComponentProvider: () => undefined });
    expect(() =>
      installRootWrapper(frozen, { store: store(), onKey: () => undefined }),
    ).not.toThrow();
  });

  it('notMountedUntilEffectRuns', () => {
    const r = registry();
    const s = store();
    installRootWrapper(r, { store: s, onKey: () => undefined });
    expect(s.mounted()).toBe(false);
    // Server rendering runs no effects: rendering alone never marks it mounted.
    render(r.providers[0]!);
    expect(s.mounted()).toBe(false);
  });

  it('listensWithUseTVEventHandlerAndForwardsKeys', () => {
    const r = registry();
    const keys: HWEventLike[] = [];
    installRootWrapper(r, { store: store(), onKey: (e) => keys.push(e) });
    render(r.providers[0]!);
    render(r.providers[0]!);
    expect(tvEventHandlers.length).toBe(2);
    // The same handler every render, so the hook does not resubscribe.
    expect(tvEventHandlers[0]).toBe(tvEventHandlers[1]);
    tvEventHandlers[0]!({ eventType: 'playpause', eventKeyAction: 0 });
    expect(keys).toEqual([{ eventType: 'playpause', eventKeyAction: 0 }]);
  });

  it('aThrowingKeyHandlerNeverReachesTheHost', () => {
    const r = registry();
    installRootWrapper(r, {
      store: store(),
      onKey: () => {
        throw new Error('sdk');
      },
    });
    render(r.providers[0]!);
    expect(() => tvEventHandlers[0]!({ eventType: 'up' })).not.toThrow();
    expect(() => tvEventHandlers[0]!(undefined)).not.toThrow();
  });
});

describe('prompts', () => {
  it('promptShownOnlyOnceItIsTheVisibleToast', () => {
    const s = store();
    s.setMounted(true);
    const shown: number[] = [];
    const start = Date.now();
    s.toast('Captured · Aurimas');
    s.prompt('Recording remote keys for 10 seconds', () => shown.push(Date.now() - start));
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(TOAST_MS);
    expect(s.snapshot().toast).toBe('Recording remote keys for 10 seconds');
    expect(shown).toEqual([TOAST_MS]);
  });

  it('promptWaitsForAMountedRoot', () => {
    const s = store();
    const shown: number[] = [];
    s.prompt('Recording remote keys for 10 seconds', () => shown.push(Date.now()));
    vi.advanceTimersByTime(TOAST_MS * 5);
    expect(shown).toEqual([]);
    const at = Date.now();
    s.setMounted(true);
    expect(shown).toEqual([at]);
    // Its display time starts when it is shown.
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(s.snapshot().toast).toBe('Recording remote keys for 10 seconds');
    vi.advanceTimersByTime(1);
    expect(s.snapshot().toast).toBeNull();
  });

  it('promptWaitsForTheForeground', () => {
    const s = store();
    s.setMounted(true);
    s.setForeground(false);
    const shown: number[] = [];
    s.prompt('Recording remote keys for 10 seconds', () => shown.push(1));
    vi.advanceTimersByTime(TOAST_MS * 5);
    expect(shown).toEqual([]);
    s.setForeground(true);
    expect(shown).toEqual([1]);
  });

  it('cancelledPromptIsNeverShown', () => {
    const s = store();
    s.setMounted(true);
    const shown: number[] = [];
    s.toast('first');
    const cancel = s.prompt('Recording remote keys for 10 seconds', () => shown.push(1));
    s.toast('after');
    cancel();
    vi.advanceTimersByTime(TOAST_MS);
    expect(s.snapshot().toast).toBe('after');
    vi.advanceTimersByTime(TOAST_MS * 3);
    expect(shown).toEqual([]);
  });

  it('cancellingAPromptWaitingForMountMovesOn', () => {
    const s = store();
    const cancel = s.prompt('Recording remote keys for 10 seconds', () => undefined);
    s.toast('next');
    cancel();
    expect(s.snapshot().toast).toBe('next');
  });

  it('promptSurvivesTheQueueCap', () => {
    const s = store();
    s.setMounted(true);
    const shown: number[] = [];
    s.toast('showing');
    s.prompt('Recording remote keys for 10 seconds', () => shown.push(1));
    for (let i = 0; i < TOAST_QUEUE_MAX + 2; i++) s.toast(`t${i}`);
    vi.advanceTimersByTime(TOAST_MS);
    expect(shown).toEqual([1]);
  });
});
