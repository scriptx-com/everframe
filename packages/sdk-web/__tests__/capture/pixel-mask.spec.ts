// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectSensitiveRects,
  paintViewportRects,
  rectsMoved,
  type ViewportRect,
} from '../../src/capture/pixel-mask.js';

const SENS = 'data-everframe-sensitive';
const bySensAttr = (el: Element): boolean => el.hasAttribute(SENS);

const rect = (x: number, y: number, width: number, height: number): DOMRect =>
  ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height }) as DOMRect;

/** jsdom has no layout: give `el` fixed client rects (per line box). */
function boxes(el: Element, ...list: DOMRect[]): void {
  el.getClientRects = () => list as unknown as DOMRectList;
  el.getBoundingClientRect = () => list[0] ?? rect(0, 0, 0, 0);
}

/** Text-node geometry, served through document.createRange(). */
function textBoxes(map: Map<Node, DOMRect[]>): void {
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    let node: Node | null = null;
    return {
      selectNodeContents: (n: Node) => {
        node = n;
      },
      getClientRects: () => (map.get(node!) ?? []) as unknown as DOMRectList,
    } as unknown as Range;
  });
}

const plain = (r: DOMRect): ViewportRect => ({ x: r.left, y: r.top, width: r.width, height: r.height });

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('collectSensitiveRects', () => {
  it('covers an inline sensitive element per line box', () => {
    document.body.innerHTML = `<p>Name: <span id="s" ${SENS}>Jane Q. Public</span></p>`;
    const s = document.getElementById('s')!;
    const lines = [rect(100, 10, 80, 20), rect(0, 30, 60, 20)];
    boxes(s, ...lines);
    textBoxes(new Map([[s.firstChild!, lines]]));
    const out = collectSensitiveRects(document.body, bySensAttr);
    expect(out).toContainEqual(plain(lines[0]!));
    expect(out).toContainEqual(plain(lines[1]!));
  });

  it('covers a display:contents wrapper through its text runs and element children', () => {
    document.body.innerHTML = `<p><span id="w" ${SENS} style="display:contents">9988 <b id="b">7766</b></span></p>`;
    const w = document.getElementById('w')!;
    const b = document.getElementById('b')!;
    boxes(w); // no box of its own
    boxes(b, rect(60, 0, 40, 20));
    textBoxes(
      new Map<Node, DOMRect[]>([
        [w.firstChild!, [rect(10, 0, 50, 20)]],
        [b.firstChild!, [rect(60, 0, 40, 20)]],
      ]),
    );
    const out = collectSensitiveRects(document.body, bySensAttr);
    expect(out).toContainEqual({ x: 10, y: 0, width: 50, height: 20 });
    expect(out).toContainEqual({ x: 60, y: 0, width: 40, height: 20 });
  });

  it('covers the content assigned to a sensitive <slot>, not the slot fallback', () => {
    const host = document.createElement('div');
    host.innerHTML = '<span id="slotted">PIN 4455</span>';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<i id="label">Label</i><slot ${SENS}><em id="fallback">none</em></slot>`;
    document.body.appendChild(host);
    const slotted = host.querySelector('#slotted')!;
    boxes(slotted, rect(40, 5, 70, 20));
    boxes(shadow.getElementById('fallback')!, rect(500, 500, 10, 10));
    textBoxes(new Map([[slotted.firstChild!, [rect(40, 5, 70, 20)]]]));
    const out = collectSensitiveRects(document.body, bySensAttr);
    expect(out).toContainEqual({ x: 40, y: 5, width: 70, height: 20 });
    expect(out.some((r) => r.x === 500)).toBe(false);
  });

  it('finds a sensitive element inside an open shadow root', () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<div id="card" ${SENS}>4111</div><div id="ok">fine</div>`;
    document.body.appendChild(host);
    boxes(shadow.getElementById('card')!, rect(5, 6, 100, 30));
    boxes(shadow.getElementById('ok')!, rect(5, 40, 100, 30));
    textBoxes(new Map());
    const out = collectSensitiveRects(document.body, bySensAttr);
    expect(out).toEqual([{ x: 5, y: 6, width: 100, height: 30 }]);
  });

  it('yields the full rect of a sensitive capture root', () => {
    document.body.innerHTML = `<img id="img" ${SENS} />`;
    const img = document.getElementById('img')!;
    boxes(img, rect(24, 300, 120, 60));
    const out = collectSensitiveRects(img, bySensAttr);
    expect(out).toContainEqual({ x: 24, y: 300, width: 120, height: 60 });
  });

  it('clips descendants to a sensitive scroller: public content below stays unmasked', () => {
    document.body.innerHTML = `<div id="sc" ${SENS} style="overflow-x:auto;overflow-y:auto;height:100px"><div id="tall">x</div></div>`;
    const sc = document.getElementById('sc')!;
    const tall = document.getElementById('tall')!;
    boxes(sc, rect(0, 50, 300, 100));
    boxes(tall, rect(0, 50, 300, 2000));
    textBoxes(new Map([[tall.firstChild!, [rect(0, 1500, 20, 20)]]]));
    const out = collectSensitiveRects(document.body, bySensAttr);
    expect(out).toContainEqual({ x: 0, y: 50, width: 300, height: 100 });
    // Nothing reaches below the scroller's box; the scrolled-away text is gone.
    expect(Math.max(...out.map((r) => r.y + r.height))).toBe(150);
  });

  it('clips only the overflowing axis, and never an absolute/fixed descendant', () => {
    document.body.innerHTML =
      `<div id="sc" ${SENS} style="overflow-x:hidden;overflow-y:visible"><div id="wide">w</div><div id="abs" style="position:absolute">a</div></div>`;
    // (jsdom does not expand the `overflow` shorthand: longhands throughout.)
    boxes(document.getElementById('sc')!, rect(10, 10, 100, 50));
    boxes(document.getElementById('wide')!, rect(10, 10, 500, 400));
    boxes(document.getElementById('abs')!, rect(600, 600, 40, 40));
    textBoxes(new Map());
    const out = collectSensitiveRects(document.body, bySensAttr);
    expect(out).toContainEqual({ x: 10, y: 10, width: 100, height: 400 });
    expect(out).toContainEqual({ x: 600, y: 600, width: 40, height: 40 });
  });

  it('skips subtrees the capture excludes, even when they are sensitive', () => {
    document.body.innerHTML = `<div id="badge" data-everframe-skip-capture="true" ${SENS}><span id="pin">1234</span></div><div id="s" ${SENS}>x</div>`;
    boxes(document.getElementById('badge')!, rect(500, 500, 100, 40));
    boxes(document.getElementById('pin')!, rect(510, 505, 40, 20));
    boxes(document.getElementById('s')!, rect(0, 0, 10, 10));
    textBoxes(new Map());
    const out = collectSensitiveRects(document.body, bySensAttr, (el) => el.getAttribute('data-everframe-skip-capture') === 'true');
    expect(out).toEqual([{ x: 0, y: 0, width: 10, height: 10 }]);
  });

  it('grows sensitive text runs by their text-shadow (per side) and stroke', () => {
    document.body.innerHTML = `<p id="p" ${SENS}>SECRET</p>`;
    const p = document.getElementById('p')!;
    boxes(p);
    // jsdom computes neither property: serve the browser's computed form.
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
      if (el !== p) return real(el);
      const props: Record<string, string> = {
        'text-shadow': 'rgba(0, 0, 0, 0.5) 3px 40px 2px',
        '-webkit-text-stroke-width': '1px',
      };
      return { position: 'static', overflowX: 'visible', overflowY: 'visible', getPropertyValue: (k: string) => props[k] ?? '' } as unknown as CSSStyleDeclaration;
    });
    textBoxes(new Map([[p.firstChild!, [rect(100, 100, 60, 20)]]]));
    const out = collectSensitiveRects(document.body, bySensAttr);
    // left: max(stroke 1, blur 2 - 3) = 1; right: 2 + 3 = 5; top: max(1, 2 - 40) = 1; bottom: 2 + 40 = 42
    expect(out).toEqual([{ x: 99, y: 99, width: 66, height: 63 }]);
  });

  it('treats a throwing predicate as sensitive', () => {
    document.body.innerHTML = '<div id="d">x</div>';
    boxes(document.getElementById('d')!, rect(1, 2, 3, 4));
    boxes(document.body, rect(0, 0, 800, 600));
    textBoxes(new Map());
    const out = collectSensitiveRects(document.body, () => {
      throw new Error('boom');
    });
    expect(out).toContainEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it('returns nothing when nothing is sensitive', () => {
    document.body.innerHTML = '<div>x</div>';
    expect(collectSensitiveRects(document.body, bySensAttr)).toEqual([]);
  });
});

