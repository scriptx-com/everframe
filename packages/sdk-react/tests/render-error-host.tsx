// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Host page for render-error-browser.mjs: EverframeProvider at the root of a
// createRoot app with no error boundary of its own, and three ways to crash it:
// a throw while rendering, a throw in an effect, and a throw in a timer.
import { Component, StrictMode, useEffect, useSyncExternalStore, version, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EverframeProvider } from '../src/provider.js';

type Armed = 'render' | 'effect' | null;
let armed: Armed = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function ExplodingRow(): ReactNode {
  throw new Error('smoke js-render: ExplodingRow');
}

function ExplodingEffect(): ReactNode {
  useEffect(() => {
    throw new Error('smoke js-effect: ExplodingEffect');
  }, []);
  return <p>effect</p>;
}

function CrashHost() {
  const kind = useSyncExternalStore(subscribe, () => armed, () => armed);
  if (kind === 'render') return <section><ExplodingRow /></section>;
  if (kind === 'effect') return <ExplodingEffect />;
  return <p id="ready">ready</p>;
}

class HostBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <p id="fallback">fallback</p> : this.props.children;
  }
}

let root: Root | undefined;

export function mount(options: { strict?: boolean; hostBoundary?: boolean; armed?: Armed } = {}): void {
  armed = options.armed ?? null;
  root = createRoot(document.getElementById('root')!);
  const host = options.hostBoundary ? <HostBoundary><CrashHost /></HostBoundary> : <CrashHost />;
  const tree = (
    <EverframeProvider config={{ sdkKey: 'pk_test', appName: 'render-error-host', appVersion: '1.0.0' }}>
      {host}
    </EverframeProvider>
  );
  root.render(options.strict ? <StrictMode>{tree}</StrictMode> : tree);
}

/** A timer flips an external store, outside any React event. */
export function trigger(kind: 'render' | 'effect' | 'handler'): void {
  setTimeout(() => {
    if (kind === 'handler') throw new Error('smoke js-handler: onJsHandler');
    armed = kind;
    for (const listener of listeners) listener();
  }, 0);
}

export const reactVersion = version;
