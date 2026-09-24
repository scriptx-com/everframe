// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// react-navigation screen tracking (spec 2026-07-14 RN-iOS parity). A thin
// adapter over recordScreen — the NATIVE side derives from→to and
// suppresses A→A re-emits, so this just reports "current route is now X".
// Covers expo-router too (react-navigation underneath).
//
// DUCK-TYPED on purpose: react-navigation is the most popular navigator,
// not the only one — this package takes no dependency on it, and any other
// stack (Wix RNN, react-router-native, hand-rolled) gets the same behavior
// with a ~5-line adapter calling recordScreen (recipes in the README).
//
// Wiring (recommended):
//   const navigationRef = createNavigationContainerRef();
//   const txNav = reactNavigationIntegration({ navigationRef });
//   <EverframeProvider config={{ ..., integrations: [txNav] }}>
//     <NavigationContainer ref={navigationRef} onReady={txNav.onReady}>
// onReady covers the initial route when the container becomes ready AFTER
// the provider mounts; onStateChange is a fallback for ref versions whose
// addListener misbehaves.
import { recordScreen } from '../contextSeam.js';
import type { EverframeIntegration } from './types.js';

/** Duck-typed subset of react-navigation's NavigationContainerRef. */
export interface NavigationRefLike {
  isReady(): boolean;
  getCurrentRoute(): { name?: string } | undefined;
  addListener(type: 'state', callback: () => void): () => void;
}

export interface ReactNavigationIntegration extends EverframeIntegration {
  /** Pass to <NavigationContainer onReady> to record the initial route. */
  onReady(): void;
  /** Pass to <NavigationContainer onStateChange> as a listener fallback. */
  onStateChange(): void;
}

export function reactNavigationIntegration(opts: {
  navigationRef: NavigationRefLike;
}): ReactNavigationIntegration {
  const emit = (): void => {
    // Route names are developer-defined identifiers, never user content —
    // same PII stance as useEverframeScreen. Native A→A suppression dedups
    // double-wiring (listener + onStateChange both firing).
    try {
      const name = opts.navigationRef.getCurrentRoute?.()?.name;
      if (name) recordScreen(name);
    } catch {
      // Fail-soft: this runs inside the navigator's own dispatch (as a
      // 'state' listener and as onReady/onStateChange), so a throw here
      // must never propagate into host navigation.
    }
  };
  return {
    name: 'react-navigation',
    onReady: emit,
    onStateChange: emit,
    setup() {
      try {
        if (opts.navigationRef.isReady()) emit();
      } catch {
        // A pre-ready ref may throw from getCurrentRoute — treat as not ready.
      }
      try {
        return opts.navigationRef.addListener('state', emit);
      } catch {
        // Some ref implementations only support listeners once rendered —
        // hosts fall back to the onReady/onStateChange container props.
        return undefined;
      }
    },
  };
}
