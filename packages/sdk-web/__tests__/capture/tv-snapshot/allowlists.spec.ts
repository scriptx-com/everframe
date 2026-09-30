// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import {
  ARIA_STATE_VALUES,
  isAllowedSvgAttr,
  isCssColor,
  isPathData,
} from '../../../src/capture/tv-snapshot/allowlists.js';

const ids = new Set(['g', 'play']);

describe('ARIA state values', () => {
  it('enumerates the six styling-relevant states', () => {
    expect(Object.keys(ARIA_STATE_VALUES).sort()).toEqual(
      ['aria-checked', 'aria-current', 'aria-disabled', 'aria-expanded', 'aria-pressed', 'aria-selected'],
    );
    expect(ARIA_STATE_VALUES['aria-current']!.has('page')).toBe(true);
    expect(ARIA_STATE_VALUES['aria-current']!.has('Alice')).toBe(false);
  });
});

describe('SVG attribute allowlist', () => {
  it('keeps geometry, paint and references to retained ids', () => {
    expect(isAllowedSvgAttr('viewBox', '0 0 24 24', ids)).toBe(true);
    expect(isAllowedSvgAttr('points', '0,0 10,5 0,10', ids)).toBe(true);
    expect(isAllowedSvgAttr('cx', '12.5', ids)).toBe(true);
    expect(isAllowedSvgAttr('transform', 'translate(2, 3) rotate(45)', ids)).toBe(true);
    expect(isAllowedSvgAttr('fill', 'url(#g)', ids)).toBe(true);
    expect(isAllowedSvgAttr('fill', 'rebeccapurple', ids)).toBe(true);
    expect(isAllowedSvgAttr('stroke', '#ff0', ids)).toBe(true);
    expect(isAllowedSvgAttr('stroke-width', '1.5', ids)).toBe(true);
    expect(isAllowedSvgAttr('opacity', '.4', ids)).toBe(true);
    expect(isAllowedSvgAttr('clip-path', 'url(#play)', ids)).toBe(true);
    expect(isAllowedSvgAttr('fill-rule', 'evenodd', ids)).toBe(true);
  });
  it('drops free text in any SVG slot and references to missing ids', () => {
    expect(isAllowedSvgAttr('viewBox', 'Alice Smith', ids)).toBe(false);
    expect(isAllowedSvgAttr('fill', 'Alice', ids)).toBe(false);
    expect(isAllowedSvgAttr('fill', 'url(#missing)', ids)).toBe(false);
    expect(isAllowedSvgAttr('mask', 'url(https://x.test/m.svg#a)', ids)).toBe(false);
    expect(isAllowedSvgAttr('transform', 'Alice(1)', ids)).toBe(false);
    expect(isAllowedSvgAttr('data-name', 'x', ids)).toBe(false);
  });
});

describe('isPathData', () => {
  it('accepts real path data', () => {
    expect(isPathData('M0 0L10 5L0 10z')).toBe(true);
    expect(isPathData('m.5.5 a1 1 0 01 1 1 Z M 3,3 h2')).toBe(true);
  });
  it('rejects words spelled with path-command letters', () => {
    expect(isPathData('call')).toBe(false);
    expect(isPathData('M0 0 all')).toBe(false);
    expect(isPathData('Alice')).toBe(false);
  });
});

describe('isCssColor', () => {
  it('accepts hex, functional, named and keyword colors only', () => {
    for (const c of ['#abc', '#aabbccdd', 'rgb(1, 2, 3)', 'hsla(120deg 50% 50% / .5)', 'Red', 'currentColor', 'none']) {
      expect(isCssColor(c)).toBe(true);
    }
    for (const c of ['Alice', '#ggg', 'rgb(Alice)']) expect(isCssColor(c)).toBe(false);
  });
});

describe('free-text smuggling (hardening)', () => {
  it('rejects colour functions whose arguments spell words', () => {
    for (const c of ['rgb(Dan Grant)', 'rgb(tuna)', 'hsl(1 2 3 4 5)', 'rgb()']) expect(isCssColor(c)).toBe(false);
    expect(isCssColor('rgba(0,0,0,.5)')).toBe(true);
    expect(isCssColor('rgb(0 0 0 / none)')).toBe(true);
  });
  it('matches local references case-insensitively but still requires a retained id', () => {
    expect(isAllowedSvgAttr('fill', 'URL(#g)', ids)).toBe(true);
    expect(isAllowedSvgAttr('fill', 'url(#g) red', ids)).toBe(true);
    expect(isAllowedSvgAttr('fill', 'url(#g) Alice', ids)).toBe(false);
    expect(isAllowedSvgAttr('filter', 'url(#g) x', ids)).toBe(false);
  });
  it('validates transform lists in linear time', () => {
    expect(isAllowedSvgAttr('transform', 'matrix(1,0,0,1,0,0),scale(2)', ids)).toBe(true);
    expect(isAllowedSvgAttr('transform', '', ids)).toBe(false);
    expect(isAllowedSvgAttr('transform', 'rotate(45) Alice', ids)).toBe(false);
    const nearMiss = `${'translate(1)   '.repeat(130)}X`;
    const started = performance.now();
    expect(isAllowedSvgAttr('transform', nearMiss, ids)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('number grammars stay linear on long digit runs', () => {
  const longRun = `${'1'.repeat(20_000)}x`;
  const timed = (fn: () => boolean): { result: boolean; ms: number } => {
    const started = performance.now();
    const result = fn();
    return { result, ms: performance.now() - started };
  };
  it.each([
    ['isCssColor', () => isCssColor(`rgb(${longRun} 0 0)`)],
    ['isCssColor (bare)', () => isCssColor(longRun)],
    ['numeric attr', () => isAllowedSvgAttr('cx', longRun, ids)],
    ['numeric list, long token under the list cap', () => isAllowedSvgAttr('points', `${'1'.repeat(19_000)}x`, ids)],
    ['orient enum', () => isAllowedSvgAttr('orient', longRun, ids)],
    ['path data', () => isPathData(`M${longRun}`)],
  ])('%s rejects in well under a second', (_label, fn) => {
    const { result, ms } = timed(fn);
    expect(result).toBe(false);
    expect(ms).toBeLessThan(1000);
  });
  it('still accepts ordinary numbers after the grammar change', () => {
    expect(isAllowedSvgAttr('orient', '-.5turn', ids)).toBe(true);
    expect(isAllowedSvgAttr('orient', '45', ids)).toBe(true);
    expect(isAllowedSvgAttr('cx', '12.', ids)).toBe(true);
    expect(isCssColor('rgb(10.5 .5 1e2)')).toBe(true);
  });
});
