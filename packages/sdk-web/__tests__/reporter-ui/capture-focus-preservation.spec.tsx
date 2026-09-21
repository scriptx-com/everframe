// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
/**
 * The reporter used to blur the host page before it photographed it.
 *
 * Modal's on-open focus effect ran as a `queueMicrotask`, which lands between
 * ReporterDialog's effect body and the first `await` inside
 * `captureScreenshot` — so the clone walk (which copies each node's COMPUTED
 * style, focus ring included) always observed a page whose focused element had
 * just been blurred. Reported from the field as "the focus disappears when I
 * capture": most obvious on the hotkey trigger, where the user's focus is
 * otherwise still intact at the moment the reporter opens.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

import { ReporterDialog } from '../../src/reporter-ui/ReporterDialog.js';
import type { WebPlatformAdapter } from '../../src/adapter.js';

afterEach(() => cleanup());

function hostPageInput(): HTMLInputElement {
  const el = document.createElement('input');
  document.body.appendChild(el);
  el.focus();
  return el;
}

describe('capture preserves host-page focus', () => {
  it('the host page is still focused while the screenshot clones the DOM', async () => {
    const hostInput = hostPageInput();
    expect(document.activeElement).toBe(hostInput);

    const seen: (Element | null)[] = [];
    const adapter = {
      captureScreenshot: async () => {
        seen.push(document.activeElement);
        // modern-screenshot yields before it walks the DOM (the video
        // stand-in install, the dynamic import, its own resource pre-pass), so
        // the clone observes the DOM at least one microtask turn later than
        // the call. That turn is where the focus used to be lost.
        await Promise.resolve();
        seen.push(document.activeElement);
        return {
          blob: new Blob(['x'], { type: 'image/png' }),
          width: window.innerWidth,
          height: window.innerHeight,
          sha256: 'a'.repeat(64),
        };
      },
      captureFocusedNode: () => null,
      captureRecentLogs: () => [],
      captureRecentNetwork: () => [],
      getDeviceMetadata: () => null,
      resolveSensitiveRects: () => [],
      applyMaskPlan: async (b: Blob) => b,
    } as unknown as WebPlatformAdapter;

    render(
      <ReporterDialog
        open={true}
        adapter={adapter}
        onComplete={() => undefined}
        onCancel={() => undefined}
      />,
    );

    await waitFor(() => expect(seen.length).toBe(2));
    expect(seen[0]).toBe(hostInput);
    expect(seen[1]).toBe(hostInput);
  });

  it('focus moves into the dialog once the capture has sampled the page', async () => {
    hostPageInput();
    const adapter = {
      captureScreenshot: async () => {
        await Promise.resolve();
        return {
          blob: new Blob(['x'], { type: 'image/png' }),
          width: window.innerWidth,
          height: window.innerHeight,
          sha256: 'a'.repeat(64),
        };
      },
      captureFocusedNode: () => null,
      captureRecentLogs: () => [],
      captureRecentNetwork: () => [],
      getDeviceMetadata: () => null,
      resolveSensitiveRects: () => [],
      applyMaskPlan: async (b: Blob) => b,
    } as unknown as WebPlatformAdapter;

    const { findByTestId } = render(
      <ReporterDialog
        open={true}
        adapter={adapter}
        onComplete={() => undefined}
        onCancel={() => undefined}
      />,
    );

    const titleInput = await findByTestId('report-title');
    await waitFor(() => expect(document.activeElement).toBe(titleInput));
  });

  it('captureFocusedNode reads the host page, not the reporter itself', async () => {
    const hostInput = hostPageInput();
    let focusedAtRead: Element | null = null;
    const adapter = {
      captureScreenshot: async () => {
        await Promise.resolve();
        return {
          blob: new Blob(['x'], { type: 'image/png' }),
          width: window.innerWidth,
          height: window.innerHeight,
          sha256: 'a'.repeat(64),
        };
      },
      captureFocusedNode: () => {
        focusedAtRead = document.activeElement;
        return null;
      },
      captureRecentLogs: () => [],
      captureRecentNetwork: () => [],
      getDeviceMetadata: () => null,
      resolveSensitiveRects: () => [],
      applyMaskPlan: async (b: Blob) => b,
    } as unknown as WebPlatformAdapter;

    const { findByTestId } = render(
      <ReporterDialog
        open={true}
        adapter={adapter}
        onComplete={() => undefined}
        onCancel={() => undefined}
      />,
    );
    await findByTestId('report-title');
    await waitFor(() => expect(focusedAtRead).not.toBeNull());
    expect(focusedAtRead).toBe(hostInput);
  });

  it('a capture that never settles still hands the dialog its focus back', async () => {
    hostPageInput();
    const adapter = {
      captureScreenshot: () => new Promise<never>(() => undefined),
      captureFocusedNode: () => null,
      captureRecentLogs: () => [],
      captureRecentNetwork: () => [],
      getDeviceMetadata: () => null,
      resolveSensitiveRects: () => [],
      applyMaskPlan: async (b: Blob) => b,
    } as unknown as WebPlatformAdapter;

    const { findByTestId } = render(
      <ReporterDialog
        open={true}
        adapter={adapter}
        onComplete={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const titleInput = await findByTestId('report-title');
    // FOCUS_HOLD_CEILING_MS is 5s; real timers would make this a 5s spec, so
    // wait on the outcome with a bounded poll instead of faking the clock
    // (fake timers here would also stall React's own scheduling).
    await waitFor(() => expect(document.activeElement).toBe(titleInput), {
      timeout: 7_000,
      interval: 100,
    });
  }, 10_000);
});
