// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import * as React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { captureReactError } from '../src/integrations/react.js';
import { captureException, getErrorCaptureStatus, EverframeProvider } from '../src/index.js';
import NativeEverframe from '../src/NativeEverframe.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { __setCurrentContext } from '../src/contextSeam.js';
const native = vi.mocked(NativeEverframe.captureHandledException);
const automatic = vi.mocked(NativeEverframe.reportCrash);
const runtimes: Runtime[] = [];
let handler: (error: unknown, fatal?: boolean) => void;
function mount(disabled = false) { const r = createRuntime({ apiKey: 'txx_test_key', crashReporting: { disabled } }); runtimes.push(r); r.mount(); return r; }
class Boundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: unknown, info: React.ErrorInfo) { captureReactError(error, info); }
  override render() { return this.state.failed ? <span>Boundary fallback</span> : this.props.children; }
}
function Child({ error }: { error?: Error }) { if (error) throw error; return <span>Ready</span>; }
beforeEach(() => {
  native.mockReset().mockReturnValue(true); automatic.mockReset().mockReturnValue(true);
  handler = () => {};
  vi.stubGlobal('ErrorUtils', { getGlobalHandler: () => handler, setGlobalHandler: (value: typeof handler) => { handler = value; } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); runtimes.splice(0).forEach(r => r.unmount()); __setCurrentContext(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('a genuine mounted boundary renders fallback and shares accepted identity with other paths', () => {
  const e = new Error('render failure');
  const tree = (error?: Error) => <EverframeProvider config={{ apiKey: 'txx_test_key' }}><Boundary><Child error={error} /></Boundary></EverframeProvider>;
  const view = render(tree()); view.rerender(tree(e));
  expect(screen.getByText('Boundary fallback')).toBeTruthy();
  captureException(e); handler(e, false);
  expect(native).toHaveBeenCalledTimes(1); expect(automatic).not.toHaveBeenCalled();
  expect(JSON.parse(native.mock.calls[0][0])).toMatchObject({ source: 'error', mechanism: 'captureException', handled: true, fatal: false,
    details: { context: 'react.error-boundary', metadata: { componentStack: expect.stringContaining('Child') } } });
  expect(getErrorCaptureStatus().counters).toMatchObject({ handled: { attempted: 2, accepted: 1, duplicateSuppressed: 1 }, errorUtils: { attempted: 1, duplicateSuppressed: 1 } });
});
it.each(['inherited', 'accessor', 'nonstring', 'throwing', 'revoked'])('omits %s componentStack without invoking caller code', kind => {
  mount(); const getter = vi.fn(() => 'secret'); let info: object;
  if (kind === 'inherited') info = Object.create({ componentStack: 'inherited' });
  else if (kind === 'accessor') info = Object.defineProperty({}, 'componentStack', { get: getter });
  else if (kind === 'nonstring') info = { componentStack: { toString: getter } };
  else if (kind === 'throwing') info = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('trap'); } });
  else { const proxy = Proxy.revocable({}, {}); proxy.revoke(); info = proxy.proxy; }
  expect(() => captureReactError(new Error('render'), info)).not.toThrow();
  expect(getter).not.toHaveBeenCalled(); expect(native).toHaveBeenCalledTimes(1);
  expect(JSON.parse(native.mock.calls[0][0]).details.metadata).toBeUndefined();
});
it('bounds oversized and lone-surrogate metadata while preserving truncation evidence', () => {
  mount(); captureReactError(new Error('render'), { componentStack: '\ud800' + 'x'.repeat(7000) });
  const details = JSON.parse(native.mock.calls[0][0]).details;
  expect(details.metadata.componentStack.length).toBeLessThanOrEqual(1024);
  expect(new TextEncoder().encode(JSON.stringify(details)).length).toBeLessThanOrEqual(8192);
  expect(details.truncated).toBeDefined();
});
it('infoProxyRemountCannotCaptureSuccessor', () => {
  const old = mount();
  const info = new Proxy({}, { getOwnPropertyDescriptor() { old.unmount(); mount(); return { configurable: true, value: 'stack' }; } });
  captureReactError(new Error('old render'), info);
  expect(native).not.toHaveBeenCalled(); expect(getErrorCaptureStatus().counters.handled.attempted).toBe(0);
});
it('refused boundary capture can be accepted later', () => {
  mount(); native.mockReturnValueOnce(false); const e = new Error('render'); captureReactError(e); captureReactError(e);
  expect(native).toHaveBeenCalledTimes(2);
  expect(getErrorCaptureStatus().counters.handled).toMatchObject({ attempted: 2, nativeRefused: 1, accepted: 1 });
});
it('initial fallback before any provider remains inert and is not replayed', () => {
  render(<Boundary><Child error={new Error('initial')} /></Boundary>);
  expect(screen.getByText('Boundary fallback')).toBeTruthy();
  expect(getErrorCaptureStatus().status).toBe('not-mounted'); mount();
  expect(native).not.toHaveBeenCalled(); expect(getErrorCaptureStatus().counters.handled.attempted).toBe(0);
});
const outside = (error?: Error) => <Boundary><EverframeProvider config={{ apiKey: 'txx_test_key' }}><Child error={error} /></EverframeProvider></Boundary>;
const firstCommit = () => <EverframeProvider config={{ apiKey: 'txx_test_key' }}><Boundary><Child error={new Error('first commit')} /></Boundary></EverframeProvider>;
it('a boundary wrapping the provider is inert because the provider unmounts before componentDidCatch', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const view = render(outside()); expect(getErrorCaptureStatus().status).toBe('active');
  view.rerender(outside(new Error('update failure')));
  expect(screen.getByText('Boundary fallback')).toBeTruthy();
  expect(native).not.toHaveBeenCalled(); expect(getErrorCaptureStatus().status).toBe('not-mounted');
  expect(warn).not.toHaveBeenCalled();
});
it('an error caught during the provider first commit is not captured', () => {
  render(firstCommit());
  expect(screen.getByText('Boundary fallback')).toBeTruthy(); expect(native).not.toHaveBeenCalled();
  expect(getErrorCaptureStatus()).toMatchObject({ status: 'active', counters: { handled: { attempted: 0 } } });
});
it('development builds warn once per provider mount change when no provider is mounted', () => {
  vi.stubGlobal('__DEV__', true); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  render(firstCommit()); expect(warn).toHaveBeenCalledTimes(1); cleanup();
  const view = render(outside()); view.rerender(outside(new Error('update failure'))); captureReactError(new Error('repeat'));
  expect(warn).toHaveBeenCalledTimes(2);
  for (const [message] of warn.mock.calls) expect(String(message)).toContain('inside <EverframeProvider>');
  mount(true); captureReactError(new Error('disabled')); expect(warn).toHaveBeenCalledTimes(2);
  expect(native).not.toHaveBeenCalled();
});
it('disabled and unmounted calls remain inert; remount resets counters', () => {
  captureReactError(new Error('before')); const disabled = mount(true); captureReactError(new Error('disabled'));
  expect(getErrorCaptureStatus()).toMatchObject({ status: 'disabled', reason: 'crash-reporting-disabled', counters: { handled: { attempted: 0 } } });
  disabled.unmount(); const active = mount(); captureReactError(new Error('active'));
  expect(getErrorCaptureStatus().counters.handled.accepted).toBe(1); active.unmount(); captureReactError(new Error('after'));
  mount(); expect(getErrorCaptureStatus().counters.handled.accepted).toBe(0); expect(native).toHaveBeenCalledTimes(1);
});

it('same-runtime remount during info inspection cannot charge the successor mount', () => {
  const runtime = mount();
  const info = new Proxy({}, { getOwnPropertyDescriptor() { runtime.unmount(); runtime.mount(); return { configurable: true, value: 'stack' }; } });
  captureReactError(new Error('old invocation'), info);
  expect(native).not.toHaveBeenCalled(); expect(getErrorCaptureStatus().counters.handled.attempted).toBe(0);
});
it('a hostile info trap cannot remount through a late Reflect.apply lookup', () => {
  const old = mount();
  const original = Object.getOwnPropertyDescriptor(Reflect, 'apply')!;
  let lookups = 0;
  const info = new Proxy({}, { getOwnPropertyDescriptor() {
    Object.defineProperty(Reflect, 'apply', { configurable: true, get() {
      Object.defineProperty(Reflect, 'apply', original); lookups++; old.unmount(); mount(); return original.value;
    } });
    return { configurable: true, value: 'stack' };
  } });
  try { captureReactError(new Error('original mount'), info); }
  finally { Object.defineProperty(Reflect, 'apply', original); }
  expect(lookups).toBe(0);
  expect(old.getErrorCaptureStatus().counters.handled.accepted).toBe(1);
});
