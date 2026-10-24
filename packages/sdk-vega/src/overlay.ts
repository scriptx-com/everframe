// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The SDK's root wrapper. `init()` installs it with
// `AppRegistry.setWrapperComponentProvider`, so it renders around the host
// app with no host code: inside `RootTagContext`, where `useTVEventHandler`
// receives remote keys (Vega spike, 2026-10-24), and above the app, where it
// draws the linking banner and capture toasts.
//
// The overlay never takes focus or touches and never handles a key: the app
// receives every key exactly as before.
import {
  createElement,
  Fragment,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { Text, View, useTVEventHandler } from 'react-native';
import type { Presenter } from './device-link.js';
import { bannerTitle, BANNER_SUBLINE } from './link-copy.js';

export const TOAST_MS = 3000;
export const TOAST_QUEUE_MAX = 3;

export type { Presenter } from './device-link.js';

export interface OverlaySnapshot {
  banner: { title: string; subline: string } | null;
  toast: string | null;
}

export interface OverlayStore extends Presenter {
  snapshot(): OverlaySnapshot;
  subscribe(fn: () => void): () => void;
  /** True while at least one root wrapper is mounted (its effect ran). */
  mounted(): boolean;
  /** One mounted root wrapper; call the returned function when it unmounts. */
  retain(): () => void;
  /** Test helper: one manual registration, on or off. */
  setMounted(value: boolean): void;
  /**
   * Queues `text` like a toast, but `onShown` runs only once it is really on
   * screen: the current toast, a root mounted, the app in the foreground. Its
   * display time starts then. The queue cap never drops it. The returned
   * function withdraws it if it has not been shown yet.
   */
  prompt(text: string, onShown: () => void): () => void;
  /** The app's `AppState` is `active` (default true). */
  setForeground(value: boolean): void;
}

interface Entry {
  text: string;
  onShown?: () => void;
}

export function createOverlayStore(deps: {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}): OverlayStore {
  let banner: { owner: object; title: string; subline: string } | null = null;
  let toast: string | null = null;
  let current: Entry | null = null;
  let toastTimer: unknown;
  /** The current entry is a prompt waiting to be visible. */
  let holding = false;
  let foreground = true;
  const pending: Entry[] = [];
  const listeners = new Set<() => void>();
  // One entry per mounted root: several AppRegistry roots can run at once,
  // and unmounting one must not disable the others.
  const registrations = new Set<object>();
  const manual = {};
  let snap: OverlaySnapshot = { banner: null, toast: null };

  function emit(): void {
    snap = {
      banner: banner ? { title: banner.title, subline: banner.subline } : null,
      toast,
    };
    listeners.forEach((fn) => {
      try {
        fn();
      } catch {
        // A subscriber never breaks the overlay.
      }
    });
  }

  const visible = (): boolean => registrations.size > 0 && foreground;

  function startTimer(): void {
    toastTimer = deps.setTimeout(() => {
      toastTimer = undefined;
      next();
    }, TOAST_MS);
  }

  /** Shows a held prompt once it can be seen. */
  function release(): void {
    const entry = current;
    if (!holding || !entry || !visible()) return;
    holding = false;
    startTimer();
    try {
      entry.onShown?.();
    } catch {
      // A prompt's owner never breaks the overlay.
    }
  }

  function next(): void {
    current = pending.shift() ?? null;
    toast = current ? current.text : null;
    holding = false;
    if (current) {
      if (current.onShown) holding = true;
      else startTimer();
    }
    emit();
    release();
  }

  function enqueue(entry: Entry): void {
    pending.push(entry);
    if (current === null && toastTimer === undefined) {
      next();
      return;
    }
    // Over the cap, drop the oldest plain toast; a prompt is never dropped.
    while (pending.length > TOAST_QUEUE_MAX) {
      const index = pending.findIndex((e) => !e.onShown);
      if (index < 0) break;
      pending.splice(index, 1);
    }
  }

  return {
    showBanner(owner, number) {
      banner = { owner, title: bannerTitle(number), subline: BANNER_SUBLINE };
      emit();
    },
    hideBanner(owner) {
      if (!banner || banner.owner !== owner) return;
      banner = null;
      emit();
    },
    toast(text) {
      if (typeof text !== 'string' || text.length === 0) return;
      enqueue({ text });
    },
    prompt(text, onShown) {
      const entry: Entry = { text, onShown };
      enqueue(entry);
      return () => {
        const index = pending.indexOf(entry);
        if (index >= 0) pending.splice(index, 1);
        else if (current === entry && holding) next();
      };
    },
    setForeground(value) {
      foreground = value;
      release();
    },
    snapshot: () => snap,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    mounted: () => registrations.size > 0,
    retain() {
      const registration = {};
      registrations.add(registration);
      release();
      return () => {
        registrations.delete(registration);
      };
    },
    setMounted(value) {
      if (value) registrations.add(manual);
      else registrations.delete(manual);
      release();
    },
  };
}

/** A React Native for Vega `onHWKeyEvent` payload, as far as the SDK reads it. */
export type HWEventLike = { eventType?: unknown; eventKeyAction?: unknown };

export interface AppRegistryLike {
  setWrapperComponentProvider(provider: (params: unknown) => unknown): void;
}

type WrapperProps = { children?: ReactNode; [key: string]: unknown };
type HostProvider = (params: unknown) => unknown;

const styles = {
  layer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
  },
  banner: {
    position: 'absolute',
    top: 48,
    maxWidth: 1200,
    alignItems: 'center',
    paddingHorizontal: 36,
    paddingVertical: 18,
    borderRadius: 28,
    backgroundColor: 'rgba(17, 17, 20, 0.92)',
  },
  title: { color: '#ffffff', fontSize: 30, fontWeight: '600' },
  subline: { color: 'rgba(255, 255, 255, 0.78)', fontSize: 20, marginTop: 6 },
  toast: {
    position: 'absolute',
    bottom: 64,
    maxWidth: 1200,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 28,
    backgroundColor: 'rgba(17, 17, 20, 0.92)',
  },
  toastText: { color: '#ffffff', fontSize: 24 },
} as const;

