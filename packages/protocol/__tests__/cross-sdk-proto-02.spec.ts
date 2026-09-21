// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// PROTO-02 cross-SDK fixture parity — TS side of the three-decoder gate.
//
// The same `v1-cross-sdk-proto-02.json` is round-tripped through:
//   - TS  (this spec — `ReportEnvelope.parse` from @traceitx/protocol)
//   - Swift (packages/sdk-ios/Tests/TraceItXTests/CrossSDKProto02Tests.swift)
//   - Kotlin (packages/sdk-android/android/traceitx-protocol/src/test/.../CrossSDKProto02Test.kt)
//
// All three MUST decode → re-encode → equal the canonical fixture's
// normalized (sorted-keys) JSON. Failure of any blocks Phase 6 sign-off.

import { describe, it, expect } from 'vitest';
import { ReportEnvelope } from '../src/index.js';
import fixture from './fixtures/v1-cross-sdk-proto-02.json' with { type: 'json' };

/**
 * Canonicalize JSON value: deep sort object keys so that re-serialization is
 * deterministic regardless of insertion order. Arrays preserve order
 * (semantically meaningful — e.g. payload.breadcrumbs).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = canonicalize(obj[k]);
    }
    return sorted;
  }
  return value;
}

describe('PROTO-02 cross-SDK fixture parity (TS)', () => {
  it('decodes via ReportEnvelope.parse without losing fields', () => {
    const parsed = ReportEnvelope.parse(fixture);
    expect(parsed.protocolVersion).toBe('1.0');
    expect(parsed.payload.uiTree).toBeDefined();
    expect(parsed.payload.reactTree).toBeDefined();
  });

  it('round-trips bytewise via canonical JSON (decode → re-encode → equal)', () => {
    const parsed = ReportEnvelope.parse(fixture);
    const reencoded = JSON.parse(JSON.stringify(parsed));
    expect(canonicalize(reencoded)).toEqual(canonicalize(fixture));
  });

  it('round-trips payload.breadcrumbs incl. the numeric-droppedCount trim marker', () => {
    const parsed = ReportEnvelope.parse(fixture);
    expect(parsed.captures.breadcrumbs).toBe(true);
    expect(parsed.payload.breadcrumbs).toHaveLength(2);
    // Indexed access is asserted rather than destructured: the length check
    // above already proves both entries exist, but `noUncheckedIndexedAccess`
    // widens each element to `| undefined` and destructuring gives the
    // compiler nothing to narrow on.
    const breadcrumbs = parsed.payload.breadcrumbs!;
    const normal = breadcrumbs[0]!;
    const marker = breadcrumbs[1]!;
    expect(normal.kind).toBe('tap');
    expect(normal.data?.['droppedCount']).toBeUndefined();
    expect(marker.kind).toBe('tap');
    expect(marker.level).toBe('info');
    expect(marker.message).toBe('+3 tap hidden');
    expect(marker.data?.['droppedCount']).toBe(3);
    expect(typeof marker.data?.['droppedCount']).toBe('number');
  });

});
