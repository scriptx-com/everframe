// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, fireEvent, waitFor, act } from '@testing-library/react';

// Konva Stage events carry `e.target.getStage().getRelativePointerPosition()`,
// not a native DOM event shape. The mock below translates a fired native
// PointerEvent's clientX/clientY into a Konva-shaped fake event so the
// annotation gestures under test see the shape the real Stage would hand
// them.
function fakeKonvaEvent(e: { clientX: number; clientY: number }): unknown {
  return {
    target: {
      getStage: () => ({
        getRelativePointerPosition: () => ({ x: e.clientX, y: e.clientY }),
      }),
    },
  };
}

vi.mock('react-konva', () => ({
  Stage: ({
    children,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    ...rest
  }: {
    children?: ReactNode;
    onPointerDown?: (e: unknown) => void;
    onPointerMove?: (e: unknown) => void;
    onPointerUp?: (e: unknown) => void;
  } & Record<string, unknown>) => (
    <div
      data-testid="konva-stage"
      onPointerDown={(e) => onPointerDown?.(fakeKonvaEvent(e))}
      onPointerMove={(e) => onPointerMove?.(fakeKonvaEvent(e))}
      onPointerUp={(e) => onPointerUp?.(fakeKonvaEvent(e))}
      {...rest}
    >
      {children}
    </div>
  ),
  Layer: ({ children }: { children?: ReactNode }) => (
    <div data-testid="konva-layer">{children}</div>
  ),
  Line: () => <div data-testid="konva-line" />,
  // Forward `data-testid` so a caller-supplied one isn't clobbered by the
  // generic fallback below.
  Rect: (props: Record<string, unknown>) => (
    <div data-testid="konva-rect" {...props} />
  ),
  Image: () => <div data-testid="konva-image" />,
  Arrow: () => <div data-testid="konva-arrow" />,
  Ellipse: () => <div data-testid="konva-ellipse" />,
  Circle: () => <div data-testid="konva-circle" />,
  Transformer: () => <div data-testid="konva-transformer" />,
  Text: () => <div data-testid="konva-text" />,
  Group: ({ children }: { children?: ReactNode }) => (
    <div data-testid="konva-group">{children}</div>
  ),
}));

vi.mock('../../src/reporter-ui/crop-blob.js', () => ({
  cropBlob: vi.fn(async () => ({
    blob: new Blob(['c'], { type: 'image/png' }),
    width: 10,
    height: 10,
  })),
}));

import { ReporterDialog } from '../../src/reporter-ui/ReporterDialog.js';
import { cropBlob } from '../../src/reporter-ui/crop-blob.js';
import { __setBrandingServerConfig } from '../../src/branding/server-config.js';
import type { WebPlatformAdapter } from '../../src/adapter.js';

