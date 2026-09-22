// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('react-konva', () => ({
  Stage: ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
    <div data-testid="konva-stage" {...rest}>
      {children}
    </div>
  ),
  Layer: ({ children }: { children?: ReactNode }) => (
    <div data-testid="konva-layer">{children}</div>
  ),
  Line: () => <div data-testid="konva-line" />,
  Rect: () => <div data-testid="konva-rect" />,
  Image: () => <div data-testid="konva-image" />,
  // Arrow added in the reporter overhaul (Phase 06.3) — mock it or
  // AnnotateCanvas crashes at lazy-load with "No 'Arrow' export defined".
  Arrow: () => <div data-testid="konva-arrow" />,
  // Text + Group added for the Select-tool diagnostic label (Android parity).
  Text: () => <div data-testid="konva-text" />,
  Group: ({ children }: { children?: ReactNode }) => (
    <div data-testid="konva-group">{children}</div>
  ),
  Ellipse: () => <div data-testid="konva-ellipse" />,
  Circle: () => <div data-testid="konva-circle" />,
  Transformer: () => <div data-testid="konva-transformer" />,
}));

import {
  AnnotateCanvas,
  PEN_COLORS,
  PEN_THICKNESSES,
} from '../../src/reporter-ui/AnnotateCanvas.js';

afterEach(() => cleanup());

describe('<AnnotateCanvas>', () => {
  it('exports 5 pen colors matching native palette and 3 thicknesses (UI-SPEC lock)', () => {
    // Aligned with the Android/iOS reporter ColorPickerPalette
    // (FocusedAnnotation.kt / FocusedAnnotationViewController.swift) —
    // Red, Yellow, Cyan, White, Black. Was a 6-color web-only palette;
    // dropped one to match the cross-platform reporter contract.
    expect(PEN_COLORS).toHaveLength(5);
    expect(PEN_COLORS).toContain('#000000');
    expect(PEN_COLORS).toContain('#FFFFFF');
    expect(PEN_COLORS).toContain('#FF3B30'); // .systemRed
    expect(PEN_COLORS).toContain('#FFCC00'); // .systemYellow
    expect(PEN_COLORS).toContain('#32ADE6'); // .systemCyan
    expect(PEN_THICKNESSES).toEqual([2, 4, 8]);
  });

  it('lazy-loads react-konva on mount; renders Stage once ready', async () => {
    const blob = new Blob([new Uint8Array([0, 1])], { type: 'image/png' });
    const { findByTestId } = render(
      <AnnotateCanvas imageBlob={blob} onChange={() => undefined} />,
    );
    await waitFor(async () => {
      const stage = await findByTestId('annotate-canvas-stage');
      expect(stage).toBeInTheDocument();
    });
  });
});

describe('<AnnotateCanvas> — overhaul toolbar', () => {
  const blob = new Blob([new Uint8Array([0, 1])], { type: 'image/png' });

  it('renders highlighter, rect, and ellipse tool buttons', async () => {
    const { findByTestId } = render(
      <AnnotateCanvas imageBlob={blob} onChange={() => undefined} />,
    );
    expect(await findByTestId('tool-highlighter')).toBeInTheDocument();
    expect(await findByTestId('tool-rect')).toBeInTheDocument();
    expect(await findByTestId('tool-ellipse')).toBeInTheDocument();
  });

  it('activating a shape tool marks its button active and shows the style row', async () => {
    const { findByTestId } = render(
      <AnnotateCanvas imageBlob={blob} onChange={() => undefined} />,
    );
    const rectBtn = await findByTestId('tool-rect');
    fireEvent.click(rectBtn);
    expect(rectBtn.className).toContain('txx-tool-btn-active');
    // Style row is present for stroke-styled tools.
    expect(await findByTestId('style-row')).toBeInTheDocument();
  });

  it('undo/redo start disabled with no history', async () => {
    const { findByTestId } = render(
      <AnnotateCanvas imageBlob={blob} onChange={() => undefined} />,
    );
    expect(await findByTestId('tool-undo')).toBeDisabled();
    expect(await findByTestId('tool-redo')).toBeDisabled();
  });

  it('seeds from initialAnnotations (id-based) and reports them via onChange', async () => {
    const seeded = [
      { id: 'seed1', kind: 'rect', x: 1, y: 1, width: 5, height: 5, color: '#FF3B30', thickness: 4 },
    ] as const;
    const onChange = vi.fn();
    render(
      <AnnotateCanvas
        imageBlob={blob}
        onChange={onChange}
        initialAnnotations={seeded as unknown as Parameters<typeof AnnotateCanvas>[0]['initialAnnotations']}
      />,
    );
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 'seed1', kind: 'rect' })]),
      );
    });
  });
});

