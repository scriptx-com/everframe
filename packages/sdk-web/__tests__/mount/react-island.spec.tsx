// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// The island itself, mounted for real. Everywhere else in __tests__/mount/ it
// is stubbed (so lifecycle specs do not pull React in), which leaves exactly
// one thing uncovered and it is the subtle one: `createRoot().render()` is
// ASYNC, and the very first `setOpen(true)` always arrives before the root has
// committed — the dynamic import that produced this module was started BY that
// open. Without the pending queue the first open is silently swallowed and the
// reporter never appears, on the only path a vanilla host ever takes.
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { waitFor } from '@testing-library/react';

// react-konva is a WebGL/canvas renderer; the annotate layer only needs to
// mount for the dialog to render. Same stub the ReporterDialog spec uses.
vi.mock('react-konva', () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Stage: Box,
    Layer: Box,
    Group: Box,
    Line: () => <div />,
    Rect: () => <div />,
    Image: () => <div />,
    Arrow: () => <div />,
    Ellipse: () => <div />,
    Circle: () => <div />,
    Transformer: () => <div />,
    Text: () => <div />,
  };
});

import { mountIsland } from '../../src/mount/react-island.js';
import { __setPortalTarget } from '../../src/reporter-ui/portal-target.js';
import type { WebPlatformAdapter } from '../../src/adapter.js';
import type { TraceItXClient } from '@traceitx/sdk-core';

/** The inert public threads facade — the shape sdk-core hands a host with no threads. */
function mockThreads(
  overrides: Partial<TraceItXClient['threads']> = {},
): TraceItXClient['threads'] {
  return {
    list: () => [],
    get: async () => null,
    reply: async () => undefined,
    retryMessage: async () => undefined,
    markRead: async () => undefined,
    delete: async () => true,
    unreadCount: () => 0,
    getState: () => ({
      enabled: true,
      readOnly: false,
      threads: [],
      unreadCount: 0,
      pending: [],
      cooldownUntilMs: null,
    }),
    subscribe: () => () => undefined,
    refresh: async () => undefined,
    ...overrides,
  };
}

function mockAdapter(): WebPlatformAdapter {
  const base: Partial<WebPlatformAdapter> = {
    captureScreenshot: async () => ({
      blob: new Blob(['x'], { type: 'image/png' }),
      width: window.innerWidth,
      height: window.innerHeight,
      sha256: 'a'.repeat(64),
    }),
    captureFocusedNode: () => null,
    captureRecentLogs: () => [],
    captureRecentNetwork: () => [],
    getDeviceMetadata: () => ({
      os: 'macOS',
      osVersion: '14.0',
      screenSize: { width: 1920, height: 1080 },
      pixelRatio: 2,
      locale: 'en-US',
      timezone: 'UTC',
    }),
    registerTrigger: () => () => undefined,
    showReporterUI: async () => null,
    resolveSensitiveRects: () => [],
    applyMaskPlan: async (b: Blob) => b,
    __openReporter: () => Promise.resolve({ status: 'cancelled' as const }),
    __resolveReporterUI: () => undefined,
    __resolveOpen: () => undefined,
    __registerShowModal: () => undefined,
    __registerOutboxDrainTrigger: () => undefined,
    __captureIdentityAtSubmitBoundary: async () => null,
    __captureUserAtSubmitBoundary: () => null,
  };
  Object.defineProperty(base, '__lastDegradedReason', {
    get: () => undefined,
    enumerable: false,
    configurable: true,
  });
  return base as WebPlatformAdapter;
}

let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
  __setPortalTarget(null);
  document.body.innerHTML = '';
});

function makeShadow(): ShadowRoot {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  // The dialog portals to the registered target; init() points it at the same
  // shadow root, so do that here too or nothing renders inside it.
  __setPortalTarget(shadow);
  return shadow;
}

