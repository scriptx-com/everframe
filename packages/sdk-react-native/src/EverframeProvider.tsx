// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// <EverframeProvider> + useEverframe(). After the D-05/D-07 flip (2026-05-11)
// the provider is purely a configure-on-mount + React-context wrapper around
// the slim runtime — there is no JS reporter modal to render.
//
// Native Android/iOS shake-to-report is installed below the JS layer. Hosts
// call `useEverframe().open()` (or the top-level `open()` re-export) from their
// own buttons, hotkeys, overlays, and TV trigger handlers.
import * as React from 'react';
import { createRuntime, type Runtime, type RuntimeConfig } from './runtime.js';
import {
  EverframeNotMountedError,
  type EverframeContextValue,
} from './contextSeam.js';

const Ctx = React.createContext<EverframeContextValue | null>(null);

export interface EverframeProviderProps {
  config: RuntimeConfig;
  children: React.ReactNode;
}

export function EverframeProvider(props: EverframeProviderProps): React.ReactElement {
  const [runtime] = React.useState<Runtime>(() => createRuntime(props.config));

  // useLayoutEffect ensures the module-level current-context is set BEFORE
  // any child useEverframe() consumer reads it during the same commit.
  React.useLayoutEffect(() => {
    runtime.mount();
    return () => runtime.unmount();
  }, [runtime]);

  return React.createElement(Ctx.Provider, { value: runtime }, props.children);
}

/**
 * Read the active runtime from React context. Throws if no provider is
 * mounted above the call site.
 */
export function useEverframe(): EverframeContextValue {
  const ctx = React.useContext(Ctx);
  if (!ctx) {
    throw new EverframeNotMountedError(
      'useEverframe() called outside a <EverframeProvider>. Wrap your app root.'
    );
  }
  return ctx;
}
