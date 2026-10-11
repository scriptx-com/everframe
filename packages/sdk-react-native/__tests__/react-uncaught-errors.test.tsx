// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// React 19 (React Native 0.78+) reports an error that no error boundary
// catches through the root's onUncaughtError. React Native wires that to
// ExceptionsManager.handleException(error, true); ErrorUtils never sees it.
// Smoke round 2026-10: a render error on tvOS and Android TV arrived only as
// RN's native fatal (RCTFatalException / JavascriptException), with no JS stack.
import * as React from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExceptionsManager, { reported } from './stubs/react-native-exceptions-manager.js';
import NativeEverframe from '../src/NativeEverframe.js';
import { createCaptureController } from '../src/errors.js';
import { EverframeProvider } from '../src/index.js';
import { captureReactError } from '../src/integrations/react.js';
import { __getCurrentContext, __setCurrentContext } from '../src/contextSeam.js';

type Handler = (error: unknown, isFatal?: boolean) => void;
const automatic = vi.mocked(NativeEverframe.reportCrash);
const handled = vi.mocked(NativeEverframe.captureHandledException);
const originalHandleException = ExceptionsManager.handleException;
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const payloads = () => automatic.mock.calls.map(([json]) => JSON.parse(json));

function renderError(message: string, componentStack: string) {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at ExplodingRow (address at index.android.bundle:1:1243264)\n` +
    '    at renderWithHooks (address at index.android.bundle:1:504783)';
  // What RN's ErrorHandlers.getExtendedError does before handleException.
  return Object.assign(error, { componentStack, isComponentError: true });
}

let globalHandler: Handler;
beforeEach(() => {
  automatic.mockReset().mockReturnValue(true);
  handled.mockReset().mockReturnValue(true);
  reported.length = 0;
  globalHandler = vi.fn<Handler>();
  vi.stubGlobal('ErrorUtils', {
    getGlobalHandler: () => globalHandler,
    setGlobalHandler: (handler: Handler) => { globalHandler = handler; },
  });
});
afterEach(() => {
  ExceptionsManager.handleException = originalHandleException;
  __setCurrentContext(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ExceptionsManager hook', () => {
  const controllers: Array<ReturnType<typeof createCaptureController>> = [];
  const controller = (options: Parameters<typeof createCaptureController>[0] = {}) => {
    const created = createCaptureController({ exceptionsManager: ExceptionsManager, ...options });
    controllers.push(created);
    return created;
  };
  afterEach(() => { controllers.splice(0).forEach((c) => c.dispose()); });

  it('reports an uncaught React error as a fatal JS crash with its component stack, before RN reports it', () => {
    controller();
    const stack = '\n    at ExplodingRow (address at index.android.bundle:1:1243264)\n    at RCTView (<anonymous>)';
    const error = renderError('smoke js-render: ExplodingRow', stack);
    automatic.mockImplementation(() => { expect(reported).toHaveLength(0); return true; });

    ExceptionsManager.handleException(error, true);

    expect(payloads()).toEqual([expect.objectContaining({
      exceptionType: 'Error',
      message: `smoke js-render: ExplodingRow\n\nThis error is located at:${stack}`,
      framesRaw: [
        'at ExplodingRow (address at index.android.bundle:1:1243264)',
        'at renderWithHooks (address at index.android.bundle:1:504783)',
      ],
      source: 'crash', mechanism: 'errorutils', handled: false, fatal: true,
    })]);
    expect(reported).toEqual([{ error, isFatal: true }]);
  });

  it('leaves non-fatal reports (caught errors, rejections) to their own paths', () => {
    controller();
    ExceptionsManager.handleException(renderError('caught by a boundary', '\n    at Row'), false);
    expect(automatic).not.toHaveBeenCalled();
    expect(reported).toHaveLength(1);
  });

  it('does not report an ErrorUtils fatal twice when RN forwards it to ExceptionsManager', () => {
    globalHandler = (error, isFatal) => ExceptionsManager.handleException(error, isFatal === true);
    controller();
    globalHandler(new Error('press handler'), true);
    expect(automatic).toHaveBeenCalledTimes(1);
    expect(reported).toHaveLength(1);
  });

  it('does not report twice when an ErrorUtils handler forwards the error later', async () => {
    globalHandler = (error, isFatal) => { setTimeout(() => ExceptionsManager.handleException(error, isFatal === true), 0); };
    controller();
    globalHandler(new Error('flushed first'), true);
    await nextTask();
    expect(automatic).toHaveBeenCalledTimes(1);
    expect(reported).toHaveLength(1);
  });

  it('an error first reported as non-fatal is still captured when React later reports it uncaught', () => {
    globalHandler = (error, isFatal) => ExceptionsManager.handleException(error, isFatal === true);
    controller();
    const error = renderError('rethrown during render', '\n    at Row');
    globalHandler(error, false);
    ExceptionsManager.handleException(error, true);
    expect(payloads().map(({ fatal }) => fatal)).toEqual([false, true]);
  });

  it('a component stack that is not plain data is ignored, and RN still gets the original arguments', () => {
    controller();
    const error = new Error('hostile');
    let reads = 0;
    Object.defineProperty(error, 'componentStack', { get() { reads++; return '\n    at X'; } });
    const receiver = { handleException: ExceptionsManager.handleException };
    receiver.handleException(error, true);
    expect(reads).toBe(0);
    expect(payloads()[0].message).toBe('hostile');
    expect(reported).toEqual([{ error, isFatal: true }]);
  });

  it('keeps the hook for the rest of the task after dispose, only while nobody else owns capture', async () => {
    let unowned = true;
    const c = controller({ isUnowned: () => unowned });
    const wrapped = ExceptionsManager.handleException;
    c.dispose();
    ExceptionsManager.handleException(renderError('same commit', '\n    at Row'), true);
    expect(automatic).toHaveBeenCalledTimes(1);
    unowned = false;
    ExceptionsManager.handleException(renderError('new owner', '\n    at Row'), true);
    expect(automatic).toHaveBeenCalledTimes(1);
    expect(ExceptionsManager.handleException).toBe(wrapped);
    await nextTask();
    expect(ExceptionsManager.handleException).toBe(originalHandleException);
    unowned = true;
    ExceptionsManager.handleException(renderError('later task', '\n    at Row'), true);
    expect(automatic).toHaveBeenCalledTimes(1);
  });

  it('a stale controller leaves a newer hook in place', async () => {
    const first = controller();
    const second = controller();
    const newer = ExceptionsManager.handleException;
    first.dispose();
    await nextTask();
    expect(ExceptionsManager.handleException).toBe(newer);
    ExceptionsManager.handleException(renderError('once', '\n    at Row'), true);
    expect(automatic).toHaveBeenCalledTimes(1);
    second.dispose();
    await nextTask();
  });

  it('installs nothing when RN exposes no recognisable ExceptionsManager', () => {
    expect(() => controller({ exceptionsManager: null })).not.toThrow();
    expect(ExceptionsManager.handleException).toBe(originalHandleException);
  });
});

// The same commit that reports an uncaught error has already unmounted every
// component under the root, EverframeProvider included. This drives the real
// React 19 reconciler with RN's root options (RendererImplementation.js).
// Not under act(): act() collects uncaught errors instead of calling the root.
describe('EverframeProvider with a React 19 root wired like React Native', () => {
  let root: Root | undefined;
  let container: HTMLDivElement;
  const ownerAtReport: unknown[] = [];
  beforeEach(() => {
    container = document.createElement('div');
    ownerAtReport.length = 0;
    root = createRoot(container, {
      onUncaughtError(error, info) {
        ownerAtReport.push(__getCurrentContext());
        ExceptionsManager.handleException(Object.assign(error as Error,
          { componentStack: info.componentStack, isComponentError: true }), true);
      },
      onCaughtError(error, info) {
        ExceptionsManager.handleException(Object.assign(error as Error,
          { componentStack: info.componentStack, isComponentError: true }), false);
      },
    });
  });
  afterEach(async () => {
    root?.unmount();
    root = undefined;
    await nextTask();
  });

  function ExplodingRow({ explode }: { explode: boolean }) {
    if (explode) throw new Error('smoke js-render: ExplodingRow');
    return <span>row</span>;
  }
  class Boundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
    override state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    override componentDidCatch(error: unknown, info: React.ErrorInfo) { captureReactError(error, info); }
    override render() { return this.state.failed ? <span>fallback</span> : this.props.children; }
  }

  it('captures a render error with no boundary as one fatal JS crash', async () => {
    const tree = (explode: boolean) => (
      <EverframeProvider config={{ sdkKey: 'evf_test_key' }}><ExplodingRow explode={explode} /></EverframeProvider>
    );
    flushSync(() => root!.render(tree(false)));
    flushSync(() => root!.render(tree(true)));

    expect(ownerAtReport).toEqual([null]);
    expect(payloads()).toEqual([expect.objectContaining({
      exceptionType: 'Error', source: 'crash', mechanism: 'errorutils', handled: false, fatal: true,
      message: expect.stringMatching(/^smoke js-render: ExplodingRow\n\nThis error is located at:\n\s+at ExplodingRow/),
    })]);
    expect(payloads()[0].message).toContain('EverframeProvider');
    expect(globalHandler).not.toHaveBeenCalled();
    expect(reported).toEqual([{ error: expect.objectContaining({ message: 'smoke js-render: ExplodingRow' }), isFatal: true }]);
    await nextTask();
    expect(ExceptionsManager.handleException).toBe(originalHandleException);
  });

  it('leaves an error a boundary caught to captureReactError', () => {
    const tree = (explode: boolean) => (
      <EverframeProvider config={{ sdkKey: 'evf_test_key' }}><Boundary><ExplodingRow explode={explode} /></Boundary></EverframeProvider>
    );
    flushSync(() => root!.render(tree(false)));
    flushSync(() => root!.render(tree(true)));
    expect(container.textContent).toBe('fallback');
    expect(automatic).not.toHaveBeenCalled();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(reported).toEqual([{ error: expect.any(Error), isFatal: false }]);
  });
});
