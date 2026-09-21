// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { useEffect, useState, type JSX } from 'react';

/** Hard cap on screenshots per report — keeps the multipart payload well
 *  inside the 25 MB PIPE-03 envelope cap. */
export const MAX_SCREENSHOTS = 5;

export interface StripShot {
  id: string;
  blob: Blob;
  annotationCount: number;
  source: 'auto' | 'manual';
}

export interface ScreenshotStripProps {
  shots: StripShot[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  /** True while an add-capture is in flight — disables the add tile. */
  adding: boolean;
}

/**
 * ScreenshotStrip — thumbnail row under the annotate surface. One thumb per
 * screenshot (active highlighted, × delete badge) plus an add tile (hidden at
 * MAX_SCREENSHOTS). Object URLs are strip-owned and revoked on change/unmount.
 */
export function ScreenshotStrip({
  shots,
  activeId,
  onSelect,
  onDelete,
  onAdd,
  adding,
}: ScreenshotStripProps): JSX.Element {
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());

  // Object URLs depend only on each shot's blob, which never changes for a
  // given id — key the effect on the id list so annotation edits (which mint
  // a new shots array every stroke) don't churn createObjectURL/revoke.
  const shotIdsKey = shots.map((s) => s.id).join('|');
  useEffect(() => {
    const next = new Map<string, string>();
    for (const s of shots) next.set(s.id, URL.createObjectURL(s.blob));
    setUrls(next);
    return () => {
      for (const u of next.values()) {
        try {
          URL.revokeObjectURL(u);
        } catch {
          /* swallow — DEFE-02 */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotIdsKey]);

  return (
    <div
      className="txx-shot-strip"
      role="list"
      aria-label="Screenshots in this report"
      data-testid="screenshot-strip"
    >
      {shots.map((s, i) => (
        <div
          key={s.id}
          role="listitem"
          className={
            s.id === activeId ? 'txx-shot-thumb txx-shot-thumb-active' : 'txx-shot-thumb'
          }
        >
          <button
            type="button"
            className="txx-shot-thumb-btn"
            onClick={() => onSelect(s.id)}
            aria-label={`Screenshot ${i + 1} of ${shots.length}${
              s.annotationCount > 0 ? `, ${s.annotationCount} annotations` : ''
            }`}
            data-testid={`screenshot-thumb-${i}`}
          >
            {urls.get(s.id) ? (
              <img src={urls.get(s.id)} alt="" className="txx-shot-thumb-img" />
            ) : null}
          </button>
          <button
            type="button"
            className="txx-shot-delete"
            onClick={() => onDelete(s.id)}
            aria-label={`Delete screenshot ${i + 1}`}
            data-testid={`screenshot-delete-${i}`}
          >
            ×
          </button>
        </div>
      ))}
      {shots.length < MAX_SCREENSHOTS ? (
        <button
          type="button"
          className="txx-shot-add"
          onClick={onAdd}
          disabled={adding}
          aria-label="Add another screenshot"
          data-testid="screenshot-add"
        >
          ＋<span className="txx-shot-add-label">Add</span>
        </button>
      ) : null}
    </div>
  );
}
