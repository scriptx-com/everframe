// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import {
  truncateMiddle,
  crumbCost,
  isStructural,
  ENTRY_OVERHEAD,
  BREADCRUMB_BYTE_BUDGET,
  CONSOLE_ENTRY_CAP,
  trimBreadcrumbs,
  isTrimMarker,
  MAX_TRIMMED_ENTRIES,
} from '../src/breadcrumbs/trim.js';
import type { Breadcrumb } from '@traceitx/protocol';

const mk = (over: Partial<Breadcrumb> & { kind: Breadcrumb['kind'] }): Breadcrumb => ({
  t: 1, seq: 0, message: 'm', ...over,
});

describe('constants', () => {
  it('locks the spec defaults', () => {
    expect(BREADCRUMB_BYTE_BUDGET).toBe(16384);
    expect(CONSOLE_ENTRY_CAP).toBe(1024);
  });
});

describe('truncateMiddle', () => {
  it('returns the message unchanged at or under the cap', () => {
    expect(truncateMiddle('abc', 3)).toEqual({ message: 'abc', truncated: false });
  });

  it('splices head+tail halves with a dropped-count marker', () => {
    // 30 chars, cap 20 → first 10 + marker + last 10, 10 dropped.
    const out = truncateMiddle('a'.repeat(15) + 'b'.repeat(15), 20);
    expect(out.truncated).toBe(true);
    expect(out.message).toBe('a'.repeat(10) + '…[+10 chars]…' + 'b'.repeat(10));
  });

  it('spec default: 1 KB cap keeps first 512 + last 512', () => {
    const out = truncateMiddle('x'.repeat(3000), CONSOLE_ENTRY_CAP);
    expect(out.message.startsWith('x'.repeat(512) + '…[+1976 chars]…')).toBe(true);
    expect(out.message.endsWith('x'.repeat(512))).toBe(true);
  });
});

describe('surrogate-split characterization (accepted platform divergence)', () => {
  it('JS .slice() keeps the lone high surrogate when the UTF-16 cut splits a pair (spec 2026-07-08 ruling; Swift substitutes U+FFFD — see BreadcrumbTrimTests.swift)', () => {
    // 511 'a' + '😀' (0xD83D 0xDE00) + 600 'b' = 1113 UTF-16 units, run through
    // the trim entry point with consoleEntryCap 1024 (huge byteBudget so only
    // the console cap fires). half = 512, so the head keeps units [0..511];
    // unit 511 is the emoji's high surrogate and its low-surrogate partner
    // (unit 512) is dropped, splitting the pair. JS .slice() has no notion of
    // surrogate pairs, so it keeps the lone high surrogate verbatim.
    const message = 'a'.repeat(511) + '😀' + 'b'.repeat(600);
    const crumb = mk({ kind: 'console', t: 1, seq: 0, message });
    const [out] = trimBreadcrumbs([crumb], { consoleEntryCap: 1024, byteBudget: 10_000_000 });
    expect(out!.truncated).toBe(true);
    expect(out!.message.charCodeAt(511)).toBe(0xd83d);
  });
});

describe('crumbCost', () => {
  it('costs overhead + message length with no data', () => {
    expect(crumbCost(mk({ kind: 'tap', message: 'hello' }))).toBe(ENTRY_OVERHEAD + 5);
  });

  it('costs data recursively: string=length, number/bool=8, null=4, +2 per entry, +2 per container', () => {
    const crumb = mk({
      kind: 'network', message: '', // 0
      data: { method: 'GET', status: 500 }, // 2 + (6+3+2) + (6+8+2) = 29
    });
    expect(crumbCost(crumb)).toBe(ENTRY_OVERHEAD + 0 + 29);
  });
});

describe('isStructural', () => {
  it('navigation/tap/lifecycle/error/custom are structural; console/network are bulky', () => {
    for (const k of ['navigation', 'tap', 'lifecycle', 'error', 'custom'] as const) {
      expect(isStructural(k)).toBe(true);
    }
    expect(isStructural('console')).toBe(false);
    expect(isStructural('network')).toBe(false);
  });
});

