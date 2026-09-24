// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { MAX_CUSTOM_DATA_BYTES, utf8ByteLength } from '@everframe/protocol';
import { boundJson, boundStructuredJson } from '../../src/vitals/bound-json.js';

describe('boundJson', () => {
  it('passes small values through untouched', () => {
    expect(boundJson({ a: 1, b: 'x' })).toEqual({ data: { a: 1, b: 'x' }, truncated: false });
    expect(boundJson('str')).toEqual({ data: 'str', truncated: false });
    expect(boundJson(undefined)).toEqual({ data: undefined, truncated: false });
  });

  it('truncates an over-cap value into { truncated, preview } that itself fits the cap', () => {
    const big = { log: 'y'.repeat(5000) };
    const out = boundJson(big);
    expect(out.truncated).toBe(true);
    expect(out.data).toMatchObject({ truncated: true });
    expect(typeof (out.data as { preview: string }).preview).toBe('string');
    expect(utf8ByteLength(JSON.stringify(out.data))).toBeLessThanOrEqual(MAX_CUSTOM_DATA_BYTES);
  });

  it('never cuts a multi-byte character in half and re-measures after wrapping (quotes escape)', () => {
    const out = boundJson({ s: '"é"'.repeat(2000) });
    const preview = (out.data as { preview: string }).preview;
    expect(() => JSON.stringify(preview)).not.toThrow();
    expect(preview).not.toMatch(/�/);
    expect(utf8ByteLength(JSON.stringify(out.data))).toBeLessThanOrEqual(MAX_CUSTOM_DATA_BYTES);
  });

  it('marks cyclic or BigInt input as unserializable', () => {
    const cyc: Record<string, unknown> = {}; cyc.self = cyc;
    expect(boundJson(cyc)).toEqual({ data: { unserializable: true }, truncated: true });
    expect(boundJson(10n)).toEqual({ data: { unserializable: true }, truncated: true });
  });

  it('marks a bare function/symbol (JSON.stringify → undefined) as unserializable', () => {
    expect(boundJson(() => 1)).toEqual({ data: { unserializable: true }, truncated: true });
  });

  // Item 2 (codex round 1) — the under-cap path used to return the CALLER's
  // own reference. If the customer mutated it afterwards, the collector's
  // held entry mutated right along with it, silently corrupting an already-
  // bounded entry. `boundJson` must hand back a defensive copy instead.
  it('returns a defensive copy for the under-cap path, not the caller\'s own reference', () => {
    const original = { a: 1, nested: { b: 2 } };
    const out = boundJson(original);
    expect(out.data).toEqual({ a: 1, nested: { b: 2 } });
    expect(out.data).not.toBe(original);

    // Mutate the caller's object after the call, including growing it past
    // the cap and making it cyclic — the returned data must be unaffected.
    (original as Record<string, unknown>).extra = 'x'.repeat(10_000);
    (original as Record<string, unknown>).self = original;
    expect(out.data).toEqual({ a: 1, nested: { b: 2 } });
  });

  it('honours a custom cap', () => {
    expect(boundJson('x'.repeat(100), 50).truncated).toBe(true);
    expect(boundJson('x'.repeat(40), 50).truncated).toBe(false);
  });

  // Fix round: the halving loop's degenerate fallback used to ship a fixed
  // `{ truncated: true, preview: '' }` shell unconditionally, which itself
  // exceeds maxBytes for very small caps (reviewer repro: maxBytes=20 still
  // returned a 31-byte object). The contract is now unconditional: for ANY
  // maxBytes >= 0, `data` either fits or is `undefined` (exempted from the
  // protocol's byte check) — never a shell that itself violates the cap.
  const fitsOrIsUndefined = (out: { data: unknown }, cap: number): boolean =>
    out.data === undefined || utf8ByteLength(JSON.stringify(out.data)) <= cap;

  it('drops the payload entirely when maxBytes is 0 — nothing else can fit', () => {
    const out = boundJson('x'.repeat(100), 0);
    expect(out.truncated).toBe(true);
    expect(fitsOrIsUndefined(out, 0)).toBe(true);
  });

  it('honours the cap even when it cannot hold the fixed preview wrapper (reviewer repro: maxBytes=20)', () => {
    const out = boundJson('x'.repeat(100), 20);
    expect(out.truncated).toBe(true);
    expect(fitsOrIsUndefined(out, 20)).toBe(true);
  });

  it('honours a cap just above the fixed wrapper overhead', () => {
    const out = boundJson('x'.repeat(100), 32);
    expect(out.truncated).toBe(true);
    expect(fitsOrIsUndefined(out, 32)).toBe(true);
  });
});