function buildMockAdapter(overrides: Partial<WebPlatformAdapter> = {}): WebPlatformAdapter {
  const base: Partial<WebPlatformAdapter> = {
    captureScreenshot: async () => ({
      blob: new Blob(['x'], { type: 'image/png' }),
      // Viewport-sized, like a real capture — the dialog derives the shot's
      // effective pixel ratio from width / innerWidth (codex round-2
      // finding 2), so an arbitrary size here would skew tap/annotation
      // coordinate mapping in every test using the default adapter.
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
      timezone: 'America/New_York',
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
    // PR review, round 5 (Serious) — `onSubmit` now captures identity at the
    // submit boundary via this adapter method before its own bake/hash prep;
    // every mock adapter needs it or the real function throws before ever
    // building the draft / calling `onComplete`.
    __captureIdentityAtSubmitBoundary: async () => null,
    // External review, finding 1 (Serious) — same story for the self-declared
    // user's submit-boundary capture, taken synchronously just before the
    // identity one.
    __captureUserAtSubmitBoundary: () => null,
  };
  Object.defineProperty(base, '__lastDegradedReason', {
    get: () => undefined,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(base, '__testCleanup', {
    value: () => undefined,
    enumerable: false,
    configurable: true,
  });
  return { ...base, ...overrides } as WebPlatformAdapter;
}

afterEach(() => cleanup());

describe('<ReporterDialog>', () => {
  it('renders modal with title input + description textarea + submit button', async () => {
    const adapter = buildMockAdapter();
    const onComplete = vi.fn();
    const { findByTestId } = render(
      <ReporterDialog
        open={true}
        adapter={adapter}
        onComplete={onComplete}
        onCancel={() => undefined}
      />,
    );
    await findByTestId('reporter-modal');
    expect(await findByTestId('report-title')).toBeInTheDocument();
    expect(await findByTestId('report-description')).toBeInTheDocument();
    expect(await findByTestId('submit-report')).toBeInTheDocument();
  });

  it('caps the title input at 200 chars', async () => {
    const { findByTestId } = render(
      <ReporterDialog
        open={true}
        adapter={buildMockAdapter()}
        onComplete={vi.fn()}
        onCancel={() => undefined}
      />,
    );
    expect(await findByTestId('report-title')).toHaveAttribute('maxlength', '200');
  });

  it('typing into description does not steal focus back to title (Modal effect stability)', async () => {
    // Regression: parent-recreated onClose closure was a useEffect dep on Modal, causing
    // the focus-on-mount effect to re-run on every keystroke and yank focus back to the
    // title field.
    const adapter = buildMockAdapter();
    const { findByTestId } = render(
      <ReporterDialog
        open={true}
        adapter={adapter}
        onComplete={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const description = (await findByTestId('report-description')) as HTMLTextAreaElement;
    await act(async () => {
      description.focus();
    });
    expect(document.activeElement).toBe(description);
    // Type one character into description — the Modal must not pull focus to the title input.
    await act(async () => {
      fireEvent.change(description, { target: { value: 'x' } });
    });
    expect(document.activeElement).toBe(description);
    // Type a second character — still on description.
    await act(async () => {
      fireEvent.change(description, { target: { value: 'xy' } });
    });
    expect(document.activeElement).toBe(description);
  });

  it('submit at idle is interactive (error helper text appears on empty-title submit)', async () => {
    const adapter = buildMockAdapter();
    const { findByTestId } = render(
      <ReporterDialog
        open={true}
        adapter={adapter}
        onComplete={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const submit = (await findByTestId('submit-report')) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it('shows error helper text when submit attempted with empty title', async () => {
    const adapter = buildMockAdapter();
    const { findByTestId, queryByText } = render(
      <ReporterDialog
        open={true}
        adapter={adapter}
        onComplete={vi.fn()}
        onCancel={() => undefined}
      />,
    );
    const submit = await findByTestId('submit-report');
    await act(async () => {
      fireEvent.click(submit);
    });
    await waitFor(() => expect(queryByText('Add a title before sending.')).toBeInTheDocument());
  });

  it('calls onComplete with title when submitted', async () => {
    const adapter = buildMockAdapter();
    const onComplete = vi.fn();
    const { findByTestId } = render(
      <ReporterDialog
        open={true}
        adapter={adapter}
        onComplete={onComplete}
        onCancel={() => undefined}
      />,
    );
    const titleInput = (await findByTestId('report-title')) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(titleInput, { target: { value: 'Bug found' } });
    });
    const submit = await findByTestId('submit-report');
    await act(async () => {
      fireEvent.click(submit);
    });
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    const draft = onComplete.mock.calls[0]![0];
    expect(draft.title).toBe('Bug found');
    expect(draft.excludedArtifacts).toEqual([]);
  });

  it('shows DiscardConfirmModal when Esc pressed on dirty form', async () => {
    const adapter = buildMockAdapter();
    const onCancel = vi.fn();
    const { findByTestId, queryByTestId } = render(
      <ReporterDialog
        open={true}
        adapter={adapter}
        onComplete={vi.fn()}
        onCancel={onCancel}
      />,
    );
    const titleInput = (await findByTestId('report-title')) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(titleInput, { target: { value: 'Dirty' } });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await waitFor(() => expect(queryByTestId('discard-confirm')).not.toBeNull());
  });

  it('Esc in the annotation overlay goes back to the modal instead of closing it', async () => {
    const adapter = buildMockAdapter();
    const onCancel = vi.fn();
    const { findByTestId, queryByTestId } = render(
      <ReporterDialog open={true} adapter={adapter} onComplete={vi.fn()} onCancel={onCancel} />,
    );
    // Open the fullscreen annotation overlay.
    const openBtn = await findByTestId('annotate-open');
    await act(async () => {
      fireEvent.click(openBtn);
    });
    await waitFor(() => expect(queryByTestId('annotate-overlay')).not.toBeNull());

    // Esc "goes back": overlay closes, reporter modal stays open, onCancel NOT called.
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await waitFor(() => expect(queryByTestId('annotate-overlay')).toBeNull());
    expect(queryByTestId('report-title')).not.toBeNull();
    expect(onCancel).not.toHaveBeenCalled();

    // A second Esc — now that the overlay is gone — closes the (pristine) modal.
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it('Esc on the reporter modal preventDefaults so the host app does not also handle it', async () => {
    const adapter = buildMockAdapter();
    const appEsc = vi.fn();
    window.addEventListener('keydown', appEsc);
    const { findByTestId } = render(
      <ReporterDialog open={true} adapter={adapter} onComplete={vi.fn()} onCancel={vi.fn()} />,
    );
    await findByTestId('report-title');
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(true);
    expect(appEsc).not.toHaveBeenCalled();
    window.removeEventListener('keydown', appEsc);
  });
});

describe('<ReporterDialog> — multi-screenshot strip', () => {
  it('renders one thumbnail + add tile after capture completes', async () => {
    const adapter = buildMockAdapter();
    const { findByTestId } = render(
      <ReporterDialog open adapter={adapter} onComplete={() => undefined} onCancel={() => undefined} />,
    );
    expect(await findByTestId('screenshot-strip')).toBeInTheDocument();
    expect(await findByTestId('screenshot-thumb-0')).toBeInTheDocument();
    expect(await findByTestId('screenshot-add')).toBeInTheDocument();
  });

  it('deleting the only (annotation-free) screenshot needs no confirm and shows the no-screenshot notice', async () => {
    const adapter = buildMockAdapter();
    const { findByTestId, findByText, queryByTestId } = render(
      <ReporterDialog open adapter={adapter} onComplete={() => undefined} onCancel={() => undefined} />,
    );
    fireEvent.click(await findByTestId('screenshot-delete-0'));
    expect(queryByTestId('delete-shot-confirm')).toBeNull();
    await waitFor(() => {
      expect(queryByTestId('screenshot-thumb-0')).toBeNull();
    });
    expect(
      await findByText(/Couldn't capture a screenshot|No screenshot attached/),
    ).toBeInTheDocument();
  });
});

describe('<ReporterDialog> — add screenshot flow', () => {
  it('add → overlay shows; full-page capture appends a second thumbnail', async () => {
    const adapter = buildMockAdapter();
    const { findByTestId } = render(
      <ReporterDialog open adapter={adapter} onComplete={() => undefined} onCancel={() => undefined} />,
    );
    fireEvent.click(await findByTestId('screenshot-add'));
    expect(await findByTestId('area-capture-overlay')).toBeInTheDocument();
    fireEvent.click(await findByTestId('area-capture-full'));
    expect(await findByTestId('screenshot-thumb-1')).toBeInTheDocument();
  });

  it('cancel returns to the modal without adding', async () => {
    const adapter = buildMockAdapter();
    const { findByTestId, queryByTestId } = render(
      <ReporterDialog open adapter={adapter} onComplete={() => undefined} onCancel={() => undefined} />,
    );
    fireEvent.click(await findByTestId('screenshot-add'));
    fireEvent.click(await findByTestId('area-capture-cancel'));
    await waitFor(() => expect(queryByTestId('area-capture-overlay')).toBeNull());
    expect(queryByTestId('screenshot-thumb-1')).toBeNull();
  });

  it('capture failure shows a notice and adds nothing (DEFE-02)', async () => {
    const adapter = buildMockAdapter({
      captureScreenshot: vi
        .fn()
        // First call (dialog-open capture) succeeds, second (add) fails.
        .mockResolvedValueOnce({
          blob: new Blob(['x'], { type: 'image/png' }),
          width: 100,
          height: 100,
          sha256: 'a'.repeat(64),
        })
        .mockRejectedValueOnce(new Error('boom')),
    });
    const { findByTestId, queryByTestId } = render(
      <ReporterDialog open adapter={adapter} onComplete={() => undefined} onCancel={() => undefined} />,
    );
    fireEvent.click(await findByTestId('screenshot-add'));
    fireEvent.click(await findByTestId('area-capture-full'));
    expect(await findByTestId('add-capture-error')).toBeInTheDocument();
    expect(queryByTestId('screenshot-thumb-1')).toBeNull();
  });

  it('drag-selection crops at viewport rect × dpr — scroll never enters the math', async () => {
    // Regression: adapter.captureScreenshot() output is VIEWPORT-anchored
    // (capture crops the PNG to the viewport), so the crop rect must be the
    // viewport-space selection scaled by devicePixelRatio only. The original
    // brief added window.scrollX/Y, which on a scrolled page pushed the crop
    // past the bitmap (throw) or onto the wrong region.
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    Object.defineProperty(window, 'scrollX', { value: 200, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 300, configurable: true });
    try {
      // Shot width = innerWidth × 2: the capture genuinely ran at ratio 2
      // (the ratio is derived from the shot, not read off the window).
      const adapter = buildMockAdapter({
        captureScreenshot: async () => ({
          blob: new Blob(['x'], { type: 'image/png' }),
          width: window.innerWidth * 2,
          height: window.innerHeight * 2,
          sha256: 'a'.repeat(64),
        }),
      });
      const { findByTestId } = render(
        <ReporterDialog open adapter={adapter} onComplete={() => undefined} onCancel={() => undefined} />,
      );
      fireEvent.click(await findByTestId('screenshot-add'));
      const overlay = await findByTestId('area-capture-overlay');
      fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 50, clientY: 60 });
      fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 150, clientY: 180 });
      fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 150, clientY: 180 });
      await waitFor(() => expect(cropBlob).toHaveBeenCalledTimes(1));
      expect(vi.mocked(cropBlob).mock.calls[0]![1]).toEqual({
        x: 50 * 2,
        y: 60 * 2,
        width: 100 * 2,
        height: 120 * 2,
      });
      // The cropped result lands in the strip as a new manual shot.
      expect(await findByTestId('screenshot-thumb-1')).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
      Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });
      Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    }
  });

  it('a capped capture crops at the EFFECTIVE ratio, not devicePixelRatio', async () => {
    // Codex round-2 finding 2: capture-profile.ts can lower the render ratio
    // below devicePixelRatio (TV 1080p cap, desktop 2560 cap). The crop rect
    // must scale by the ratio the capture actually ran at — derived from the
    // shot's own width / viewport width — or a capped capture crops the wrong
    // region and can retain content the user meant to exclude.
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    vi.mocked(cropBlob).mockClear();
    try {
      const adapter = buildMockAdapter({
        captureScreenshot: async () => ({
          blob: new Blob(['x'], { type: 'image/png' }),
          // Capped: the bitmap is exactly viewport-sized — effective ratio 1.
          width: window.innerWidth,
          height: window.innerHeight,
          sha256: 'a'.repeat(64),
        }),
      });
      const { findByTestId } = render(
        <ReporterDialog open adapter={adapter} onComplete={() => undefined} onCancel={() => undefined} />,
      );
      fireEvent.click(await findByTestId('screenshot-add'));
      const overlay = await findByTestId('area-capture-overlay');
      fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 50, clientY: 60 });
      fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 150, clientY: 180 });
      fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 150, clientY: 180 });
      await waitFor(() => expect(cropBlob).toHaveBeenCalledTimes(1));
      expect(vi.mocked(cropBlob).mock.calls[0]![1]).toEqual({
        x: 50,
        y: 60,
        width: 100,
        height: 120,
      });
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
    }
  });
});

