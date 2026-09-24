// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { useCallback, useEffect, useRef, useState, type ComponentType, type JSX } from 'react';
// Native-parity glyphs (CONTEXT D6): literal characters, no icon library.
// pen ✎ · highlighter ▰ · rect □ · ellipse ○ · arrow → · redact ▭ · picker ⊙
// · pointer ➤ (Task 4) · text T (Task 5). Undo/redo keep ↶ / ↷.
import {
  EMPTY_HISTORY,
  HIGHLIGHTER_OPACITY,
  HIGHLIGHTER_WIDTH_MULTIPLIER,
  PEN_COLORS,
  PEN_THICKNESSES,
  TEXT_FONT_FAMILY,
  TEXT_FONT_SIZES,
  TEXT_LINE_HEIGHT,
  newAnnotationId,
  normalizeBox,
  pushHistory,
  redoHistory,
  translateAnnotation,
  undoHistory,
  type Annotation,
  type AnnotationId,
  type EditorHistory,
  type TextShape,
} from './annotation-model.js';
import { pushEscapeHandler } from './primitives/escapeStack.js';

// Backwards-compat re-exports — ReporterDialog, BlurBakery, tests, and the
// protocol audit trail all import these names from AnnotateCanvas.
export { PEN_COLORS, PEN_THICKNESSES } from './annotation-model.js';
export type {
  Annotation,
  AnnotationId,
  ArrowAnnotation,
  BlurRect,
  EllipseShape,
  HighlighterStroke,
  PenStroke,
  RectShape,
  TextShape,
} from './annotation-model.js';

export type Tool =
  | 'pointer'
  | 'pen'
  | 'highlighter'
  | 'rect'
  | 'ellipse'
  | 'arrow'
  | 'text'
  | 'blur';

export interface AnnotateCanvasProps {
  imageBlob: Blob;
  onChange: (annotations: Annotation[]) => void;
  /** Seed annotations on mount — used when the canvas is unmounted/remounted
   *  by the fullscreen overlay flow. Annotations are owned by the parent so
   *  closing + reopening the overlay preserves user work. */
  initialAnnotations?: Annotation[];
  /** Override the display-width cap. Used by the fullscreen overlay to allow
   *  the canvas to fill the viewport instead of the in-modal MAX_CANVAS_WIDTH. */
  maxWidth?: number;
  /**
   * Ratio of screenshot-bytes pixels to CSS pixels (devicePixelRatio at
   * capture time). Stage-internal coords are screenshot pixels; tree rects
   * are CSS pixels; we divide by this to map between them. Defaults to 1.
   */
  pixelRatio?: number;
}

interface KonvaPointerEvt {
  evt: PointerEvent;
  cancelBubble?: boolean;
  target: {
    getStage: () => {
      // Pointer position in STAGE-INTERNAL (untransformed) coordinates — i.e.
      // natural image-pixel space when the Image is rendered at imgDims and the
      // Stage applies scaleX/scaleY for fit-to-container display. We store
      // annotations in this space so BlurBakery receives correct natural-coord
      // rects and the rendered annotations land precisely under the cursor.
      getRelativePointerPosition: () => { x: number; y: number } | null;
      /** The Stage's root DOM element — used to set the hover cursor. */
      container: () => HTMLElement;
    };
  };
}

interface KonvaNodeEvt {
  target: {
    x: () => number;
    y: () => number;
    scaleX: () => number;
    scaleY: () => number;
    scale: (s: { x: number; y: number }) => void;
    position: (p: { x: number; y: number }) => void;
  };
}

type KonvaModule = {
  Stage: ComponentType<Record<string, unknown>>;
  Layer: ComponentType<Record<string, unknown>>;
  Line: ComponentType<Record<string, unknown>>;
  Rect: ComponentType<Record<string, unknown>>;
  Ellipse: ComponentType<Record<string, unknown>>;
  Image: ComponentType<Record<string, unknown>>;
  Arrow: ComponentType<Record<string, unknown>>;
  Circle: ComponentType<Record<string, unknown>>;
  Text: ComponentType<Record<string, unknown>>;
  Transformer: ComponentType<Record<string, unknown>>;
};

/** Tools that draw a stroke-styled shape (share the color/thickness row). */
const STROKE_TOOLS: ReadonlyArray<Tool> = ['pen', 'highlighter', 'rect', 'ellipse', 'arrow'];
/** Box-drag tools — pointerdown starts a rect-like drag. */
const BOX_TOOLS: ReadonlyArray<Tool> = ['rect', 'ellipse', 'blur'];
/** Minimum box edge (image px) — smaller drags are treated as accidental. */
const MIN_BOX_EDGE = 3;