describe('rectsMoved', () => {
  const a = [{ x: 0, y: 0, width: 10, height: 10 }];
  it('ignores sub-half-pixel jitter', () => {
    expect(rectsMoved(a, [{ x: 0.4, y: 0, width: 10, height: 10.2 }])).toBe(false);
  });
  it('flags movement and count changes', () => {
    expect(rectsMoved(a, [{ x: 0, y: 3, width: 10, height: 10 }])).toBe(true);
    expect(rectsMoved(a, [])).toBe(true);
  });
});

describe('paintViewportRects', () => {
  function fakeCanvas(): { canvas: HTMLCanvasElement; fills: number[][] } {
    const fills: number[][] = [];
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      fillRect: (...args: number[]) => fills.push(args),
    };
    const canvas = { getContext: () => ctx } as unknown as HTMLCanvasElement;
    return { canvas, fills };
  }

  it('maps viewport CSS px to device px, inflated by 2 CSS px and rounded outward', () => {
    const { canvas, fills } = fakeCanvas();
    expect(paintViewportRects(canvas, [{ x: 10.3, y: 20, width: 30, height: 15.5 }], 2)).toBe(true);
    // x: floor((10.3-2)*2)=16 .. ceil((10.3+30+2)*2)=85; y: 36 .. ceil(37.5*2)=75
    expect(fills).toEqual([[16, 36, 69, 39]]);
  });

  it('paints every rect at every renderer offset', () => {
    const { canvas, fills } = fakeCanvas();
    paintViewportRects(
      canvas,
      [{ x: 10, y: 10, width: 10, height: 10 }],
      1,
      [
        { dx: 0, dy: 0 },
        { dx: -8, dy: -8 },
        { dx: -24, dy: -100 },
      ],
    );
    expect(fills).toEqual([
      [8, 8, 14, 14],
      [0, 0, 14, 14],
      [-16, -92, 14, 14],
    ]);
  });

  it('needs no context when nothing is sensitive, and fails closed without one', () => {
    const none = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(paintViewportRects(none, [], 1)).toBe(true);
    expect(paintViewportRects(none, [{ x: 0, y: 0, width: 1, height: 1 }], 1)).toBe(false);
  });
});

