// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
// The scrub is the largest share of the synchronous snapshot block on a
// Chrome 53 TV (~1 ms per element with an inline style, measured on webOS 4).
// TV pages repeat the same inline styles, class lists, labels and asset URLs
// on every tile, so results are memoized per snapshot. The memo must change
// nothing but the time.
import { afterEach, describe, expect, it } from 'vitest';
import { __setScrubMemoForTests, collectRetainedIds, scrubSnapshotTree } from '../../../src/capture/tv-snapshot/snapshot-scrub.js';
import { SCRUB_MEMO_MAX_ENTRIES } from '../../../src/capture/tv-snapshot/css-scrub.js';
import type { SnDocument } from '../../../src/capture/tv-snapshot/sn-types.js';
import { doc, el, resetIds, text } from './sn-builders.js';
import { findLeaks } from './leak-assert.js';

afterEach(() => __setScrubMemoForTests(true));

const STYLES = Array.from(
  { length: 8 },
  (_, k) => `display:inline-block;width:${100 + k}px;height:40px;margin:4px 8px;background:#${k}${k}${k};color:#fff;font:14px/1.2 sans-serif;border-radius:4px;transform:translateX(${k}px)`,
);
const SECRETS = ['Alice Smith', 'alice@example.test', 'SECRET'];

/** ~1,000 tiles with repeated inline styles, plus leak-bearing values the scrub must still remove. */
function page(unique = false): SnDocument {
  resetIds();
  const items = [];
  for (let i = 0; i < 1000; i++) {
    const style = unique ? `${STYLES[i % 8]};z-index:${i}` : STYLES[i % 8]!;
    const leaky = i % 50 === 0;
    items.push(
      el('div', { class: `tile tile-${i % 8}`, style: leaky ? `${style};--who:Alice Smith;background:url(https://evil.test/x?t=SECRET)` : style }, [
        el('img', { src: leaky ? '/u/alice@example.test/p.png?t=SECRET' : `/posters/${i % 20}.png` }),
        el('span', { class: 'label', title: 'Alice Smith' }, [text(leaky ? 'mail alice@example.test' : `Tile ${i % 20}`)]),
      ]),
    );
  }
  return doc(el('html', {}, [el('head'), el('body', {}, items)])) as SnDocument;
}

function scrub(root: SnDocument, masked: boolean): number {
  const started = performance.now();
  scrubSnapshotTree(root, { masked, retainedIds: collectRetainedIds(root), baseHref: 'https://app.example.test/tv/' });
  return performance.now() - started;
}

function median(xs: number[]): number {
  const sorted = xs.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function timed(memo: boolean, masked: boolean): number {
  __setScrubMemoForTests(memo);
  const runs: number[] = [];
  for (let r = 0; r < 7; r++) runs.push(scrub(page(), masked));
  return median(runs);
}

describe('scrub memo', () => {
  it.each([true, false])('produces byte-identical output with and without the memo (masked=%s)', (masked) => {
    for (const unique of [false, true]) {
      __setScrubMemoForTests(false);
      const plain = page(unique);
      scrub(plain, masked);
      __setScrubMemoForTests(true);
      const memoized = page(unique);
      scrub(memoized, masked);
      expect(JSON.stringify(memoized)).toBe(JSON.stringify(plain));
      expect(findLeaks(JSON.stringify(memoized), masked ? SECRETS : ['SECRET', 'alice@example.test'])).toEqual([]);
    }
  });

  it('scrubs 1,000 styled tiles at least 2x faster than without it (masked page)', () => {
    timed(true, true); // warm up both paths
    timed(false, true);
    const before = timed(false, true);
    const after = timed(true, true);
    console.info(`[scrub-memo] 1,000 tiles, masked: ${before.toFixed(1)} ms → ${after.toFixed(1)} ms`);
    expect(after * 2).toBeLessThanOrEqual(before);
  });

  it('stays bounded: a page of unique values stops growing the memo at the cap, output unchanged', () => {
    const make = (): SnDocument => {
      resetIds();
      const items = [];
      for (let i = 0; i < SCRUB_MEMO_MAX_ENTRIES + 200; i++) items.push(el('b', { class: `c${i}` }, [text(`t${i}`)]));
      return doc(el('html', {}, [el('head'), el('body', {}, items)])) as SnDocument;
    };
    __setScrubMemoForTests(false);
    const plain = make();
    scrub(plain, true);
    __setScrubMemoForTests(true);
    const memoized = make();
    scrub(memoized, true);
    expect(JSON.stringify(memoized)).toBe(JSON.stringify(plain));
  });
});
