// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Pure geometry core of the focus manager: given the currently-focused
// rect and the rects of every other focusable, pick which one an arrow
// press should land on. Kept free of DOM types so it unit-tests in node.

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Candidate<T> {
  id: T;
  rect: Rect;
}

const centerOf = (r: Rect) => ({
  x: r.left + r.width / 2,
  y: r.top + r.height / 2,
});

/**
 * Nearest-neighbour spatial navigation. A candidate qualifies when its
 * center lies strictly beyond the current center in the pressed direction;
 * among qualifiers the one with the lowest score wins, where score =
 * distance along the movement axis + 2.5x the off-axis offset. The off-axis
 * penalty keeps a whole row/column feeling like a row/column: pressing
 * "right" prefers the tile beside you over a nearer tile one row down.
 * Returns null when nothing lies in that direction (focus stays put).
 */
export function pickNextFocus<T>(
  current: Rect,
  candidates: ReadonlyArray<Candidate<T>>,
  direction: Direction,
): T | null {
  const from = centerOf(current);
  let bestId: T | null = null;
  let bestScore = Infinity;

  for (const { id, rect } of candidates) {
    const to = centerOf(rect);
    const dx = to.x - from.x;
    const dy = to.y - from.y;

    let primary: number;
    let ortho: number;
    switch (direction) {
      case 'left':
        primary = -dx;
        ortho = Math.abs(dy);
        break;
      case 'right':
        primary = dx;
        ortho = Math.abs(dy);
        break;
      case 'up':
        primary = -dy;
        ortho = Math.abs(dx);
        break;
      case 'down':
        primary = dy;
        ortho = Math.abs(dx);
        break;
    }

    if (primary <= 0) continue; // not in that direction

    const score = primary + ortho * 2.5;
    if (score < bestScore) {
      bestScore = score;
      bestId = id;
    }
  }

  return bestId;
}
