// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import {
  EMPTY_HISTORY,
  HISTORY_CAP,
  newAnnotationId,
  normalizeBox,
  pushHistory,
  redoHistory,
  translateAnnotation,
  undoHistory,
  type Annotation,
} from '../../src/reporter-ui/annotation-model.js';

const pen = (id: string): Annotation => ({
  id,
  kind: 'pen',
  points: [0, 0, 10, 10],
  color: '#FF3B30',
  thickness: 4,
});

describe('annotation-model', () => {
  it('newAnnotationId returns unique ids', () => {
    const a = newAnnotationId();
    const b = newAnnotationId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('pushHistory appends a snapshot and clears the redo future', () => {
    const h1 = pushHistory(EMPTY_HISTORY, [pen('a1')]);
    expect(h1.past).toHaveLength(1);
    const undone = undoHistory(h1, [pen('a1'), pen('a2')]);
    expect(undone).not.toBeNull();
    // A fresh push after an undo clears future (standard undo/redo).
    const h2 = pushHistory(undone!.history, [pen('a3')]);
    expect(h2.future).toHaveLength(0);
  });

  it('pushHistory caps past at HISTORY_CAP snapshots', () => {
    let h = EMPTY_HISTORY;
    for (let i = 0; i < HISTORY_CAP + 10; i++) h = pushHistory(h, [pen(`a${i}`)]);
    expect(h.past).toHaveLength(HISTORY_CAP);
  });

  it('undo/redo round-trips annotations', () => {
    const before: Annotation[] = [];
    const after = [pen('a1')];
    const h = pushHistory(EMPTY_HISTORY, before);
    const u = undoHistory(h, after);
    expect(u!.annotations).toEqual(before);
    const r = redoHistory(u!.history, u!.annotations as Annotation[]);
    expect(r!.annotations).toEqual(after);
  });

  it('undoHistory returns null when past is empty', () => {
    expect(undoHistory(EMPTY_HISTORY, [])).toBeNull();
    expect(redoHistory(EMPTY_HISTORY, [])).toBeNull();
  });

  it('normalizeBox flips negative width/height', () => {
    expect(normalizeBox({ x: 10, y: 10, width: -4, height: -6 })).toEqual({
      x: 6,
      y: 4,
      width: 4,
      height: 6,
    });
  });

  it('translateAnnotation shifts every kind by (dx, dy)', () => {
    expect(
      translateAnnotation(
        { id: 'a', kind: 'pen', points: [1, 2, 3, 4], color: '#000', thickness: 2 },
        10,
        20,
      ),
    ).toMatchObject({ points: [11, 22, 13, 24] });
    expect(
      translateAnnotation(
        { id: 'a', kind: 'rect', x: 1, y: 2, width: 5, height: 5, color: '#000', thickness: 2 },
        10,
        20,
      ),
    ).toMatchObject({ x: 11, y: 22 });
    expect(
      translateAnnotation(
        { id: 'a', kind: 'arrow', from: [1, 2], to: [3, 4], color: '#000', thickness: 2 },
        10,
        20,
      ),
    ).toMatchObject({ from: [11, 22], to: [13, 24] });
    expect(
      translateAnnotation(
        { id: 'a', kind: 'text', x: 1, y: 2, text: 'hi', color: '#000', fontSize: 16 },
        10,
        20,
      ),
    ).toMatchObject({ x: 11, y: 22 });
    expect(
      translateAnnotation({ id: 'a', kind: 'blur', x: 1, y: 2, width: 5, height: 5 }, 10, 20),
    ).toMatchObject({ x: 11, y: 22 });
  });
});
