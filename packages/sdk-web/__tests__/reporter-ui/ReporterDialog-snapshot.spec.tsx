// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReporterDialog, submittedDegradedReason } from '../../src/reporter-ui/ReporterDialog.js';
import type { WebPlatformAdapter } from '../../src/adapter.js';
import type { ShotCapture } from '../../src/capture/shot-capture.js';

afterEach(cleanup);

const SNAP = { bytes: new Uint8Array([0x1f, 0x8b, 1]), sha256: 'e'.repeat(64), byteLength: 3 };
const RENDER = { platform: 'webos', viewport: { width: 1280, height: 720 }, dpr: 1, fontStatus: 'loaded' } as ShotCapture['render'];

/** `first` answers the open-time capture; every later capture answers `next`. */
function adapterWith(first: ShotCapture, next: ShotCapture = first): WebPlatformAdapter {
  const captureShot = vi.fn(async () => next).mockImplementationOnce(async () => first);
  return {
    captureScreenshot: vi.fn(async () => { throw new Error('unused on the TV path'); }),
    __captureShot: captureShot,
    captureFocusedNode: () => null,
    captureRecentLogs: () => [],
    captureRecentNetwork: () => [],
    getDeviceMetadata: () => ({ os: 'webOS', osVersion: '6', screenSize: { width: 1920, height: 1080 }, pixelRatio: 1, locale: 'en-US', timezone: 'UTC' }),
    __captureIdentityAtSubmitBoundary: async () => null,
    __captureUserAtSubmitBoundary: () => null,
  } as unknown as WebPlatformAdapter;
}

async function submit(): Promise<void> {
  fireEvent.change(await screen.findByTestId('report-title'), { target: { value: 'Broken rail' } });
  fireEvent.click(screen.getByTestId('submit-report'));
}

describe('ReporterDialog on the smart-TV snapshot path', () => {
  it('shows a snapshot-only shot as a non-annotatable placeholder and submits its dom-snapshot', async () => {
    const onComplete = vi.fn();
    render(<ReporterDialog open adapter={adapterWith({ snapshot: SNAP, render: RENDER, degradedReason: 'screenshot_render_failed' })} onComplete={onComplete} onCancel={() => {}} />);
    expect(await screen.findByTestId('snapshot-only-shot')).toHaveTextContent('Rendered from page snapshot');
    expect(screen.getByTestId('screenshot-thumb-snapshot-0')).toBeInTheDocument();
    expect(screen.queryByTestId('konva-stage')).toBeNull();
    await submit();
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    const { bundle, screenshotBlob } = onComplete.mock.calls[0]![0];
    expect(screenshotBlob).toBeNull();
    expect(bundle.screenshotBlob).toBeNull();
    expect(bundle.screenshots).toBeUndefined();
    expect(bundle.domSnapshots).toEqual([{ shotNumber: 1, bytes: SNAP.bytes, sha256: SNAP.sha256 }]);
    expect(bundle.render).toEqual(RENDER);
    expect(bundle.degradedReason).toBe('screenshot_render_failed');
  });

  it('an unavailable capture says so and submits screenshot_unavailable with no parts', async () => {
    const onComplete = vi.fn();
    render(<ReporterDialog open adapter={adapterWith({ degradedReason: 'screenshot_unavailable' })} onComplete={onComplete} onCancel={() => {}} />);
    expect(await screen.findByText(/Couldn.t capture a screenshot/)).toBeInTheDocument();
    await submit();
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    const { bundle } = onComplete.mock.calls[0]![0];
    expect(bundle.domSnapshots).toBeUndefined();
    expect(bundle.screenshotBlob).toBeNull();
    expect(bundle.degradedReason).toBe('screenshot_unavailable');
  });

  it('only the open-time capture asks for the pre-capture; an added shot is always fresh', async () => {
    const adapter = adapterWith({ snapshot: SNAP }, { snapshot: SNAP, degradedReason: 'screenshot_render_failed' });
    render(<ReporterDialog open adapter={adapter} onComplete={() => {}} onCancel={() => {}} />);
    await screen.findByTestId('snapshot-only-shot');
    fireEvent.click(await screen.findByTestId('screenshot-add'));
    fireEvent.click(await screen.findByTestId('area-capture-full'));
    // A full-view add whose render failed still adds its snapshot-only shot.
    expect(await screen.findByTestId('screenshot-thumb-snapshot-1')).toBeInTheDocument();
    const calls = vi.mocked(adapter.__captureShot!).mock.calls as unknown[][];
    expect(calls[0]).toEqual([{ consumePreCapture: true }]);
    expect(calls[1]).toEqual([]);
  });

  it('an area selection whose render failed adds nothing (a snapshot cannot be cropped)', async () => {
    const onComplete = vi.fn();
    const adapter = adapterWith({ snapshot: SNAP }, { snapshot: SNAP, degradedReason: 'screenshot_render_failed' });
    render(<ReporterDialog open adapter={adapter} onComplete={onComplete} onCancel={() => {}} />);
    fireEvent.click(await screen.findByTestId('screenshot-add'));
    const overlay = await screen.findByTestId('area-capture-overlay');
    fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 120, clientY: 120 });
    fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 120, clientY: 120 });
    expect(await screen.findByTestId('add-capture-error')).toHaveTextContent("Couldn't capture that screenshot. Nothing was added.");
    expect(screen.queryByTestId('screenshot-thumb-1')).toBeNull();
    await submit();
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    const { bundle } = onComplete.mock.calls[0]![0];
    // The failed add's reason never reaches the report; shot 1 keeps its snapshot.
    expect(bundle.degradedReason).toBeUndefined();
    expect(bundle.domSnapshots).toEqual([{ shotNumber: 1, bytes: SNAP.bytes, sha256: SNAP.sha256 }]);
  });

  it('ranks retained-shot reasons failed > unavailable > render_failed > blank', () => {
    expect(submittedDegradedReason([{ degradedReason: 'screenshot_blank' }, { degradedReason: 'screenshot_render_failed' }], undefined)).toBe('screenshot_render_failed');
    expect(submittedDegradedReason([{ degradedReason: 'screenshot_render_failed' }], 'screenshot_unavailable')).toBe('screenshot_render_failed');
    expect(submittedDegradedReason([{ degradedReason: 'screenshot_unavailable' }, { degradedReason: 'screenshot_failed' }], undefined)).toBe('screenshot_failed');
    expect(submittedDegradedReason([], 'csp_blocked')).toBe('csp_blocked');
  });
});
