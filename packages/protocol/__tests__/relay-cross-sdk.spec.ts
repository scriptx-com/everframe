// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// PROTO-03 cross-SDK relay fixture parity — TS side of the three-decoder gate.
//
// Mirrors `cross-sdk-proto-02.spec.ts` (PROTO-02 pattern). The same
// `v1-relay-fixture.json` will be round-tripped through:
//   - TS    (this spec — `RelayMessage.parse` from @everframe/protocol)
//   - Swift (Plan 06.2-07 lands the iOS test target)
//   - Kotlin (Plan 06.2-08 lands the Android test target)
//
// Plan 06.2-03 lands the Zod schema and tightens this spec against the
// canonical fixture — every branch round-trips, unknown discriminators reject.

import { describe, it, expect } from 'vitest';
import fixture from './fixtures/v1-relay-fixture.json' with { type: 'json' };
import { relay } from '../src/index.js';

/**
 * Canonicalize JSON value: deep sort object keys so that re-serialization is
 * deterministic regardless of insertion order. Arrays preserve order
 * (semantically meaningful). Reused verbatim from cross-sdk-proto-02.spec.ts.
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

type FixtureMessage = { type: string } & Record<string, unknown>;
const messages = (fixture as { messages: FixtureMessage[] }).messages;

describe('PROTO-03 cross-SDK relay fixture parity (TS)', () => {
  it('fixture file is well-formed JSON with a messages array', () => {
    expect(fixture).toBeTruthy();
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThan(0);
  });

  it('canonicalize() is a pure deterministic transform (sanity)', () => {
    const a = canonicalize(fixture);
    const b = canonicalize(JSON.parse(JSON.stringify(fixture)));
    expect(a).toEqual(b);
  });

  it('fixture covers all 10 RelayMessage discriminators (SPEC Req 6)', () => {
    const expected = new Set([
      'pair.created',
      'pair.bonded',
      'pair.expired',
      'report.request',
      'report.assembled',
      'report.draft.update',
      'report.submit',
      'report.completed',
      'report.failed',
      'report.rejected',
    ]);
    const actual = new Set(messages.map((m) => m.type));
    expect(actual).toEqual(expected);
  });

  // One round-trip block per branch — parse, re-emit, canonicalize, deep-equal.
  // The fixture is iterated rather than hand-listed so adding a new branch in
  // the schema + fixture is enough; no extra test block to add.
  describe('round-trips every fixture entry via canonical JSON', () => {
    for (const msg of messages) {
      it(`round-trips ${msg.type}`, () => {
        const parsed = relay.RelayMessage.parse(msg);
        const reencoded = JSON.parse(JSON.stringify(parsed));
        expect(canonicalize(reencoded)).toEqual(canonicalize(msg));
      });
    }
  });

  it('rejects unknown type discriminator', () => {
    expect(() => relay.RelayMessage.parse({ type: 'bogus' })).toThrow();
  });

  it('rejects pair.created missing required pair_token', () => {
    expect(() =>
      relay.RelayMessage.parse({ type: 'pair.created', pair_id: 'x' })
    ).toThrow();
  });

  it('accepts well-formed pair.created', () => {
    const parsed = relay.RelayMessage.parse({
      type: 'pair.created',
      pair_id: 'x',
      pair_token: 'y',
    });
    expect(parsed.type).toBe('pair.created');
  });

  it('report.assembled accepts an optional breadcrumbs count', () => {
    const msg = {
      type: 'report.assembled',
      correlation_id: 'c1',
      mime: 'image/png',
      size: 10,
      toggles: {
        logs: true,
        network: true,
        uiTree: false,
        metadata: true,
        screenshot: true,
      },
      counts: { logs: 2, network: 1, uiTreeNodes: 0, breadcrumbs: 7 },
    };
    const parsed = relay.RelayMessage.parse(msg);
    if (parsed.type !== 'report.assembled') throw new Error('unreachable');
    expect(parsed.counts.breadcrumbs).toBe(7);
    // and absent stays absent (older TVs):
    const { breadcrumbs: _omit, ...bare } = msg.counts;
    const parsedBare = relay.RelayMessage.parse({ ...msg, counts: bare });
    if (parsedBare.type !== 'report.assembled') throw new Error('unreachable');
    expect(parsedBare.counts.breadcrumbs).toBeUndefined();
  });
});