// Chrome < 61 (webOS 4) returns ClientRect objects: left/top/right/bottom/
// width/height, and NO x/y. Masks must land from left/top, and a box with no
// finite position must fail the shot closed, never be skipped.
describe('old-engine ClientRect geometry', () => {
  const clientRect = (left: number, top: number, width: number, height: number): DOMRect =>
    ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;

  it('collects a sensitive box from a ClientRect without x/y, and paints it where it is', () => {
    document.body.innerHTML = '<div id="s" data-everframe-sensitive>PIN</div>';
    const el = document.getElementById('s')!;
    boxes(el, clientRect(40, 30, 120, 30));
    const rects = collectSensitiveRects(document.body, bySensAttr);
    expect(rects).toContainEqual({ x: 40, y: 30, width: 120, height: 30 });
    const fills: number[][] = [];
    const ctx = { save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), fillRect: (...a: number[]) => fills.push(a) };
    expect(paintViewportRects({ getContext: () => ctx } as unknown as HTMLCanvasElement, rects, 1)).toBe(true);
    expect(fills).toContainEqual([38, 28, 124, 34]);
  });

  it('a sensitive box with no finite position yields a rect paintViewportRects refuses (fail closed)', () => {
    document.body.innerHTML = '<div id="s" data-everframe-sensitive>PIN</div>';
    const el = document.getElementById('s')!;
    boxes(el, { width: 120, height: 30 } as DOMRect);
    const rects = collectSensitiveRects(document.body, bySensAttr);
    expect(rects.length).toBeGreaterThan(0);
    const fills: number[][] = [];
    const ctx = { save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), fillRect: (...a: number[]) => fills.push(a) };
    expect(paintViewportRects({ getContext: () => ctx } as unknown as HTMLCanvasElement, rects, 1)).toBe(false);
    expect(fills).toEqual([]);
  });

  it('refuses a non-finite rect or offset outright', () => {
    const ctx = { save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), fillRect: vi.fn() };
    const canvas = { getContext: () => ctx } as unknown as HTMLCanvasElement;
    expect(paintViewportRects(canvas, [{ x: Number.NaN, y: 0, width: 1, height: 1 }], 1)).toBe(false);
    expect(paintViewportRects(canvas, [{ x: 0, y: 0, width: 1, height: 1 }], 1, [{ dx: Number.NaN, dy: 0 }])).toBe(false);
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });
});