describe('trimBreadcrumbs', () => {
  const nav = (t: number, seq: number): Breadcrumb =>
    mk({ kind: 'navigation', t, seq, message: 'nav-to-home' }); // cost 64+11 = 75
  const con = (t: number, seq: number, len = 40): Breadcrumb =>
    mk({ kind: 'console', t, seq, message: 'c'.repeat(len) }); // len 40 → cost 104

  it('returns [] for empty input (no markers)', () => {
    expect(trimBreadcrumbs([])).toEqual([]);
  });

  it('passes through unchanged when under budget', () => {
    const input = [nav(1, 0), con(2, 1)];
    expect(trimBreadcrumbs(input)).toEqual(input);
  });

  it('evicts oldest bulky first and emits a count marker at the dropped position', () => {
    // costs: 75 + 104 + 104 = 283 > budget 250 → evict console(t=2) only.
    const out = trimBreadcrumbs([nav(1, 0), con(2, 1), con(3, 2)], {
      byteBudget: 250, consoleEntryCap: 100,
    });
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(nav(1, 0));
    expect(out[1]).toMatchObject({
      t: 2, seq: 1, kind: 'console', level: 'info',
      message: '+1 console hidden', data: { droppedCount: 1 },
    });
    expect(out[2]).toEqual(con(3, 2));
  });

  it('never evicts a bulky crumb before exhausting older bulky ones (structural last resort)', () => {
    // 3 taps, 73 each (message 9 chars) = 219 > budget 100. No bulky to evict →
    // evict the two oldest taps; newest tap is must-keep.
    const tap = (t: number, seq: number): Breadcrumb =>
      mk({ kind: 'tap', t, seq, message: 'tap-btn-x' });
    const out = trimBreadcrumbs([tap(1, 0), tap(2, 1), tap(3, 2)], { byteBudget: 100 });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'tap', message: '+2 tap hidden', data: { droppedCount: 2 } });
    expect(out[0]!.t).toBe(2); // stamped as the newest dropped, sorts before the kept tap
    expect(out[1]).toEqual(tap(3, 2));
  });

  it('always keeps the newest entry of EVERY kind even over budget', () => {
    const out = trimBreadcrumbs([nav(1, 0), con(2, 1)], { byteBudget: 10 });
    expect(out).toEqual([nav(1, 0), con(2, 1)]); // both are newest-of-kind: untouchable
  });

  it('applies the console middle-splice before budgeting and flags truncated', () => {
    const out = trimBreadcrumbs([con(1, 0, 30)], { consoleEntryCap: 20 });
    expect(out[0]).toMatchObject({ truncated: true });
    expect(out[0]!.message).toBe('c'.repeat(10) + '…[+10 chars]…' + 'c'.repeat(10));
  });

  it('caps error stackDigest at 10 lines (spec §4.2)', () => {
    const digest = Array.from({ length: 12 }, (_, i) => `at f${i}`).join('\n');
    const out = trimBreadcrumbs([mk({ kind: 'error', data: { stackDigest: digest } })]);
    expect(out[0]).toMatchObject({ truncated: true });
    expect((out[0]!.data as { stackDigest: string }).stackDigest.split('\n')).toHaveLength(10);
    expect((out[0]!.data as { stackDigest: string }).stackDigest.endsWith('at f9')).toBe(true);
  });

  it('sorts output by (t, seq)', () => {
    const out = trimBreadcrumbs([con(5, 1), nav(5, 0), nav(2, 2)]);
    expect(out.map((c) => [c.t, c.seq])).toEqual([[2, 2], [5, 0], [5, 1]]);
  });

  it('locks MAX_TRIMMED_ENTRIES = 121 (128 protocol maxItems − 7 worst-case markers)', () => {
    expect(MAX_TRIMMED_ENTRIES).toBe(121);
  });

  it('enforces the protocol 128-entry ceiling even when under the byte budget', () => {
    // 200 cheap same-kind crumbs, effectively unlimited byte budget: the byte
    // pass evicts nothing, so the count pass must bring kept down to 121.
    const taps = Array.from({ length: 200 }, (_, i) =>
      mk({ kind: 'tap', t: i + 1, seq: i, message: 'tap-btn-x' })
    );
    const out = trimBreadcrumbs(taps, { byteBudget: 10_000_000 });
    expect(out.length).toBeLessThanOrEqual(128);

    const markers = out.filter(isTrimMarker);
    const kept = out.filter((c) => !isTrimMarker(c));
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      kind: 'tap', message: '+79 tap hidden', data: { droppedCount: 79 },
    });
    // Kept entries are exactly the NEWEST 121 (t=80..200).
    expect(kept).toHaveLength(MAX_TRIMMED_ENTRIES);
    expect(kept[0]!.t).toBe(80);
    expect(kept[kept.length - 1]!.t).toBe(200);
    // Marker is stamped with the newest dropped entry (t=79) so it sorts first.
    expect(markers[0]!.t).toBe(79);
  });

  it('locks a combined byte-eviction + count-cap run identically across TS/Swift/Kotlin (Task 3)', () => {
    // 130 tap crumbs (cheap, structural) + 5 console crumbs (bulky; each
    // 1500-char message middle-splices to 1038 chars under consoleEntryCap
    // before costing, so each console entry costs 64+1038=1102). Total cost
    // 130*71 + 5*1102 = 14740 > byteBudget 12000, so the byte pass evicts the
    // 3 oldest consoles (t=200,201,202) to bring total to 11434. That leaves
    // 132 kept entries (130 taps + 2 consoles) — still over MAX_TRIMMED_ENTRIES
    // (121), so the count-cap pass continues down the SAME eviction order
    // (bulky first, then structural): it evicts one more console (t=203) then
    // 10 of the oldest taps (t=1..10), landing at exactly 121 kept. Numbers
    // below are hard-coded from the actual TS run (see fixture __semantics);
    // Swift/Kotlin port these same numbers as a cross-language lock-in.
    const taps = Array.from({ length: 130 }, (_, i) =>
      mk({ kind: 'tap', t: i + 1, seq: i, message: 'tap-btn' })
    );
    const consoles = Array.from({ length: 5 }, (_, i) =>
      mk({ kind: 'console', t: 200 + i, seq: 200 + i, message: 'c'.repeat(1500) })
    );
    const input = [...taps, ...consoles];
    const out = trimBreadcrumbs(input, { byteBudget: 12000, consoleEntryCap: 1024 });

    const markers = out.filter(isTrimMarker);
    const kept = out.filter((c) => !isTrimMarker(c));

    expect(out.length).toBeLessThanOrEqual(MAX_TRIMMED_ENTRIES + markers.length);
    expect(kept.length).toBeLessThanOrEqual(MAX_TRIMMED_ENTRIES);

    // Exactly one marker per kind that lost entries — both kinds lost entries,
    // proving the run passed through both the byte-eviction AND count-cap logic.
    expect(markers).toHaveLength(2);
    const consoleMarker = markers.find((m) => m.kind === 'console');
    const tapMarker = markers.find((m) => m.kind === 'tap');
    expect(consoleMarker).toBeDefined();
    expect(tapMarker).toBeDefined();

    // Conservation: every one of the 135 input entries is either kept or
    // accounted for by exactly one marker's droppedCount.
    const consoleDropped = (consoleMarker!.data as { droppedCount: number }).droppedCount;
    const tapDropped = (tapMarker!.data as { droppedCount: number }).droppedCount;
    expect(consoleDropped + tapDropped + kept.length).toBe(135);

    // Recorded concrete outcome (the numbers ported verbatim to Swift/Kotlin).
    expect(kept.length).toBe(121);
    expect(consoleDropped).toBe(4);
    expect(tapDropped).toBe(10);
    expect(consoleMarker).toMatchObject({
      t: 203, seq: 203, kind: 'console', data: { droppedCount: 4 },
    });
    expect(tapMarker).toMatchObject({
      t: 10, seq: 9, kind: 'tap', data: { droppedCount: 10 },
    });

    // Must-keep: the newest tap (t=130) survives even though its kind lost entries.
    expect(kept.some((c) => c.kind === 'tap' && c.t === 130)).toBe(true);

    // NOTE on a tempting-but-false "sanity check": flipping byteBudget to a
    // huge value on THIS SAME 135-entry input does NOT make the console
    // marker vanish. The count-cap pass reuses the identical bulky-before-
    // structural eviction order as the byte pass, and 135-121=14 entries must
    // be evicted regardless of budget — since only 4 non-must-keep consoles
    // exist, all 4 are evicted by the count-cap pass alone even with an
    // effectively infinite byte budget. Verified below: the outcome is
    // byte-budget-invariant for this input shape. The genuine byte-pass-fired
    // sanity check (a separate input where count-cap can never engage) is the
    // sibling test right after this one.
    const outHugeBudget = trimBreadcrumbs(input, { byteBudget: 10_000_000, consoleEntryCap: 1024 });
    const markersHugeBudget = outHugeBudget.filter(isTrimMarker);
    const consoleMarkerHugeBudget = markersHugeBudget.find((m) => m.kind === 'console');
    expect(consoleMarkerHugeBudget).toMatchObject({
      t: 203, seq: 203, kind: 'console', data: { droppedCount: 4 },
    });
  });

  it('sanity: the byte-eviction pass genuinely responds to byteBudget when count-cap cannot engage', () => {
    // Only 6 total entries — far under MAX_TRIMMED_ENTRIES (121), so the
    // count-cap pass can never fire here regardless of byteBudget. This
    // isolates the byte-eviction pass: a tight budget forces console
    // eviction; a huge budget evicts nothing at all. This is what proves the
    // byte-eviction code path is real and budget-driven (the combined test
    // above cannot show this in isolation — see the NOTE there).
    const taps = Array.from({ length: 3 }, (_, i) =>
      mk({ kind: 'tap', t: i + 1, seq: i, message: 'tap-btn' })
    );
    const consoles = Array.from({ length: 3 }, (_, i) =>
      mk({ kind: 'console', t: 200 + i, seq: 200 + i, message: 'c'.repeat(1500) })
    );
    const input = [...taps, ...consoles];

    const tight = trimBreadcrumbs(input, { byteBudget: 2000, consoleEntryCap: 1024 });
    const tightMarkers = tight.filter(isTrimMarker);
    expect(tightMarkers).toHaveLength(1);
    expect(tightMarkers[0]).toMatchObject({
      t: 201, seq: 201, kind: 'console', data: { droppedCount: 2 },
    });

    const huge = trimBreadcrumbs(input, { byteBudget: 10_000_000, consoleEntryCap: 1024 });
    expect(huge.filter(isTrimMarker)).toHaveLength(0);
    expect(huge).toHaveLength(6); // nothing evicted at all
  });
});

describe('isTrimMarker', () => {
  it('discriminates on numeric data.droppedCount', () => {
    expect(isTrimMarker(mk({ kind: 'console', data: { droppedCount: 3 } }))).toBe(true);
    expect(isTrimMarker(mk({ kind: 'console', data: { droppedCount: 'x' } }))).toBe(false);
    expect(isTrimMarker(mk({ kind: 'console' }))).toBe(false);
  });
});