// Codex round-5 item 3 — the structure-preserving counterpart to `boundJson`
// for player-event payloads: round 4's fix reused `boundJson`, which
// collapses the WHOLE object into an opaque `{ truncated, preview }` shell
// on overflow, losing scalar fields (`code`, `fatal`) a customer's
// structured error needs even when its free-text fields had to be cut.
describe('boundStructuredJson', () => {
  it('passes an under-cap record through untouched, as a defensive copy', () => {
    const original = { message: 'boom', code: 3, fatal: true };
    const out = boundStructuredJson(original, 2048);
    expect(out).toEqual({ data: { message: 'boom', code: 3, fatal: true }, truncated: false });
    expect(out.data).not.toBe(original);
  });

  it('passes undefined through untouched', () => {
    expect(boundStructuredJson(undefined, 2048)).toEqual({ data: undefined, truncated: false });
  });

  it('shrinks only the oversized STRING field, keeping every scalar field intact', () => {
    const out = boundStructuredJson(
      { message: 'x'.repeat(100_000), code: 3, fatal: true },
      2048,
    );
    expect(out.truncated).toBe(true);
    expect(out.data?.code).toBe(3);
    expect(out.data?.fatal).toBe(true);
    expect(typeof out.data?.message).toBe('string');
    expect((out.data?.message as string).length).toBeLessThan(100_000);
    expect(utf8ByteLength(JSON.stringify(out.data))).toBeLessThanOrEqual(2048);
  });

  it('shrinks the LARGEST string field first when there are several', () => {
    const out = boundStructuredJson(
      { message: 'm'.repeat(50_000), detail: 'd'.repeat(5), code: 1 },
      512,
    );
    expect(out.truncated).toBe(true);
    // `detail` (5 bytes) easily fits on its own — it must survive
    // untouched while `message` (the actual oversized field) gets cut.
    expect(out.data?.detail).toBe('ddddd');
    expect(out.data?.code).toBe(1);
    expect(utf8ByteLength(JSON.stringify(out.data))).toBeLessThanOrEqual(512);
  });

  it('never cuts a multi-byte character in half', () => {
    const out = boundStructuredJson({ message: '"é"'.repeat(2000), code: 1 }, 100);
    expect(out.truncated).toBe(true);
    expect(() => JSON.stringify(out.data)).not.toThrow();
    expect(JSON.stringify(out.data)).not.toMatch(/�/);
    expect(utf8ByteLength(JSON.stringify(out.data))).toBeLessThanOrEqual(100);
  });

  it('drops a nested object field that is too expensive to keep, without dropping scalar siblings', () => {
    const out = boundStructuredJson(
      { code: 1, fatal: true, blob: { huge: 'x'.repeat(10_000) } },
      2048,
    );
    expect(out.data?.code).toBe(1);
    expect(out.data?.fatal).toBe(true);
    expect(out.data?.blob).toBeUndefined();
  });

  it('keeps a small nested object field intact', () => {
    const out = boundStructuredJson({ code: 1, meta: { a: 1, b: 2 } }, 2048);
    expect(out).toEqual({ data: { code: 1, meta: { a: 1, b: 2 } }, truncated: false });
  });

  it('marks a cyclic value unserialisable and still bounds the result', () => {
    const cyc: Record<string, unknown> = { code: 1 };
    cyc.self = cyc;
    const out = boundStructuredJson(cyc, 2048);
    expect(out.truncated).toBe(true);
    expect(out.data?.code).toBe(1);
    expect(out.data?.self).toBeUndefined();
  });

  it('drops the payload entirely when maxBytes is too small even for the scalar fields alone', () => {
    const out = boundStructuredJson({ code: 12345, fatal: true, message: 'x'.repeat(1000) }, 5);
    expect(out.truncated).toBe(true);
    expect(out.data === undefined || utf8ByteLength(JSON.stringify(out.data)) <= 5).toBe(true);
  });

  // Codex round-6 item 2 — round 5's fallback rescanned every remaining
  // string field to find "the largest" on EVERY iteration of two separate
  // loops (shrink, then drop), each also rebuilding the whole object and
  // re-serialising it: quadratic in field count. Codex measured ~716ms for
  // 1,000 small (32-byte) string fields and ~1.5s for 2,000 — long enough to
  // visibly stall the host page, since `safeWrap` cannot interrupt
  // synchronous CPU work. The fix makes this a single sort-and-scan, with no
  // per-field rescanning and no repeated whole-object reserialisation, so
  // cost must stay small and roughly linear as field count grows — this
  // asserts on ELAPSED TIME, not merely on the output shape, because a
  // shape-only assertion cannot tell a fast O(n log n) pass from a frozen
  // O(n²) one.
  it('bounds a thousand small string fields in well under the old ~716ms, not quadratically', () => {
    const value: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) value[`field${i}`] = 'x'.repeat(32);

    const start = performance.now();
    const out = boundStructuredJson(value, 2048);
    const elapsedMs = performance.now() - start;

    expect(out.truncated).toBe(true);
    expect(utf8ByteLength(JSON.stringify(out.data))).toBeLessThanOrEqual(2048);
    // Generous relative to the ~716ms this reproduced pre-fix — a
    // single-pass implementation should land in low single-digit
    // milliseconds even on a slow CI runner.
    expect(elapsedMs).toBeLessThan(50);
  });

  // Same shape at 2x the field count (Codex measured ~1.5s pre-fix at
  // 2,000 fields) — a quadratic implementation would take roughly 4x as
  // long as the 1,000-field case above; a linear/linearithmic one barely
  // more.
  it('scales roughly linearly, not quadratically, from 1,000 to 2,000 fields', () => {
    const build = (count: number): Record<string, unknown> => {
      const value: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) value[`field${i}`] = 'x'.repeat(32);
      return value;
    };

    const t1 = performance.now();
    boundStructuredJson(build(1000), 2048);
    const elapsed1k = performance.now() - t1;

    const t2 = performance.now();
    boundStructuredJson(build(2000), 2048);
    const elapsed2k = performance.now() - t2;

    // A quadratic implementation roughly quadruples; allow generous
    // headroom (6x) for timing noise while still catching an O(n²) regression.
    expect(elapsed2k).toBeLessThan(Math.max(elapsed1k * 6, 20));
  });
});
