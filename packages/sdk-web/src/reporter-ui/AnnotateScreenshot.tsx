// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { useEffect, useRef, useState, type JSX } from 'react';
import { Maximize2 } from 'lucide-react';
import { AnnotateCanvas, type Annotation } from './AnnotateCanvas.js';
import { bakeAnnotations } from './BlurBakery.js';
import { pushEscapeHandler } from './primitives/escapeStack.js';

export interface AnnotateScreenshotProps {
  imageBlob: Blob;
  annotations: Annotation[];
  onChange: (annotations: Annotation[]) => void;
  /** devicePixelRatio at capture time — maps stage coords ↔ image-pixel coords. */
  pixelRatio?: number;
}

/**
 * AnnotateScreenshot — thumbnail-in-modal + fullscreen overlay launcher.
 *
 * The inline canvas inside the reporter dialog is constrained by the modal's
 * max-width, which makes the screenshot too small to annotate precisely. This
 * wrapper renders a clickable thumbnail in the modal flow and opens a fullscreen
 * overlay where the AnnotateCanvas can fill the viewport. Annotations are owned
 * by the parent (the reporter dialog) so closing + reopening the overlay
 * preserves user work.
 *
 * Thumbnail preview: when annotations exist AND the overlay is closed, the
 * thumbnail shows the BAKED PNG (same bytes the submit pipeline will ship).
 * Re-baking happens lazily on overlay close (not on every stroke) so the
 * preview matches what the receiver will see without burning canvases while
 * the user is actively drawing.
 *
 * Escape "goes back" — it closes this overlay and returns to the reporter
 * modal (rather than closing the whole reporter), via the shared escapeStack.
 */
export function AnnotateScreenshot({
  imageBlob,
  annotations,
  onChange,
  pixelRatio,
}: AnnotateScreenshotProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [overlayMaxWidth, setOverlayMaxWidth] = useState<number>(1600);
  // Latch the annotation signature the current `thumbUrl` was baked from so
  // we skip redundant re-bakes when the overlay reopens without edits.
  const bakedSigRef = useRef<string>('');

  // Build / refresh the thumbnail. While the overlay is OPEN, just show the
  // original blob (the live canvas is what the user looks at anyway, and
  // mid-drag re-bakes would thrash). On every overlay close — or whenever the
  // capture blob itself changes — re-bake if there are annotations.
  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;

    if (open) {
      // Overlay is open — thumbnail isn't visible, just keep the existing one
      // until the user closes the overlay.
      return;
    }

    const sig = annotationSignature(annotations);
    if (annotations.length === 0) {
      // No annotations — straight original preview.
      const url = URL.createObjectURL(imageBlob);
      createdUrl = url;
      setThumbUrl(url);
      bakedSigRef.current = '';
    } else if (sig !== bakedSigRef.current || thumbUrl === null) {
      void (async () => {
        try {
          const baked = await bakeAnnotations(imageBlob, annotations, 12);
          if (cancelled) return;
          const url = URL.createObjectURL(baked);
          createdUrl = url;
          setThumbUrl((prev) => {
            if (prev !== null) {
              try {
                URL.revokeObjectURL(prev);
              } catch {
                /* swallow */
              }
            }
            return url;
          });
          bakedSigRef.current = sig;
        } catch {
          // DEFE-02 — never block the preview; fall back to the original blob.
          if (cancelled) return;
          const url = URL.createObjectURL(imageBlob);
          createdUrl = url;
          setThumbUrl(url);
          bakedSigRef.current = '';
        }
      })();
    }

    return () => {
      cancelled = true;
      if (createdUrl !== null) {
        try {
          URL.revokeObjectURL(createdUrl);
        } catch {
          /* swallow */
        }
      }
    };
    // We intentionally key on (imageBlob, annotations, open) — thumbUrl is
    // self-managed and would loop if included.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageBlob, annotations, open]);

  useEffect(() => {
    if (!open) return;
    const measure = (): void => {
      // Leave room for the toolbar + Done button (60px padding total).
      setOverlayMaxWidth(Math.max(320, window.innerWidth - 80));
    };
    measure();
    window.addEventListener('resize', measure);
    // Escape "goes back" to the reporter modal. Pushed on top of the modal's
    // own handler (escapeStack is LIFO) so it wins while the overlay is open,
    // and preventDefaults so the host app's Escape listeners don't also fire.
    const popEscape = pushEscapeHandler(() => setOpen(false));
    return () => {
      window.removeEventListener('resize', measure);
      popEscape();
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="txx-annotate-thumb"
        onClick={() => setOpen(true)}
        aria-label="Annotate screenshot (opens fullscreen editor)"
        data-testid="annotate-open"
      >
        {thumbUrl ? (
          <img src={thumbUrl} alt="Screenshot preview" className="txx-annotate-thumb-img" />
        ) : null}
        <span className="txx-annotate-thumb-overlay">
          <Maximize2 size={20} aria-hidden="true" />
          <span>{annotations.length > 0 ? 'Edit annotations' : 'Annotate screenshot'}</span>
        </span>
      </button>

      {open ? (
        <div
          className="txx-annotate-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Annotate screenshot"
          data-testid="annotate-overlay"
        >
          <div className="txx-annotate-overlay-bar">
            <div className="txx-annotate-overlay-bar-left">
              <button
                type="button"
                className="txx-annotate-cancel"
                onClick={() => setOpen(false)}
                aria-label="Cancel annotation editor"
                data-testid="annotate-cancel"
              >
                Cancel
              </button>
            </div>
            <span className="txx-annotate-overlay-bar-center">Edit screenshot</span>
            <div className="txx-annotate-overlay-bar-right">
              <button
                type="button"
                className="txx-annotate-done"
                onClick={() => setOpen(false)}
                data-testid="annotate-done"
              >
                Done
              </button>
            </div>
          </div>
          <div className="txx-annotate-overlay-stage">
            <AnnotateCanvas
              imageBlob={imageBlob}
              onChange={onChange}
              initialAnnotations={annotations}
              maxWidth={overlayMaxWidth}
              {...(pixelRatio !== undefined ? { pixelRatio } : {})}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * Cheap structural signature for an annotations array — used to skip
 * re-baking the thumbnail when the overlay reopens without edits.
 */
function annotationSignature(annotations: Annotation[]): string {
  return annotations
    .map((a) => {
      switch (a.kind) {
        case 'pen':
        case 'highlighter':
          return `${a.id}:${a.kind}:${a.color}:${a.thickness}:${a.points.length}:${a.points[a.points.length - 2] ?? 0},${a.points[a.points.length - 1] ?? 0}`;
        case 'arrow':
          return `${a.id}:ar:${a.color}:${a.thickness}:${a.from.join()},${a.to.join()}`;
        case 'text':
          return `${a.id}:t:${a.color}:${a.fontSize}:${a.x},${a.y}:${a.text}`;
        case 'rect':
        case 'ellipse':
        case 'blur':
          return `${a.id}:${a.kind}:${'color' in a ? a.color : ''}:${a.x},${a.y},${a.width},${a.height}`;
      }
    })
    .join('|');
}