/**
 * Grow the inline text editor to fit its content. Reset to 'auto' first so
 * `scrollWidth`/`scrollHeight` reflect the CONTENT's natural size rather than
 * whatever width/height the element is currently locked to (a textarea's
 * scroll metrics can never report smaller than its current box) — without
 * the reset, the box can grow but never shrink back down as text is deleted.
 */
const autosizeTextarea = (el: HTMLTextAreaElement): void => {
  el.style.width = 'auto';
  el.style.width = `${el.scrollWidth + 4}px`;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
};

/** Kinds that get Transformer corner handles. Strokes are drag-move only
 *  (resizing a freehand path is rarely what the user means); arrows get
 *  dedicated endpoint handles instead. */
const RESIZABLE_KINDS: ReadonlySet<Annotation['kind']> = new Set([
  'rect',
  'ellipse',
  'blur',
  'text',
]);

/**
 * AnnotateCanvas — react-konva annotation editor (report-window overhaul).
 * Id-based annotations + snapshot undo/redo (annotation-model.ts). Konva is
 * lazy-imported on mount (Pattern 4 — idle SDK does not load Konva). The
 * screenshot renders inside the Stage's first Layer so bitmap + annotations
 * share one coordinate space; the receiver gets the BAKED bytes via
 * BlurBakery on submit (this canvas is preview-only).
 */
const MAX_CANVAS_WIDTH = 1024;
/** Cap on upscaling small crops so a tiny selection doesn't become pixel mush. */
const MAX_UPSCALE = 4;

