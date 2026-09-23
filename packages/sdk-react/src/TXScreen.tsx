// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Navigation screen markers — the React twin of
// @everframe/react-native/src/TXScreen.tsx. Signatures are deliberately
// identical: a host shipping both platforms writes the same line in both.
//
// Host-opt-in and MANUAL. It patches no router, so automatic capture stays a
// separate concern.
//
// Per-router recipes:
//   react-router (component stays mounted while nested routes change):
//     useTXScreen(location.pathname);
//   hash router (History-API capture is blind to it — the common TV case):
//     useTXScreen(currentRouteName);
//   tabs that keep hidden panels mounted:
//     useTXScreen(name, { focused: isActive });
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
