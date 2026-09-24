// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { useEffect, useState, type JSX } from 'react';
import type { Rect } from '@everframe/sdk-core';
import { pushEscapeHandler } from './primitives/escapeStack.js';

export interface AreaCaptureOverlayProps {
  /** rect = VIEWPORT-space CSS px (matches the viewport-anchored output of
   * adapter.captureScreenshot — capture/screenshot.ts crops the PNG to the
   * current viewport, so no scroll offsets belong here). null = visible viewport. */
  onSelect: (rect: Rect | null) => void;
  onCancel: () => void;
}

interface Drag {
  startX: number;
  startY: number;
  curX: number;
  curY: number;
}

/** Drags smaller than this (either edge, CSS px) are treated as stray clicks. */
const MIN_DRAG_EDGE = 8;

/**
 * AreaCaptureOverlay — fullscreen drag-to-select surface shown while the
 * reporter modal is hidden. Tagged data-everframe-skip-capture as defense in
 * depth (the overlay also unmounts before capture runs). Esc cancels via the
 * shared escapeStack so it composes with the modal's own Esc handling.
 */
export function AreaCaptureOverlay({ onSelect, onCancel }: AreaCaptureOverlayProps): JSX.Element {
  const [drag, setDrag] = useState<Drag | null>(null);

  useEffect(() => pushEscapeHandler(onCancel), [onCancel]);

  const sel = drag
    ? {
        x: Math.min(drag.startX, drag.curX),
        y: Math.min(drag.startY, drag.curY),
        width: Math.abs(drag.curX - drag.startX),
        height: Math.abs(drag.curY - drag.startY),
      }
    : null;

  return (
    <div
      className="everframe-area-capture"
      data-everframe-skip-capture="true"
      data-testid="area-capture-overlay"
      onPointerDown={(e) => {
        // Toolbar buttons handle their own clicks; only start drags on the surface.
        if ((e.target as HTMLElement).closest('.everframe-area-capture-bar')) return;
        // Stops the compatibility mousedown that anchors a native text
        // selection — see `.everframe-area-capture`'s own comment in reporter.css.ts
        // for why a selection here bleeds into the CUSTOMER's page. Paired
        // with `user-select: none` there rather than replacing it: neither
        // guard covers every engine alone, and this one ships into pages we
        // do not control.
        //
        // Deliberately AFTER the toolbar early-return, unlike the companion's
        // CropSurface: preventing the default here also suppresses focus, and
        // the bar holds two real <button>s that must still take focus when
        // clicked. The surface itself is not focusable, so it loses nothing.
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture?.(e.pointerId);
        } catch {
          /* jsdom / old browsers without pointer capture */
        }
        setDrag({ startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY });
      }}
      onPointerMove={(e) => {
        setDrag((d) => (d ? { ...d, curX: e.clientX, curY: e.clientY } : d));
      }}
      onPointerUp={() => {
        if (!sel) return;
        setDrag(null);
        if (sel.width < MIN_DRAG_EDGE || sel.height < MIN_DRAG_EDGE) return;
        // Viewport-space, AS-IS: the captured screenshot is viewport-anchored
        // (capture crops to the viewport), so adding scrollX/Y here would land
        // the crop wrong — or past the bitmap — on any scrolled page.
        onSelect({ x: sel.x, y: sel.y, width: sel.width, height: sel.height });
      }}
    >
      <div className="everframe-area-capture-bar">
        <span className="everframe-area-capture-hint">
          Drag to select an area — Esc to cancel
        </span>
        <button
          type="button"
          className="everframe-area-capture-btn"
          onClick={() => onSelect(null)}
          data-testid="area-capture-full"
        >
          Capture visible area
        </button>
        <button
          type="button"
          className="everframe-area-capture-btn"
          onClick={onCancel}
          data-testid="area-capture-cancel"
        >
          Cancel
        </button>
      </div>
      {sel && sel.width >= MIN_DRAG_EDGE && sel.height >= MIN_DRAG_EDGE ? (
        <div
          className="everframe-area-capture-selection"
          data-testid="area-capture-selection"
          style={{ left: sel.x, top: sel.y, width: sel.width, height: sel.height }}
        >
          <span className="everframe-area-capture-size">
            {Math.round(sel.width)} × {Math.round(sel.height)}
          </span>
        </div>
      ) : null}
    </div>
  );
}
