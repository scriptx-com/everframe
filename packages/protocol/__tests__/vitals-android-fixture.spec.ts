// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Cross-SDK parity for the Android vitals wire types (spec 2026-09-05 §1).
// The Kotlin side (VitalsFixtureParityTest) proves its hand-written
// @Serializable classes produce exactly this JSON; this side proves the zod
// schemas the ingest route runs accept it. Neither can drift alone.
import { describe, it, expect } from 'vitest';
import fixture from './fixtures/vitals-android.v1.json' with { type: 'json' };
import { VitalsIngestBody, VitalsIngestRequest, VitalsPlayerEventType } from '../src/vitals.js';

describe('Android vitals fixture parity (TS)', () => {
  it('chunk validates as VitalsIngestBody and round-trips', () => {
    const parsed = VitalsIngestBody.parse(fixture.chunk);
    expect(parsed).toEqual(fixture.chunk);
  });

  it('summary validates and round-trips', () => {
    expect(VitalsIngestBody.parse(fixture.summary)).toEqual(fixture.summary);
  });

  it('summary with nullable fields validates', () => {
    expect(VitalsIngestBody.parse(fixture.summaryNulls)).toEqual(fixture.summaryNulls);
  });

  it('wrapped request shape validates without apiKey', () => {
    expect(() => VitalsIngestRequest.parse({ payload: fixture.chunk })).not.toThrow();
  });

  it('fixture exercises every player event type except dropped_frames', () => {
    const seen = new Set(fixture.chunk.entries.filter((e) => e.kind === 'player').map((e) => (e as { type: string }).type));
    for (const t of VitalsPlayerEventType.options) {
      if (t === 'dropped_frames') continue; // superseded by stats; Android never emits it
      expect(seen.has(t), `missing ${t}`).toBe(true);
    }
  });
});