describe('<ReporterDialog> — multi-shot submit payload', () => {
  it('ships bundle.screenshots with per-shot annotated flags and partName-tagged annotations', async () => {
    const adapter = buildMockAdapter();
    const onComplete = vi.fn();
    const { findByTestId } = render(
      <ReporterDialog open adapter={adapter} onComplete={onComplete} onCancel={() => undefined} />,
    );
    // Two shots: the auto capture + one full-page add.
    fireEvent.click(await findByTestId('screenshot-add'));
    fireEvent.click(await findByTestId('area-capture-full'));
    await findByTestId('screenshot-thumb-1');
    fireEvent.change(await findByTestId('report-title'), { target: { value: 'bug' } });
    fireEvent.click(await findByTestId('submit-report'));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    const payload = onComplete.mock.calls[0]![0] as {
      bundle: { screenshots?: Array<{ annotated: boolean }> };
      excludedArtifacts: string[];
    };
    expect(payload.bundle.screenshots).toHaveLength(2);
    expect(payload.bundle.screenshots![0]!.annotated).toBe(false);
    expect(payload.bundle.screenshots![1]!.annotated).toBe(false);
  });
});

describe('<ReporterDialog> — include card removed', () => {
  it('renders no include toggles and submits empty excludedArtifacts', async () => {
    const adapter = buildMockAdapter();
    const onComplete = vi.fn();
    const { findByTestId, queryByText } = render(
      <ReporterDialog open adapter={adapter} onComplete={onComplete} onCancel={() => undefined} />,
    );
    await findByTestId('screenshot-strip');
    expect(queryByText('UI tree')).toBeNull();
    expect(queryByText('Console logs')).toBeNull();
    expect(queryByText('Network')).toBeNull();
    expect(queryByText('Device metadata')).toBeNull();
    fireEvent.change(await findByTestId('report-title'), { target: { value: 'bug' } });
    fireEvent.click(await findByTestId('submit-report'));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(
      (onComplete.mock.calls[0]![0] as { excludedArtifacts: string[] }).excludedArtifacts,
    ).toEqual([]);
  });
});