describe('mountIsland', () => {
  it('renders nothing until it is opened', async () => {
    const shadow = makeShadow();
    const island = mountIsland(shadow, mockAdapter(), {
      threads: mockThreads(),
      onComplete: () => undefined,
      onCancel: () => undefined,
      onNewReport: () => undefined,
    });
    teardown = () => island.unmount();
    await new Promise((r) => setTimeout(r, 20));
    expect(shadow.querySelector('[data-testid=reporter-modal]')).toBeNull();
  });

  it('honours a setOpen(true) that lands BEFORE the root commits', async () => {
    const shadow = makeShadow();
    const island = mountIsland(shadow, mockAdapter(), {
      threads: mockThreads(),
      onComplete: () => undefined,
      onCancel: () => undefined,
      onNewReport: () => undefined,
    });
    teardown = () => island.unmount();
    // Synchronously, in the same tick as the mount — the real first-open race.
    island.setOpen(true);
    await waitFor(() =>
      expect(shadow.querySelector('[data-testid=reporter-modal]')).not.toBeNull(),
    );
  });

  it('renders no inbox and no toast until told to', async () => {
    const shadow = makeShadow();
    const island = mountIsland(shadow, mockAdapter(), {
      threads: mockThreads(),
      onComplete: () => undefined,
      onCancel: () => undefined,
      onNewReport: () => undefined,
    });
    teardown = () => island.unmount();
    await new Promise((r) => setTimeout(r, 20));
    expect(shadow.textContent).not.toContain('Your reports');
    expect(shadow.textContent).not.toContain('Report sent');
  });

  it('opens the replies inbox — what the ambient FAB routes to (finding 2)', async () => {
    const shadow = makeShadow();
    const island = mountIsland(shadow, mockAdapter(), {
      threads: mockThreads(),
      onComplete: () => undefined,
      onCancel: () => undefined,
      onNewReport: () => undefined,
    });
    teardown = () => island.unmount();
    island.setInboxOpen(true);
    await waitFor(() => expect(shadow.textContent).toContain('Your reports'));
    // …and it is the inbox, not the report form.
    expect(shadow.querySelector('[data-testid=reporter-modal]')).toBeNull();
  });

  it("hands 'New report' from inside the inbox back to the host's openModal", async () => {
    const shadow = makeShadow();
    const onNewReport = vi.fn();
    const island = mountIsland(shadow, mockAdapter(), {
      threads: mockThreads(),
      onComplete: () => undefined,
      onCancel: () => undefined,
      onNewReport,
    });
    teardown = () => island.unmount();
    island.setInboxOpen(true);
    const button = await waitFor(() => {
      const el = Array.from(shadow.querySelectorAll('button')).find(
        (b) => b.textContent === 'New report',
      );
      expect(el).toBeTruthy();
      return el as HTMLButtonElement;
    });
    button.click();
    expect(onNewReport).toHaveBeenCalledOnce();
    // The inbox closes itself; the host decides what opens next (openModal,
    // which freezes first — see inbox-and-toast.spec.ts).
    await waitFor(() => expect(shadow.textContent).not.toContain('Your reports'));
  });

  it('renders the outcome toast (finding 3)', async () => {
    const shadow = makeShadow();
    const island = mountIsland(shadow, mockAdapter(), {
      threads: mockThreads(),
      onComplete: () => undefined,
      onCancel: () => undefined,
      onNewReport: () => undefined,
    });
    teardown = () => island.unmount();
    island.toast('success', 'Report sent');
    await waitFor(() => expect(shadow.textContent).toContain('Report sent'));
  });

  it('queues an inbox open and a toast that land BEFORE the root commits', async () => {
    const shadow = makeShadow();
    const island = mountIsland(shadow, mockAdapter(), {
      threads: mockThreads(),
      onComplete: () => undefined,
      onCancel: () => undefined,
      onNewReport: () => undefined,
    });
    teardown = () => island.unmount();
    // Synchronously, in the same tick as the mount — the real FAB-click race.
    island.setInboxOpen(true);
    island.toast('error', "Couldn't send report. Check your SDK key configuration.");
    await waitFor(() => {
      expect(shadow.textContent).toContain('Your reports');
      expect(shadow.textContent).toContain("Couldn't send report");
    });
  });

  it('unmount() removes its container from the shadow root', async () => {
    const shadow = makeShadow();
    const island = mountIsland(shadow, mockAdapter(), {
      threads: mockThreads(),
      onComplete: () => undefined,
      onCancel: () => undefined,
      onNewReport: () => undefined,
    });
    island.setOpen(true);
    await waitFor(() =>
      expect(shadow.querySelector('[data-testid=reporter-modal]')).not.toBeNull(),
    );
    island.unmount();
    await waitFor(() => expect(shadow.childElementCount).toBe(0));
  });
});
