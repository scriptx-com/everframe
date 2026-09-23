// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { Rect } from '@everframe/sdk-core';

// 5-color palette matching the Android Compose reporter's ColorPickerPalette
// (FocusedAnnotation.kt). Red leads the order — it's the most-used annotation
// color, so it stays the default. iOS uses the same five via UIColor system
// equivalents. (Moved here from AnnotateCanvas.tsx — single source of truth
// for the editor model; AnnotateCanvas re-exports for backwards compat.)
export const PEN_COLORS = [
  '#FF3B30', // Red    — .systemRed (iOS dynamic ≈ FF3B30)
  '#FFCC00', // Yellow — .systemYellow ≈ FFCC00
  '#32ADE6', // Cyan   — .systemCyan ≈ 32ADE6
  '#FFFFFF', // White
  '#000000', // Black
] as const;
export const PEN_THICKNESSES = [2, 4, 8] as const;

// Text sizing steps (S/M/L) in screenshot-pixel space. Rendered identically by
// the Konva Text node (preview) and BlurBakery's fillText (baked bytes) via the
// shared family + line-height constants below.
export const TEXT_FONT_SIZES = [16, 24, 36] as const;
export const TEXT_FONT_FAMILY = 'Helvetica, Arial, sans-serif';
export const TEXT_LINE_HEIGHT = 1.2;

// Highlighter renders as a wide semi-transparent stroke. Width multiplies the
// selected thickness so the 2/4/8 steps stay meaningful.
export const HIGHLIGHTER_OPACITY = 0.45;
export const HIGHLIGHTER_WIDTH_MULTIPLIER = 3;

export type AnnotationId = string;

let idSeq = 0;
/** Monotonic per-session annotation id — stable across renders, never reused. */
export function newAnnotationId(): AnnotationId {
  idSeq += 1;
  return `a${idSeq}`;
}

export interface PenStroke {
  id: AnnotationId;
  kind: 'pen';
  points: number[];
  color: string;
  thickness: number;
}
export interface HighlighterStroke {
  id: AnnotationId;
  kind: 'highlighter';
  points: number[];
  color: string;
  thickness: number;
}
export interface RectShape {
  id: AnnotationId;
  kind: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  thickness: number;
}
export interface EllipseShape {
  id: AnnotationId;
  kind: 'ellipse';
  // Bounding box (top-left + size) — Konva's center+radius shape is derived at
  // render/bake time so the box math matches rect exactly.
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  thickness: number;
}
export interface ArrowAnnotation {
  id: AnnotationId;
  kind: 'arrow';
  from: [number, number];
  to: [number, number];
  color: string;
  thickness: number;
}
export interface TextShape {
  id: AnnotationId;
  kind: 'text';
  x: number;
  y: number;
  text: string;
  color: string;
  fontSize: number;
}
export interface BlurRect extends Rect {
  id: AnnotationId;
  kind: 'blur';
}
export type Annotation =
  | PenStroke
  | HighlighterStroke
  | RectShape
  | EllipseShape
  | ArrowAnnotation
  | TextShape
  | BlurRect;

/** Kinds that carry color+thickness (everything except text and blur). */
export type StrokeStyledAnnotation =
  | PenStroke
  | HighlighterStroke
  | RectShape
  | EllipseShape
  | ArrowAnnotation;

// ---------------------------------------------------------------------------
// Snapshot undo/redo history. `past`/`future` hold full annotation-array
// snapshots (annotation objects are immutable — every edit replaces the
// object — so snapshots share structure and stay cheap).
// ---------------------------------------------------------------------------

export const HISTORY_CAP = 50;

export interface EditorHistory {
  past: ReadonlyArray<ReadonlyArray<Annotation>>;
  future: ReadonlyArray<ReadonlyArray<Annotation>>;
}

export const EMPTY_HISTORY: EditorHistory = { past: [], future: [] };

/** Record `snapshot` (the state BEFORE an edit) and invalidate redo. */
export function pushHistory(
  h: EditorHistory,
  snapshot: ReadonlyArray<Annotation>,
): EditorHistory {
  const past = [...h.past, snapshot];
  return { past: past.slice(-HISTORY_CAP), future: [] };
}

export function undoHistory(
  h: EditorHistory,
  current: ReadonlyArray<Annotation>,
): { history: EditorHistory; annotations: ReadonlyArray<Annotation> } | null {
  if (h.past.length === 0) return null;
  const previous = h.past[h.past.length - 1]!;
  return {
    history: { past: h.past.slice(0, -1), future: [...h.future, current] },
    annotations: previous,
  };
}

export function redoHistory(
  h: EditorHistory,
  current: ReadonlyArray<Annotation>,
): { history: EditorHistory; annotations: ReadonlyArray<Annotation> } | null {
  if (h.future.length === 0) return null;
  const next = h.future[h.future.length - 1]!;
  return {
    history: { past: [...h.past, current], future: h.future.slice(0, -1) },
    annotations: next,
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers — pure, unit-tested, shared by the canvas drag/transform
// handlers so the component stays thin.
// ---------------------------------------------------------------------------

/** Flip negative width/height so (x,y) is always the top-left corner. */
export function normalizeBox<T extends { x: number; y: number; width: number; height: number }>(
  box: T,
): T {
  let { x, y, width, height } = box;
  if (width < 0) {
    x += width;
    width = -width;
  }
  if (height < 0) {
    y += height;
    height = -height;
  }
  return { ...box, x, y, width, height };
}

/** Return a copy of `a` shifted by (dx, dy). Handles every annotation kind. */
export function translateAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  switch (a.kind) {
    case 'pen':
    case 'highlighter': {
      const points = a.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy));
      return { ...a, points };
    }
    case 'arrow':
      return {
        ...a,
        from: [a.from[0] + dx, a.from[1] + dy],
        to: [a.to[0] + dx, a.to[1] + dy],
      };
    case 'rect':
    case 'ellipse':
    case 'blur':
    case 'text':
      return { ...a, x: a.x + dx, y: a.y + dy };
  }
}