describe('watermark (branding spec 2026-08-25)', () => {
  afterEach(() => __setBrandingServerConfig(undefined));

  function renderDialog() {
    return render(
      <ReporterDialog
        open={true}
        adapter={buildMockAdapter()}
        onComplete={() => undefined}
        onCancel={() => undefined}
      />,
    );
  }

  it('shows the watermark before any server config arrives (fail closed)', async () => {
    const { findByTestId } = renderDialog();
    const mark = await findByTestId('txx-watermark');
    expect(mark).toHaveAttribute('href', 'https://traceitx.com/?ref=powered-by');
    expect(mark).toHaveAttribute('target', '_blank');
    expect(mark).toHaveAttribute('rel', 'noopener noreferrer');
    expect(mark.textContent).toContain('Powered by TraceItX');
  });

  it('shows the watermark when the server says watermark: true (free plan)', async () => {
    __setBrandingServerConfig({ watermark: true });
    const { findByTestId } = renderDialog();
    expect(await findByTestId('txx-watermark')).toBeInTheDocument();
  });

  it('hides the watermark when the server confirms paid (watermark: false)', async () => {
    __setBrandingServerConfig({ watermark: false });
    const { findByTestId, queryByTestId } = renderDialog();
    await findByTestId('reporter-modal');
    expect(queryByTestId('txx-watermark')).toBeNull();
  });

  it('a config landing while the dialog is open updates it live (useSyncExternalStore)', async () => {
    const { findByTestId, queryByTestId } = renderDialog();
    await findByTestId('txx-watermark');
    act(() => __setBrandingServerConfig({ watermark: false }));
    expect(queryByTestId('txx-watermark')).toBeNull();
  });
});