const el = createElement as (type: unknown, props?: unknown, ...children: unknown[]) => ReactNode;

function overlayLayer(snap: OverlaySnapshot): ReactNode {
  if (!snap.banner && snap.toast === null) return null;
  const hidden = { pointerEvents: 'none', focusable: false, accessible: false };
  return el(
    View,
    { ...hidden, style: styles.layer, testID: 'everframe-overlay' },
    snap.banner
      ? el(
          View,
          { ...hidden, style: styles.banner },
          el(Text, { style: styles.title }, snap.banner.title),
          el(Text, { style: styles.subline }, snap.banner.subline),
        )
      : null,
    snap.toast !== null
      ? el(
          View,
          { ...hidden, style: styles.toast },
          el(Text, { style: styles.toastText }, snap.toast),
        )
      : null,
  );
}

/**
 * Installs the SDK's root wrapper, then replaces
 * `registry.setWrapperComponentProvider` so a provider the host sets later is
 * rendered inside it instead of replacing it. Never throws.
 */
export function installRootWrapper(
  registry: AppRegistryLike,
  deps: { store: OverlayStore; onKey: (event: HWEventLike) => void },
): void {
  try {
    let hostProvider: HostProvider | null = null;
    const listen = typeof useTVEventHandler === 'function';
    // One stable handler: `useTVEventHandler` resubscribes when it changes.
    const handler = (event: unknown): void => {
      try {
        deps.onKey((event ?? {}) as HWEventLike);
      } catch {
        // Key handling never reaches the host.
      }
    };

    interface RootEntry {
      Wrapper: (props: WrapperProps) => ReactNode;
      /** The host wrapper this root renders inside ours; read at render time. */
      host: { current: ComponentType<WrapperProps> | null };
    }

    /**
     * One wrapper component per root, created once. AppRegistry calls the
     * provider again for the same root (`setSurfaceProps`): a new component
     * type there would unmount and remount the whole app. A host provider may
     * answer each root differently, so the host wrapper is kept per root, in
     * the entry the stable wrapper reads, never in a slot roots share.
     */
    function createRootEntry(): RootEntry {
      const host: RootEntry['host'] = { current: null };
      function EverframeRoot(props: WrapperProps): ReactNode {
        const [snap, setSnap] = useState<OverlaySnapshot>(() => deps.store.snapshot());
        useEffect(() => {
          const release = deps.store.retain();
          const off = deps.store.subscribe(() => setSnap(deps.store.snapshot()));
          setSnap(deps.store.snapshot());
          return () => {
            off();
            release();
          };
        }, []);
        if (listen) useTVEventHandler(handler);
        const { children, ...rest } = props;
        const Host = host.current;
        const content = Host ? el(Host, rest, children) : children;
        return el(Fragment, null, content, overlayLayer(snap));
      }
      return { Wrapper: EverframeRoot, host };
    }

    const byRootTag = new Map<string | number, RootEntry>();
    // Without a root tag (not seen on React Native for Vega), one wrapper per
    // resolved host wrapper keeps identity stable just the same.
    const byHost = new Map<ComponentType<WrapperProps> | null, RootEntry>();

    function resolveHost(params: unknown): ComponentType<WrapperProps> | null {
      if (!hostProvider) return null;
      try {
        const resolved = hostProvider(params);
        return typeof resolved === 'function' || (typeof resolved === 'object' && resolved !== null)
          ? (resolved as ComponentType<WrapperProps>)
          : null;
      } catch {
        return null;
      }
    }

    const provider = (params: unknown): unknown => {
      const Host = resolveHost(params);
      const tag = (params as { rootTag?: unknown } | null | undefined)?.rootTag;
      if (typeof tag === 'number' || typeof tag === 'string') {
        let entry = byRootTag.get(tag);
        if (!entry) {
          entry = createRootEntry();
          byRootTag.set(tag, entry);
        }
        entry.host.current = Host;
        return entry.Wrapper;
      }
      let entry = byHost.get(Host);
      if (!entry) {
        entry = createRootEntry();
        entry.host.current = Host;
        byHost.set(Host, entry);
      }
      return entry.Wrapper;
    };

    registry.setWrapperComponentProvider(provider);
    try {
      registry.setWrapperComponentProvider = (next: HostProvider) => {
        hostProvider = typeof next === 'function' ? next : null;
      };
    } catch {
      // A frozen registry: a later host provider replaces ours.
    }
  } catch {
    // Without the wrapper there is no banner, toast or key listening; crash
    // and error reporting are unaffected.
  }
}