export function AnnotateCanvas({
  imageBlob,
  onChange,
  initialAnnotations,
  maxWidth = MAX_CANVAS_WIDTH,
  pixelRatio = 1,
}: AnnotateCanvasProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [tool, setToolState] = useState<Tool>('pen');
  const [color, setColor] = useState<string>(PEN_COLORS[0]);
  const [thickness, setThickness] = useState<number>(PEN_THICKNESSES[1]);
  const [fontSize, setFontSize] = useState<number>(TEXT_FONT_SIZES[1]);
  const [editingId, setEditingId] = useState<AnnotationId | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>(initialAnnotations ?? []);
  const [history, setHistory] = useState<EditorHistory>(EMPTY_HISTORY);
  const [selectedId, setSelectedId] = useState<AnnotationId | null>(null);
  const [konvaModule, setKonvaModule] = useState<KonvaModule | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(null);
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(maxWidth);
  // Kind of in-progress draw gesture. The shape itself lives at the tail of
  // `annotations` — every pointermove replaces it with a NEW object so
  // react-konva sees a prop-identity change and redraws.
  const drawingRef = useRef<Tool | null>(null);
  // Pre-gesture snapshot — lets a degenerate gesture (tiny accidental drag)
  // cancel cleanly, popping the history entry beginGesture() pushed.
  const gestureSnapshotRef = useRef<Annotation[] | null>(null);
  // Inline text editor plumbing. `textEditRef` lets the escape handler read
  // the live textarea value; `freshTextIdRef` marks a just-placed (never
  // committed) text so an empty commit cancels the placement instead of
  // deleting — re-edits of existing texts do NOT set it.
  const textEditRef = useRef<HTMLTextAreaElement | null>(null);
  const freshTextIdRef = useRef<AnnotationId | null>(null);

  // Konva node registry — Transformer attaches to the selected node by ref.
  const nodeRefs = useRef<Map<AnnotationId, unknown>>(new Map());
  const trRef = useRef<{
    nodes: (n: unknown[]) => void;
    getLayer: () => { batchDraw?: () => void } | null;
  } | null>(null);
  const nodeRefFor =
    (id: AnnotationId) =>
    (node: unknown): void => {
      if (node) nodeRefs.current.set(id, node);
      else nodeRefs.current.delete(id);
    };

  const selectedShape = selectedId
    ? (annotations.find((a) => a.id === selectedId) ?? null)
    : null;

  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    // jsdom's mocked Transformer renders as a plain div (no Konva `.nodes`
    // method) — only real Konva stages (e2e, Task 13) exercise this branch.
    if (typeof tr.nodes !== 'function') return;
    const node = selectedId ? nodeRefs.current.get(selectedId) : undefined;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw?.();
  }, [selectedId, annotations, konvaModule]);

  /** Switching tools always drops the shape selection (modern-editor norm). */
  const setTool = (t: Tool): void => {
    setToolState(t);
    setSelectedId(null);
  };

  /** Push the CURRENT annotations as an undo snapshot; edits follow. */
  const beginGesture = (): void => {
    gestureSnapshotRef.current = annotations;
    setHistory((h) => pushHistory(h, annotations));
  };

  /** Abort the in-flight gesture: restore the snapshot, pop its history entry. */
  const cancelGesture = (): void => {
    const snap = gestureSnapshotRef.current;
    if (snap === null) return;
    gestureSnapshotRef.current = null;
    setAnnotations(snap);
    setHistory((h) => ({ past: h.past.slice(0, -1), future: h.future }));
  };

  /** One-shot undoable change (delete, restyle, text commit). */
  const commitChange = (next: Annotation[]): void => {
    setHistory((h) => pushHistory(h, annotations));
    setAnnotations(next);
  };

  const patchAnnotation = (id: AnnotationId, patch: Partial<Annotation>): void =>
    setAnnotations((prev) =>
      prev.map((a) => (a.id === id ? ({ ...a, ...patch } as Annotation) : a)),
    );

  const deleteSelected = useCallback((): void => {
    if (!selectedId) return;
    setHistory((h) => pushHistory(h, annotations));
    setAnnotations(annotations.filter((a) => a.id !== selectedId));
    setSelectedId(null);
  }, [selectedId, annotations]);

  /** Style-row click with a selection: restyle THAT shape (undoable) and
   *  update the default for the next shape. */
  const applyStyle = (patch: { color?: string; thickness?: number }): void => {
    if (patch.color !== undefined) setColor(patch.color);
    if (patch.thickness !== undefined) setThickness(patch.thickness);
    if (selectedShape && selectedShape.kind !== 'blur') {
      const styled =
        selectedShape.kind === 'text'
          ? { ...(patch.color !== undefined ? { color: patch.color } : {}) }
          : patch;
      if (Object.keys(styled).length > 0) {
        commitChange(
          annotations.map((a) =>
            a.id === selectedShape.id ? ({ ...a, ...styled } as Annotation) : a,
          ),
        );
      }
    }
  };

  const commitTextEdit = (value: string): void => {
    const id = editingId;
    setEditingId(null);
    if (!id) return;
    const trimmed = value.replace(/\s+$/, '');
    const isFresh = freshTextIdRef.current === id;
    freshTextIdRef.current = null;
    if (trimmed.length === 0) {
      if (isFresh) {
        // Empty fresh placement = never really placed; pop the gesture.
        cancelGesture();
      } else {
        // Clearing an existing text = delete. The dblclick beginGesture
        // already pushed the pre-edit snapshot, so one undo restores it.
        gestureSnapshotRef.current = null;
        setAnnotations((prev) => prev.filter((a) => a.id !== id));
      }
      setSelectedId(null);
      return;
    }
    gestureSnapshotRef.current = null;
    patchAnnotation(id, { text: trimmed });
  };

  // Escape while editing must commit the text WITHOUT closing the fullscreen
  // annotate overlay. The escapeStack listener runs on window CAPTURE phase
  // with stopImmediatePropagation, so the textarea's own React onKeyDown can
  // never intercept first — instead we push our own handler on top of the
  // LIFO stack for the duration of the edit session.
  useEffect(() => {
    if (editingId === null) return;
    return pushEscapeHandler(() => {
      commitTextEdit(textEditRef.current?.value ?? '');
    });
    // Key on editingId only: the handler must be stable per edit session
    // (re-pushing every render would churn the stack) and it reads live
    // state via textEditRef; commitTextEdit's closure is fresh at push time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  // Focus the inline editor OUTSIDE the placing pointerdown's event cycle.
  // autoFocus focused the textarea mid-dispatch, and the browser's native
  // mousedown default action then blurred it immediately — blur-commit saw
  // an empty fresh placement and cancelled it (real-browser only; jsdom has
  // no mousedown-default-blur, which is why unit tests never caught it).
  useEffect(() => {
    if (!editingId) return;
    const raf = requestAnimationFrame(() => {
      const el = textEditRef.current;
      el?.focus();
      if (el) autosizeTextarea(el);
    });
    return () => cancelAnimationFrame(raf);
  }, [editingId]);

  useEffect(() => {
    let cancelled = false;
    // Lazy-load react-konva only when AnnotateCanvas mounts (Pattern 4 — bundle budget).
    void import('react-konva').then((mod) => {
      if (!cancelled) setKonvaModule(mod as unknown as KonvaModule);
    });
    const url = URL.createObjectURL(imageBlob);
    setImageUrl(url);
    const img = new Image();
    img.onload = (): void => {
      setImgDims({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
      setImgEl(img);
    };
    img.onerror = (): void => setImgDims({ w: 1, h: 1 });
    img.src = url;
    // jsdom typically does not fire `onload` for blob URLs; fall back after a microtask.
    queueMicrotask(() => {
      if (!cancelled && !imgDims) setImgDims((prev) => prev ?? { w: 1, h: 1 });
    });
    return () => {
      cancelled = true;
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* swallow — DEFE-02 */
      }
    };
    // imageBlob is the only meaningful dep
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageBlob]);

  // Track container width for responsive Stage scaling.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = (): void => {
      const w = el.clientWidth;
      if (w > 0) setContainerWidth(Math.min(maxWidth, w));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    onChange(annotations);
  }, [annotations, onChange]);

  const undo = useCallback((): void => {
    const r = undoHistory(history, annotations);
    if (!r) return;
    setHistory(r.history);
    setAnnotations(r.annotations as Annotation[]);
    setSelectedId(null);
  }, [history, annotations]);

  const redo = useCallback((): void => {
    const r = redoHistory(history, annotations);
    if (!r) return;
    setHistory(r.history);
    setAnnotations(r.annotations as Annotation[]);
    setSelectedId(null);
  }, [history, annotations]);

  // Keyboard undo/redo. Document-level so it works while the canvas has focus,
  // but guarded against text fields so Ctrl+Z in the title/description inputs
  // still does TEXT undo (the reporter modal renders inputs alongside the canvas).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      const typing =
        t !== null &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (selectedId) {
          e.preventDefault();
          deleteSelected();
        }
        return;
      }
      if (typing || !(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if ((e.shiftKey && k === 'z') || k === 'y') {
        e.preventDefault();
        redo();
      } else if (!e.shiftKey && k === 'z') {
        e.preventDefault();
        undo();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [undo, redo, selectedId, deleteSelected]);

  if (!konvaModule || !imageUrl || !imgDims) {
    return (
      <div
        ref={containerRef}
        className="everframe-canvas-loading"
        data-testid="annotate-canvas-loading"
      >
        Loading annotation canvas…
      </div>
    );
  }
  const {
    Stage,
    Layer,
    Line,
    Rect: KRect,
    Ellipse: KEllipse,
    Image: KImage,
    Arrow: KArrow,
    Text: KText,
    Circle: KCircle,
    Transformer: KTransformer,
  } = konvaModule;
  // Small crops upscale to fill the available width (capped ×4 so a tiny
  // selection doesn't become pixel mush); large shots downscale to fit as before.
  const scale = Math.min(containerWidth / imgDims.w, MAX_UPSCALE);
  const dispW = imgDims.w * scale;
  const dispH = imgDims.h * scale;

  const onPointerDown = (e: KonvaPointerEvt): void => {
    // A stage click while the inline text editor is open must commit the
    // in-flight edit FIRST, deterministically — before any tool branch runs.
    // Without this, a click with the text tool active synchronously creates
    // a NEW text annotation + setEditingId(newId) inside this same handler;
    // the textarea is keyed by editing id, so React unmounts the OLD
    // textarea before its blur can fire reliably, silently dropping the
    // typed value. This swallows the first click as a commit; the next
    // click places the next box.
    if (editingId) {
      commitTextEdit(textEditRef.current?.value ?? '');
      return;
    }
    const pos = e.target.getStage().getRelativePointerPosition();
    if (!pos) return;
    if (tool === 'pointer') {
      setSelectedId(null);
      return;
    }
    if (tool === 'text') {
      // Place a text box and open the inline editor immediately.
      beginGesture();
      const id = newAnnotationId();
      setAnnotations((prev) => [
        ...prev,
        { id, kind: 'text', x: pos.x, y: pos.y, text: '', color, fontSize },
      ]);
      setSelectedId(id);
      setEditingId(id);
      freshTextIdRef.current = id;
      return;
    }
    setSelectedId(null);
    drawingRef.current = tool;
    beginGesture();
    const id = newAnnotationId();
    if (tool === 'pen' || tool === 'highlighter') {
      setAnnotations((prev) => [
        ...prev,
        { id, kind: tool, points: [pos.x, pos.y], color, thickness },
      ]);
    } else if (tool === 'arrow') {
      setAnnotations((prev) => [
        ...prev,
        { id, kind: 'arrow', from: [pos.x, pos.y], to: [pos.x, pos.y], color, thickness },
      ]);
    } else if (tool === 'rect' || tool === 'ellipse') {
      setAnnotations((prev) => [
        ...prev,
        { id, kind: tool, x: pos.x, y: pos.y, width: 0, height: 0, color, thickness },
      ]);
    } else {
      setAnnotations((prev) => [
        ...prev,
        { id, kind: 'blur', x: pos.x, y: pos.y, width: 0, height: 0 },
      ]);
    }
  };
  const onPointerMove = (e: KonvaPointerEvt): void => {
    if (!drawingRef.current) return;
    const pos = e.target.getStage().getRelativePointerPosition();
    if (!pos) return;
    setAnnotations((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1]!;
      if (last.kind === 'pen' || last.kind === 'highlighter') {
        return [...prev.slice(0, -1), { ...last, points: [...last.points, pos.x, pos.y] }];
      }
      if (last.kind === 'arrow') {
        return [...prev.slice(0, -1), { ...last, to: [pos.x, pos.y] as [number, number] }];
      }
      if (last.kind === 'rect' || last.kind === 'ellipse' || last.kind === 'blur') {
        return [
          ...prev.slice(0, -1),
          { ...last, width: pos.x - last.x, height: pos.y - last.y },
        ];
      }
      return prev;
    });
  };
  const onPointerUp = (): void => {
    const kind = drawingRef.current;
    drawingRef.current = null;
    if (!kind) return;
    const last = annotations[annotations.length - 1];
    if (!last) return;
    // Degenerate gestures cancel cleanly (accidental click with a box tool).
    if (last.kind === 'rect' || last.kind === 'ellipse' || last.kind === 'blur') {
      if (Math.abs(last.width) < MIN_BOX_EDGE || Math.abs(last.height) < MIN_BOX_EDGE) {
        cancelGesture();
        return;
      }
      patchAnnotation(last.id, normalizeBox(last));
    }
    if (last.kind === 'arrow') {
      const len = Math.hypot(last.to[0] - last.from[0], last.to[1] - last.from[1]);
      if (len < MIN_BOX_EDGE) {
        cancelGesture();
        return;
      }
    }
    gestureSnapshotRef.current = null;
    // Auto-select the finished shape so it can immediately be moved/restyled;
    // the drawing tool stays active for the next stroke.
    setSelectedId(last.id);
  };

  const handleDragEnd = (a: Annotation, e: KonvaNodeEvt): void => {
    const node = e.target;
    if (a.kind === 'pen' || a.kind === 'highlighter' || a.kind === 'arrow') {
      // Point-array shapes render at origin; the drag offset is the node position.
      const dx = node.x();
      const dy = node.y();
      node.position({ x: 0, y: 0 });
      setAnnotations((prev) =>
        prev.map((p) => (p.id === a.id ? translateAnnotation(p, dx, dy) : p)),
      );
      return;
    }
    if (a.kind === 'ellipse') {
      // Ellipse node position is its CENTER.
      patchAnnotation(a.id, { x: node.x() - a.width / 2, y: node.y() - a.height / 2 });
      return;
    }
    patchAnnotation(a.id, { x: node.x(), y: node.y() }); // rect | blur | text
  };

  const handleTransformEnd = (a: Annotation, e: KonvaNodeEvt): void => {
    const node = e.target;
    const sX = node.scaleX();
    const sY = node.scaleY();
    node.scale({ x: 1, y: 1 });
    if (a.kind === 'text') {
      patchAnnotation(a.id, {
        x: node.x(),
        y: node.y(),
        fontSize: Math.max(8, Math.round(a.fontSize * sX)),
      });
      return;
    }
    if (a.kind === 'ellipse') {
      const width = Math.max(MIN_BOX_EDGE, a.width * sX);
      const height = Math.max(MIN_BOX_EDGE, a.height * sY);
      patchAnnotation(a.id, { x: node.x() - width / 2, y: node.y() - height / 2, width, height });
      return;
    }
    if (a.kind === 'rect' || a.kind === 'blur') {
      patchAnnotation(a.id, {
        x: node.x(),
        y: node.y(),
        width: Math.max(MIN_BOX_EDGE, a.width * sX),
        height: Math.max(MIN_BOX_EDGE, a.height * sY),
      });
    }
  };

  /** Shared editing props for every rendered annotation node. A click on any
   *  shape selects it regardless of active tool; drawing over an existing
   *  shape starts just outside it. A shape is draggable with the pointer tool
   *  OR while it is the selection (so the auto-selected just-drawn shape can
   *  be moved without switching tools). */
  const editProps = (a: Annotation): Record<string, unknown> => ({
    ref: nodeRefFor(a.id),
    draggable: tool === 'pointer' || a.id === selectedId,
    onPointerDown: (e: KonvaPointerEvt) => {
      e.cancelBubble = true;
      setSelectedId(a.id);
    },
    // Shapes are click-selectable with any tool — advertise it.
    onMouseEnter: (e: KonvaPointerEvt) => {
      e.target.getStage().container().style.cursor = 'pointer';
    },
    onMouseLeave: (e: KonvaPointerEvt) => {
      e.target.getStage().container().style.cursor = '';
    },
    onDragStart: () => beginGesture(),
    onDragEnd: (e: KonvaNodeEvt) => handleDragEnd(a, e),
    onTransformStart: () => beginGesture(),
    onTransformEnd: (e: KonvaNodeEvt) => handleTransformEnd(a, e),
    onDblClick: () => {
      if (a.kind === 'text') {
        beginGesture();
        setSelectedId(a.id);
        setEditingId(a.id);
      }
    },
    onDblTap: () => {
      if (a.kind === 'text') {
        beginGesture();
        setSelectedId(a.id);
        setEditingId(a.id);
      }
    },
  });

  const renderAnnotation = (a: Annotation): JSX.Element => {
    switch (a.kind) {
      case 'pen':
      case 'highlighter':
        return (
          <Line
            key={a.id}
            {...editProps(a)}
            points={a.points}
            stroke={a.color}
            strokeWidth={
              a.kind === 'highlighter' ? a.thickness * HIGHLIGHTER_WIDTH_MULTIPLIER : a.thickness
            }
            opacity={a.kind === 'highlighter' ? HIGHLIGHTER_OPACITY : 1}
            lineCap="round"
            lineJoin="round"
            hitStrokeWidth={Math.max(12, a.thickness)}
          />
        );
      case 'arrow':
        return (
          <KArrow
            key={a.id}
            {...editProps(a)}
            points={[a.from[0], a.from[1], a.to[0], a.to[1]]}
            stroke={a.color}
            fill={a.color}
            strokeWidth={a.thickness}
            pointerLength={Math.max(8, a.thickness * 3)}
            pointerWidth={Math.max(8, a.thickness * 3)}
            lineCap="round"
            lineJoin="round"
            hitStrokeWidth={Math.max(12, a.thickness)}
          />
        );
      case 'rect':
        return (
          <KRect
            key={a.id}
            {...editProps(a)}
            x={a.x}
            y={a.y}
            width={a.width}
            height={a.height}
            stroke={a.color}
            strokeWidth={a.thickness}
            fill="transparent"
            hitStrokeWidth={Math.max(12, a.thickness)}
          />
        );
      case 'ellipse':
        return (
          <KEllipse
            key={a.id}
            {...editProps(a)}
            x={a.x + a.width / 2}
            y={a.y + a.height / 2}
            radiusX={Math.abs(a.width / 2)}
            radiusY={Math.abs(a.height / 2)}
            stroke={a.color}
            strokeWidth={a.thickness}
            fill="transparent"
            hitStrokeWidth={Math.max(12, a.thickness)}
          />
        );
      case 'text':
        return (
          <KText
            key={a.id}
            {...editProps(a)}
            visible={a.id !== editingId}
            x={a.x}
            y={a.y}
            text={a.text}
            fill={a.color}
            fontSize={a.fontSize}
            fontFamily={TEXT_FONT_FAMILY}
            lineHeight={TEXT_LINE_HEIGHT}
          />
        );
      case 'blur':
        // Blur regions render as opaque black in the editor preview too,
        // matching the baked output (PRIV-03).
        return (
          <KRect
            key={a.id}
            {...editProps(a)}
            x={a.x}
            y={a.y}
            width={a.width}
            height={a.height}
            fill="#000"
          />
        );
    }
  };

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
      }}
      data-testid="annotate-canvas-stage"
    >
      <div
        className="everframe-annotate-canvas-frame"
        style={{ width: dispW, maxWidth: '100%', position: 'relative' }}
      >
      <Stage
        width={dispW}
        height={dispH}
        scaleX={scale}
        scaleY={scale}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <Layer>
          {imgEl ? (
            <KImage
              image={imgEl}
              x={0}
              y={0}
              width={imgDims.w}
              height={imgDims.h}
              listening={false}
              data-testid="annotate-canvas-image"
            />
          ) : null}
        </Layer>
        <Layer>
          {annotations.map(renderAnnotation)}
          {selectedShape && RESIZABLE_KINDS.has(selectedShape.kind) ? (
            <KTransformer
              ref={trRef}
              rotateEnabled={false}
              flipEnabled={false}
              keepRatio={false}
              enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']}
              data-testid="konva-transformer"
            />
          ) : null}
          {selectedShape?.kind === 'arrow' ? (
            <>
              <KCircle
                x={selectedShape.from[0]}
                y={selectedShape.from[1]}
                radius={Math.max(8, selectedShape.thickness * 2)}
                fill="#ffffff"
                stroke="#2563eb"
                strokeWidth={2}
                draggable
                onPointerDown={(e: KonvaPointerEvt) => {
                  // Konva drag does NOT stop the pointerdown bubbling; without
                  // this the Stage handler deselects (pointer tool) or starts
                  // a stray draw gesture (arrow tool) mid-handle-drag.
                  e.cancelBubble = true;
                }}
                onMouseEnter={(e: KonvaPointerEvt) => {
                  e.target.getStage().container().style.cursor = 'pointer';
                }}
                onMouseLeave={(e: KonvaPointerEvt) => {
                  e.target.getStage().container().style.cursor = '';
                }}
                onDragStart={() => beginGesture()}
                onDragMove={(e: KonvaNodeEvt) =>
                  patchAnnotation(selectedShape.id, {
                    from: [e.target.x(), e.target.y()] as [number, number],
                  })
                }
                data-testid="arrow-handle-from"
              />
              <KCircle
                x={selectedShape.to[0]}
                y={selectedShape.to[1]}
                radius={Math.max(8, selectedShape.thickness * 2)}
                fill="#ffffff"
                stroke="#2563eb"
                strokeWidth={2}
                draggable
                onPointerDown={(e: KonvaPointerEvt) => {
                  e.cancelBubble = true;
                }}
                onMouseEnter={(e: KonvaPointerEvt) => {
                  e.target.getStage().container().style.cursor = 'pointer';
                }}
                onMouseLeave={(e: KonvaPointerEvt) => {
                  e.target.getStage().container().style.cursor = '';
                }}
                onDragStart={() => beginGesture()}
                onDragMove={(e: KonvaNodeEvt) =>
                  patchAnnotation(selectedShape.id, {
                    to: [e.target.x(), e.target.y()] as [number, number],
                  })
                }
                data-testid="arrow-handle-to"
              />
            </>
          ) : null}
        </Layer>
      </Stage>
      {(() => {
        const editing = editingId
          ? annotations.find((a): a is TextShape => a.id === editingId && a.kind === 'text')
          : undefined;
        if (!editing) return null;
        return (
          <textarea
            key={editing.id}
            ref={textEditRef}
            data-testid="text-editor"
            className="everframe-text-editor"
            defaultValue={editing.text}
            style={{
              left: editing.x * scale,
              top: editing.y * scale,
              fontSize: editing.fontSize * scale,
              lineHeight: TEXT_LINE_HEIGHT,
              color: editing.color,
              fontFamily: TEXT_FONT_FAMILY,
            }}
            // Escape is handled via the pushEscapeHandler effect above — a
            // React onKeyDown here can never run before escapeStack's
            // window capture-phase listener. After the escape handler
            // commits, the focus-loss blur re-enters commitTextEdit with
            // editingId already null and early-returns harmlessly.
            onBlur={(e) => commitTextEdit(e.currentTarget.value)}
            onInput={(e) => autosizeTextarea(e.currentTarget)}
            onKeyDown={(e) => {
              // Enter commits (modern-editor convention); Shift+Enter still
              // inserts a newline. Without this, Enter's default browser
              // action (insert \n) grows the content past the editor's fixed
              // height, and native textarea auto-scroll pushes the
              // already-typed lines out of the clipped viewport — the text
              // is still THERE (in `value`) but looks like it vanished.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commitTextEdit(e.currentTarget.value);
              }
            }}
          />
        );
      })()}
      </div>
      <div className="everframe-annotation-toolbar" role="toolbar" aria-label="Annotation tools">
        <button
          type="button"
          aria-label="Select and move annotations"
          onClick={() => setToolState('pointer')}
          className={tool === 'pointer' ? 'everframe-tool-btn everframe-tool-btn-active' : 'everframe-tool-btn'}
          data-testid="tool-pointer"
        >
          <span aria-hidden="true" className="everframe-tool-glyph">➤</span>
        </button>
        <button
          type="button"
          aria-label="Draw freehand on screenshot"
          onClick={() => setTool('pen')}
          className={tool === 'pen' ? 'everframe-tool-btn everframe-tool-btn-active' : 'everframe-tool-btn'}
          data-testid="tool-pen"
        >
          <span aria-hidden="true" className="everframe-tool-glyph">✎</span>
        </button>
        <button
          type="button"
          aria-label="Highlight a region of the screenshot"
          onClick={() => setTool('highlighter')}
          className={tool === 'highlighter' ? 'everframe-tool-btn everframe-tool-btn-active' : 'everframe-tool-btn'}
          data-testid="tool-highlighter"
        >
          <span aria-hidden="true" className="everframe-tool-glyph">▰</span>
        </button>
        <button
          type="button"
          aria-label="Draw a rectangle outline"
          onClick={() => setTool('rect')}
          className={tool === 'rect' ? 'everframe-tool-btn everframe-tool-btn-active' : 'everframe-tool-btn'}
          data-testid="tool-rect"
        >
          <span aria-hidden="true" className="everframe-tool-glyph">□</span>
        </button>
        <button
          type="button"
          aria-label="Draw an ellipse outline"
          onClick={() => setTool('ellipse')}
          className={tool === 'ellipse' ? 'everframe-tool-btn everframe-tool-btn-active' : 'everframe-tool-btn'}
          data-testid="tool-ellipse"
        >
          <span aria-hidden="true" className="everframe-tool-glyph">○</span>
        </button>
        <button
          type="button"
          aria-label="Draw an arrow on the screenshot"
          onClick={() => setTool('arrow')}
          className={tool === 'arrow' ? 'everframe-tool-btn everframe-tool-btn-active' : 'everframe-tool-btn'}
          data-testid="tool-arrow"
        >
          <span aria-hidden="true" className="everframe-tool-glyph">→</span>
        </button>
        <button
          type="button"
          aria-label="Add text to screenshot"
          onClick={() => setTool('text')}
          className={tool === 'text' ? 'everframe-tool-btn everframe-tool-btn-active' : 'everframe-tool-btn'}
          data-testid="tool-text"
        >
          <span aria-hidden="true" className="everframe-tool-glyph">T</span>
        </button>
        <button
          type="button"
          aria-label="Redact a region of the screenshot"
          onClick={() => setTool('blur')}
          className={tool === 'blur' ? 'everframe-tool-btn everframe-tool-btn-active' : 'everframe-tool-btn'}
          data-testid="tool-blur"
        >
          <span aria-hidden="true" className="everframe-tool-glyph">▭</span>
        </button>
        <span className="everframe-palette-sep" aria-hidden="true" />
        <button
          type="button"
          aria-label="Undo last change"
          disabled={history.past.length === 0}
          onClick={undo}
          className="everframe-tool-btn"
          data-testid="tool-undo"
        >
          <span aria-hidden="true" className="everframe-tool-glyph">↶</span>
        </button>
        <button
          type="button"
          aria-label="Redo change"
          disabled={history.future.length === 0}
          onClick={redo}
          className="everframe-tool-btn"
          data-testid="tool-redo"
        >
          <span aria-hidden="true" className="everframe-tool-glyph">↷</span>
        </button>
        <button
          type="button"
          aria-label="Delete selected annotation"
          disabled={!selectedId}
          onClick={deleteSelected}
          className="everframe-tool-btn"
          data-testid="tool-delete"
        >
          <span aria-hidden="true" className="everframe-tool-glyph">⌫</span>
        </button>
      </div>
      {(STROKE_TOOLS.includes(tool) ||
        tool === 'text' ||
        (selectedShape !== null && selectedShape.kind !== 'blur')) && (
        <div
          className="everframe-annotation-subtoolbar"
          role="toolbar"
          aria-label="Color and thickness"
          data-testid="style-row"
        >
          {PEN_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Color: ${c}`}
              onClick={() => applyStyle({ color: c })}
              className={
                (selectedShape && 'color' in selectedShape ? selectedShape.color : color) === c
                  ? 'everframe-swatch everframe-swatch-selected'
                  : 'everframe-swatch'
              }
              style={{ background: c }}
            />
          ))}
          {tool === 'text' || selectedShape?.kind === 'text'
            ? TEXT_FONT_SIZES.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-label={`Text size: ${s}px`}
                  onClick={() => {
                    setFontSize(s);
                    if (selectedShape?.kind === 'text') {
                      commitChange(
                        annotations.map((a) =>
                          a.id === selectedShape.id ? { ...a, fontSize: s } : a,
                        ),
                      );
                    }
                  }}
                  className={
                    (selectedShape?.kind === 'text' ? selectedShape.fontSize : fontSize) === s
                      ? 'everframe-thickness everframe-thickness-selected'
                      : 'everframe-thickness'
                  }
                  data-testid={`fontsize-${s}`}
                >
                  {s === 16 ? 'S' : s === 24 ? 'M' : 'L'}
                </button>
              ))
            : PEN_THICKNESSES.map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-label={`Thickness: ${t}px`}
                  onClick={() => applyStyle({ thickness: t })}
                  className={
                    (selectedShape && 'thickness' in selectedShape
                      ? selectedShape.thickness
                      : thickness) === t
                      ? 'everframe-thickness everframe-thickness-selected'
                      : 'everframe-thickness'
                  }
                >
                  {t}
                </button>
              ))}
        </div>
      )}
    </div>
  );
}
