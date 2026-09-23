// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Navigation screen markers for React. The React Native SDK carries a matching
// surface; signatures are deliberately identical so a host shipping both
// platforms writes the same line in both.
//
// Host-opt-in and MANUAL. It patches no router, so automatic capture stays a
// separate concern.
//
// Per-router recipes:
//   react-router (component stays mounted while nested routes change):
//     useEverframeScreen(location.pathname);
//   hash router (History-API capture is blind to it — the common TV case):
//     useEverframeScreen(currentRouteName);
//   tabs that keep hidden panels mounted:
//     useEverframeScreen(name, { focused: isActive });
'use client';

import * as React from 'react';
import { recordScreen } from './contextSeam.js';

/**
 * Emit a navigation marker when this screen appears: on mount, on [name]
 * change, and whenever `opts.focused` flips to true.
 *
 * `focused` defaults to true (mount = appearance — correct when your router
 * unmounts hidden screens). Pass it for routers that keep screens mounted.
 * The `A → A` suppression in the recorder absorbs StrictMode double-mounts
 * and refocus re-emits. [name] should be a route identifier, never user
 * content (PII).
 */
export function useEverframeScreen(name: string, opts?: { focused?: boolean }): void {
  const focused = opts?.focused ?? true;
  React.useEffect(() => {
    if (focused) recordScreen(name);
  }, [name, focused]);
}

export interface EverframeScreenProps {
  name: string;
  focused?: boolean;
}

/**
 * Declarative form of [useEverframeScreen] for class components / JSX-only
 * placement. Renders nothing.
 */
export function EverframeScreen(props: EverframeScreenProps): null {
  const opts = props.focused !== undefined ? { focused: props.focused } : undefined;
  useEverframeScreen(props.name, opts);
  return null;
}
