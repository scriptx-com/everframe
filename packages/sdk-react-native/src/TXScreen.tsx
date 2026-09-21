// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Navigation screen markers (spec 2026-07-14) — the framework-agnostic
// answer to "react-navigation / Wix RNN / hand-rolled tabs emit zero
// navigation crumbs". One hook (or component) per screen; the NATIVE side
// derives `from → to` from its global chain (shared with native
// auto-capture), so the trail reads e.g. `MainActivity → Desk → Specimens`.
//
// This is a host-opt-in MANUAL API — it does not patch any navigator, so
// the "JS auto-capture is a non-goal" ruling (contextSeam.ts) stands.
//
// Per-stack recipes:
//   react-navigation (screens stay mounted — pass focus):
//     useTXScreen(route.name, { focused: useIsFocused() });
//   …or whole-app in one place:
//     <NavigationContainer onStateChange={() =>
//       recordScreen(navRef.getCurrentRoute()?.name ?? '')}>
//   Wix RNN:
//     componentDidAppear() { recordScreen(this.props.screenName); }
//   Hand-rolled conditional-render navigation:
//     useTXScreen('Desk');
import * as React from 'react';
import { recordScreen } from './contextSeam.js';

/**
 * Emit a navigation marker when this screen appears: on mount, on [name]
 * change, and whenever `opts.focused` flips to true.
 *
 * `focused` defaults to true (mount = appearance — correct when your
 * navigator unmounts hidden screens). Pass it for navigators that keep
 * screens mounted (react-navigation stacks/tabs: `useIsFocused()`). The
 * native `A → A` suppression absorbs StrictMode double-mounts and refocus
 * re-emits. [name] should be a route identifier, never user content (PII).
 */
export function useTXScreen(name: string, opts?: { focused?: boolean }): void {
  const focused = opts?.focused ?? true;
  React.useEffect(() => {
    if (focused) recordScreen(name);
  }, [name, focused]);
}

export interface TXScreenProps {
  name: string;
  focused?: boolean;
}

/**
 * Declarative form of [useTXScreen] for class components / JSX-only
 * placement. Renders nothing.
 */
export function TXScreen(props: TXScreenProps): null {
  const opts = props.focused !== undefined ? { focused: props.focused } : undefined;
  useTXScreen(props.name, opts);
  return null;
}
