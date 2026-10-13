// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// A component that throws while rendering, with no error boundary of the
// host's around it. React (18 and 19, createRoot) unmounts the whole root,
// EverframeProvider included, in the same commit that reports the error to
// the page, and that unmount used to discard the report while it was being
// saved. The report must arrive: as a fatal crash, carrying React's
// component stack, and without the host adding an error boundary.
//
// No act(): React's act() scope captures uncaught errors itself and rethrows
// them from act, so the page-level path a real browser takes would never run.
// The trigger comes from a timer and an external store, outside any React
// event, as an app's crash would. tests/render-error-browser.mjs runs the
// same cases in Chromium.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Component, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReportEnvelope } from '@everframe/protocol';
import { EverframeProvider } from '../src/provider.js';
import { useEverframe } from '../src/index.js';

let delivered: ReportEnvelope[];
let ingestAttempts: number;
let pageErrors: unknown[];
let root: Root | undefined;
let container: HTMLDivElement;

const recordPageError = (event: ErrorEvent): void => {
  pageErrors.push(event.error);
  // A browser runs `window.onerror` for this event (React reports through
  // `reportError`, or dispatches an ErrorEvent where that is missing). Under
  // vitest, `window.onerror` is set on Node's global, not on jsdom's window,
  // so jsdom never calls it. Do what the browser does.
  window.onerror?.(event.message, event.filename, event.lineno, event.colno, event.error);
};

beforeEach(() => {
  localStorage.clear();
  delivered = [];
  ingestAttempts = 0;
  pageErrors = [];
  armed = false;
  // A page-level listener of the host's own, which also tells vitest's jsdom
  // environment the uncaught error below is expected.
  window.addEventListener('error', recordPageError);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, options?: RequestInit) => {
      if (String(url).endsWith('/api/ingest')) {
        ingestAttempts += 1;
        const part = (options!.body as FormData).get('envelope') as Blob;
        delivered.push(ReportEnvelope.parse(JSON.parse(await part.text())));
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  root?.unmount();
  root = undefined;
  container.remove();
  window.removeEventListener('error', recordPageError);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

// An external store the test flips from outside React.
let armed = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function arm(): void {
  armed = true;
  for (const listener of listeners) listener();
}

function ExplodingRow(): ReactNode {
  const error = new Error('smoke js-render: ExplodingRow');
  error.stack =
    'Error: smoke js-render: ExplodingRow\n    at ExplodingRow (https://app.example/index.js:1:1234)';
  throw error;
}

function CrashHost() {
  const explode = useSyncExternalStore(
    subscribe,
    () => armed,
    () => armed,
  );
  return explode ? (
    <section>
      <ExplodingRow />
    </section>
  ) : (
    <p>ready</p>
  );
}

class HostBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <p>fallback</p> : this.props.children;
  }
}

let hostKill: (() => void) | undefined;
function KillSwitch() {
  hostKill = useEverframe().kill;
  return null;
}

function mount(children: ReactNode): void {
  root = createRoot(container);
  root.render(
    <EverframeProvider config={{ sdkKey: 'pk_test', appName: 'demo', appVersion: '1.0.0' }}>
      {children}
    </EverframeProvider>,
  );
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function mounted(): Promise<void> {
  await vi.waitFor(() => expect(container.textContent).toContain('ready'));
  await tick(20); // the provider's mount effects
}

describe('an error no boundary catches while rendering', () => {
  it('is reported as a fatal crash with the component stack', async () => {
    mount(<CrashHost />);
    await mounted();

    setTimeout(arm, 0);

    // React unmounted the root and reported the error to the page, as before.
    await vi.waitFor(() => expect(pageErrors).toHaveLength(1));
    expect(container.innerHTML).toBe('');
    expect((pageErrors[0] as Error).message).toBe('smoke js-render: ExplodingRow');

    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    const [envelope] = delivered;
    expect(envelope!.source).toBe('crash');
    expect(envelope!.reporter.title).toBe('Error: smoke js-render: ExplodingRow');
    expect(envelope!.payload.crash).toMatchObject({
      exceptionType: 'Error',
      mechanism: 'onerror',
      handled: false,
      fatal: true,
      frames: [{ raw: 'at ExplodingRow (https://app.example/index.js:1:1234)' }],
    });
    const message = envelope!.payload.crash!.message;
    expect(message.startsWith('smoke js-render: ExplodingRow\n\nThis error is located at:\n')).toBe(
      true,
    );
    const componentStack = message
      .split('This error is located at:')[1]!
      .split('\n')
      .filter(Boolean);
    expect(componentStack[0]).toMatch(/^\s+at ExplodingRow\b/);
    expect(componentStack.some((line) => /^\s+at CrashHost\b/.test(line))).toBe(true);

    // Delivered once: the page-level report of the same error is not a second one.
    await tick(60);
    expect(ingestAttempts).toBe(1);
    expect(await outboxSize()).toBe(0);
  });

  it('is still reported when the error happens in the render that mounts the provider', async () => {
    armed = true;
    mount(<CrashHost />);

    await vi.waitFor(() => expect(pageErrors).toHaveLength(1));
    await vi.waitFor(() => expect(delivered.length).toBeGreaterThan(0));
    await tick(60);
    // The provider's mount-time outbox drain can overlap the crash's own and
    // send the same queued report again; the server keeps one per report ID.
    expect(new Set(delivered.map((envelope) => envelope.reportId)).size).toBe(1);
    expect(delivered[0]!.source).toBe('crash');
    expect(delivered[0]!.payload.crash).toMatchObject({ fatal: true, handled: false });
    expect(delivered[0]!.payload.crash!.message).toContain('This error is located at:');
    expect(await outboxSize()).toBe(0);
  });

  it('stays with a host boundary inside the provider, which handles it', async () => {
    mount(
      <HostBoundary>
        <CrashHost />
      </HostBoundary>,
    );
    await mounted();

    setTimeout(arm, 0);
    await vi.waitFor(() => expect(container.textContent).toContain('fallback'));
    await tick(60);

    expect(pageErrors).toEqual([]);
    expect(ingestAttempts).toBe(0);
  });

  it('sends nothing after the host withdrew consent with kill()', async () => {
    mount(
      <>
        <KillSwitch />
        <CrashHost />
      </>,
    );
    await mounted();
    hostKill!();

    setTimeout(arm, 0);
    await vi.waitFor(() => expect(pageErrors).toHaveLength(1));
    await tick(60);

    expect(ingestAttempts).toBe(0);
    expect(await outboxSize()).toBe(0);
  });
});

async function outboxSize(): Promise<number> {
  // The crash outbox is origin-wide localStorage, one `everframe:outbox:<reportId>` key per report.
  return Object.keys(localStorage).filter((key) => key.startsWith('everframe:outbox:')).length;
}
