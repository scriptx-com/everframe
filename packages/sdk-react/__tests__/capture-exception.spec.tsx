// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { ReportEnvelope } from '@everframe/protocol';
import {
  EverframeProvider,
  useEverframe,
  captureException,
  type CaptureExceptionOptions,
  type ErrorSeverity,
} from '../src/index.js';

let events: Map<string, ReportEnvelope>;

beforeEach(() => {
  localStorage.clear();
  events = new Map();
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, options?: RequestInit) => {
    if (String(url).endsWith('/api/ingest')) {
      const part = (options!.body as FormData).get('envelope') as Blob;
      const envelope = ReportEnvelope.parse(JSON.parse(await part.text()));
      events.set(envelope.reportId, envelope);
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function errorAt(name: string): Error {
  const error = new Error('checkout failed');
  error.stack = `Error: checkout failed\n    at ${name} (app.js:1:250)`;
  return error;
}

function errorAtWithCause(name: string, cause: unknown): Error {
  const error = new Error('checkout failed', { cause });
  error.stack = `Error: checkout failed\n    at ${name} (app.js:1:250)`;
  return error;
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <EverframeProvider config={{ apiKey: 'pk_test', appVersion: '2.1', appBuild: 'react-abc123' }}>
      {children}
    </EverframeProvider>
  );
}

describe('React captureException public API', () => {
  it.each([false, true])('shares hook, top-level, and automatic capture (StrictMode=%s)', async strict => {
    const { result } = renderHook(() => useEverframe(), {
      wrapper: ({ children }) => strict ? <StrictMode>{wrapper({ children })}</StrictMode> : wrapper({ children }),
    });
    result.current.setUser({ id: 'react-user' });
    result.current.addBreadcrumb({ message: 'React checkout opened' });
    const inner = new TypeError('payment root');
    const error = errorAtWithCause('hook', inner);
    const severity: ErrorSeverity = 'warning';
    const hookOptions: CaptureExceptionOptions = {
      severity,
      context: 'hook checkout',
      metadata: { accessToken: 'synthetic' },
    };
    result.current.captureException(error, hookOptions);
    captureException(error);
    window.onerror?.(error.message, 'app.js', 1, 250, error);
    await vi.waitFor(() => expect(events.size).toBe(1));
    expect([...events.values()][0]).toMatchObject({
      sdk: { name: 'everframe-react' },
      context: { app: { version: '2.1', build: 'react-abc123' } },
      reporter: { user: { id: 'react-user' } },
      payload: {
        crash: {
          handled: true,
          fatal: false,
          mechanism: 'captureException',
          causeChain: {
            causes: [{ exceptionType: 'TypeError', message: 'payment root' }],
            truncated: false,
          },
          details: {
            severity: 'warning',
            context: 'hook checkout',
            metadata: { accessToken: '[REDACTED]' },
          },
        },
      },
    });
    expect([...events.values()][0]!.payload.breadcrumbs?.some(b => b.message === 'React checkout opened')).toBe(true);
    captureException(errorAt('topLevel'), { severity: 'info', context: 'top-level checkout' });
    await vi.waitFor(() => expect(events.size).toBe(2));
    expect([...events.values()][1]!.payload.crash!.frames[0]!.raw).toContain('topLevel');
    expect([...events.values()][1]!.payload.crash!.details).toEqual({
      severity: 'info',
      context: 'top-level checkout',
    });
    result.current.captureException(errorAt('legacyOneArgument'));
    await vi.waitFor(() => expect(events.size).toBe(3));
    expect([...events.values()][2]!.payload.crash!.details).toEqual({ severity: 'error' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps pre-mount, unmounted, and stale hook captures inert across remounts', async () => {
    expect(() => captureException(errorAt('beforeMount'))).not.toThrow();
    const first = renderHook(() => useEverframe(), { wrapper });
    const stale = first.result.current;
    first.unmount();
    expect(() => captureException(errorAt('afterUnmount'))).not.toThrow();
    renderHook(() => useEverframe(), { wrapper });
    stale.captureException(errorAt('staleHook'));
    captureException(errorAt('liveMount'));
    await vi.waitFor(() => expect(events.size).toBe(1));
    expect([...events.values()][0]!.payload.crash!.frames[0]!.raw).toContain('liveMount');
  });

  it('does not report through either API after kill', async () => {
    const first = renderHook(() => useEverframe(), { wrapper });
    first.result.current.kill();
    first.result.current.captureException(errorAt('killedHook'));
    captureException(errorAt('killedTopLevel'));
    first.unmount();
    renderHook(() => useEverframe(), { wrapper });
    captureException(errorAt('newMount'));
    await vi.waitFor(() => expect(events.size).toBe(1));
    expect([...events.values()][0]!.payload.crash!.frames[0]!.raw).toContain('newMount');
  });

  it('does not persist a capture when option proxy work unmounts its provider', async () => {
    const mounted = renderHook(() => useEverframe(), { wrapper });
    const options = new Proxy({}, {
      getPrototypeOf() {
        mounted.unmount();
        return Object.prototype;
      },
    });

    expect(() => mounted.result.current.captureException(errorAt('unmountedDuringOptions'), options)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events.size).toBe(0);

    renderHook(() => useEverframe(), { wrapper });
    captureException(errorAt('liveAfterOptionUnmount'));
    await vi.waitFor(() => expect(events.size).toBe(1));
    expect([...events.values()][0]!.payload.crash!.frames[0]!.raw).toContain('liveAfterOptionUnmount');
  });

  it('invalidates cause prototype work at unmount and accepts a remounted successor', async () => {
    const mounted = renderHook(() => useEverframe(), { wrapper });
    let prototypeReads = 0;
    const prototype = new Proxy(Object.create(null) as object, {
      getPrototypeOf(target) {
        prototypeReads += 1;
        mounted.unmount();
        return Reflect.getPrototypeOf(target);
      },
    });
    const inner = Object.create(prototype) as object;
    Object.defineProperty(inner, 'message', { value: 'unmounting cause' });
    Object.defineProperty(inner, 'stack', { value: 'Error: unmounting cause' });

    expect(() => mounted.result.current.captureException(errorAtWithCause('staleCause', inner)))
      .not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(prototypeReads).toBe(1);
    expect(events.size).toBe(0);

    renderHook(() => useEverframe(), { wrapper });
    captureException(errorAt('liveAfterCauseUnmount'));
    await vi.waitFor(() => expect(events.size).toBe(1));
    expect([...events.values()][0]!.payload.crash!.frames[0]!.raw)
      .toContain('liveAfterCauseUnmount');
    if (process.env['EVERFRAME_TASK3_RECEIPTS'] === '1') {
      console.log(`TASK3_REACT_OWNERSHIP_RECEIPT ${JSON.stringify({
        staleSent: 0,
        prototypeReads,
        acceptedSuccessor: [...events.values()][0]!.payload.crash!.frames[0]!.raw,
      })}`);
    }
  });

  it('invalidates native cause formatting at unmount and accepts a remounted successor', async () => {
    const mounted = renderHook(() => useEverframe(), { wrapper });
    const errorConstructor = Error as ErrorConstructor & {
      prepareStackTrace?: (error: Error, frames: unknown[]) => unknown;
    };
    const previousFormatter = Object.getOwnPropertyDescriptor(errorConstructor, 'prepareStackTrace');
    let formatterCalls = 0;
    Object.defineProperty(errorConstructor, 'prepareStackTrace', {
      configurable: true,
      value: () => {
        formatterCalls += 1;
        mounted.unmount();
        return 'TypeError: unmounting native cause\n    at stale (stale.js:1:1)';
      },
      writable: true,
    });
    const inner = new TypeError('unmounting native cause');
    const outer = errorAtWithCause('staleNativeCause', inner);
    Object.defineProperty(outer, 'stack', {
      configurable: true,
      value: 'Error: checkout failed\n    at staleNativeCause (app.js:1:250)',
    });

    try {
      expect(() => mounted.result.current.captureException(outer)).not.toThrow();
    } finally {
      if (previousFormatter) {
        Object.defineProperty(errorConstructor, 'prepareStackTrace', previousFormatter);
      } else {
        Reflect.deleteProperty(errorConstructor, 'prepareStackTrace');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(formatterCalls).toBe(1);
    expect(events.size).toBe(0);

    renderHook(() => useEverframe(), { wrapper });
    captureException(errorAt('liveAfterNativeFormatterUnmount'));
    await vi.waitFor(() => expect(events.size).toBe(1));
    expect([...events.values()][0]!.payload.crash!.frames[0]!.raw)
      .toContain('liveAfterNativeFormatterUnmount');
    if (process.env['EVERFRAME_TASK3_RECEIPTS'] === '1') {
      console.log(`TASK3_REACT_FORMATTER_OWNERSHIP_RECEIPT ${JSON.stringify({
        staleSent: 0,
        formatterCalls,
        acceptedSuccessor: [...events.values()][0]!.payload.crash!.frames[0]!.raw,
      })}`);
    }
  });
});
