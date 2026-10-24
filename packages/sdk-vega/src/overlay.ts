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
  /** True while the root wrapper is mounted (its effect ran). */
  mounted(): boolean;
  /** Called by the root wrapper's effect. */
  setMounted(value: boolean): void;
}

export function createOverlayStore(deps: {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}): OverlayStore {
  let banner: { owner: object; title: string; subline: string } | null = null;
  let toast: string | null = null;
  let toastTimer: unknown;
  const pending: string[] = [];
  const listeners = new Set<() => void>();
  let isMounted = false;
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

  function next(): void {
    toast = pending.shift() ?? null;
    if (toast !== null) {
      toastTimer = deps.setTimeout(() => {
        toastTimer = undefined;
        next();
      }, TOAST_MS);
    }
    emit();
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
      if (toast === null && toastTimer === undefined) {
        pending.push(text);
        next();
        return;
      }
      pending.push(text);
      while (pending.length > TOAST_QUEUE_MAX) pending.shift();
    },
    snapshot: () => snap,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    mounted: () => isMounted,
    setMounted(value) {
      isMounted = value;
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
    let Host: ComponentType<WrapperProps> | null = null;
    const listen = typeof useTVEventHandler === 'function';
    // One stable handler: `useTVEventHandler` resubscribes when it changes.
    const handler = (event: unknown): void => {
      try {
        deps.onKey((event ?? {}) as HWEventLike);
      } catch {
        // Key handling never reaches the host.
      }
    };

    function EverframeRoot(props: WrapperProps): ReactNode {
      const [snap, setSnap] = useState<OverlaySnapshot>(() => deps.store.snapshot());
      useEffect(() => {
        deps.store.setMounted(true);
        const off = deps.store.subscribe(() => setSnap(deps.store.snapshot()));
        setSnap(deps.store.snapshot());
        return () => {
          off();
          deps.store.setMounted(false);
        };
      }, []);
      if (listen) useTVEventHandler(handler);
      const { children, ...rest } = props;
      const content = Host ? el(Host, rest, children) : children;
      return el(Fragment, null, content, overlayLayer(snap));
    }

    const provider = (params: unknown): unknown => {
      Host = null;
      if (hostProvider) {
        try {
          const resolved = hostProvider(params);
          if (typeof resolved === 'function' || (typeof resolved === 'object' && resolved !== null))
            Host = resolved as ComponentType<WrapperProps>;
        } catch {
          Host = null;
        }
      }
      return EverframeRoot;
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