describe('<AnnotateCanvas> — selection editing', () => {
  const blob = new Blob([new Uint8Array([0, 1])], { type: 'image/png' });

  it('renders pointer tool first and a delete button disabled without selection', async () => {
    const { findByTestId } = render(
      <AnnotateCanvas imageBlob={blob} onChange={() => undefined} />,
    );
    const pointer = await findByTestId('tool-pointer');
    expect(pointer).toBeInTheDocument();
    const del = await findByTestId('tool-delete');
    expect(del).toBeDisabled();
  });

  it('does not render a Transformer when nothing is selected', async () => {
    const { findByTestId, queryByTestId } = render(
      <AnnotateCanvas imageBlob={blob} onChange={() => undefined} />,
    );
    await findByTestId('annotate-canvas-stage');
    expect(queryByTestId('konva-transformer')).toBeNull();
  });

  it('switching to the pointer tool marks it active', async () => {
    const { findByTestId } = render(
      <AnnotateCanvas imageBlob={blob} onChange={() => undefined} />,
    );
    const pointer = await findByTestId('tool-pointer');
    fireEvent.click(pointer);
    expect(pointer.className).toContain('txx-tool-btn-active');
  });
});

describe('<AnnotateCanvas> — text tool', () => {
  const blob = new Blob([new Uint8Array([0, 1])], { type: 'image/png' });

  it('renders a text tool button that activates the tool', async () => {
    const { findByTestId } = render(
      <AnnotateCanvas imageBlob={blob} onChange={() => undefined} />,
    );
    const btn = await findByTestId('tool-text');
    fireEvent.click(btn);
    expect(btn.className).toContain('txx-tool-btn-active');
  });

  it('shows font-size steps (not thickness) in the style row for the text tool', async () => {
    const { findByTestId, queryByLabelText } = render(
      <AnnotateCanvas imageBlob={blob} onChange={() => undefined} />,
    );
    fireEvent.click(await findByTestId('tool-text'));
    expect(await findByTestId('fontsize-16')).toBeInTheDocument();
    expect(await findByTestId('fontsize-24')).toBeInTheDocument();
    expect(await findByTestId('fontsize-36')).toBeInTheDocument();
    expect(queryByLabelText('Thickness: 2px')).toBeNull();
  });
});

describe('<AnnotateCanvas> — small-crop upscaling', () => {
  it('upscales a tiny image up to the ×4 cap instead of rendering it at natural size', async () => {
    // jsdom never fires the <img> onload for blob URLs, so imgDims falls back
    // to the 1×1 microtask default (see the queueMicrotask fallback in
    // AnnotateCanvas). containerWidth defaults to `maxWidth` (1024) because
    // jsdom's ResizeObserver measurement reports clientWidth 0, which the
    // effect ignores. So scale = min(1024 / 1, MAX_UPSCALE) = 4, and the
    // Stage mock (which spreads props onto a div) should render width="4".
    const blob = new Blob([new Uint8Array([0, 1])], { type: 'image/png' });
    const { findByTestId } = render(
      <AnnotateCanvas imageBlob={blob} onChange={() => undefined} />,
    );
    const stage = await findByTestId('konva-stage');
    await waitFor(() => {
      expect(stage.getAttribute('width')).toBe('4');
      expect(stage.getAttribute('height')).toBe('4');
    });
  });
});
