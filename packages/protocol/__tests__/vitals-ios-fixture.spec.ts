// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Cross-SDK parity for the iOS vitals wire types (iOS spec 2026-09-05 §1).
// VitalsFixtureParityTests (Swift) proves the hand-written Codable structs
// produce exactly this JSON; this side proves the zod schemas accept it.
import { describe, it, expect } from 'vitest';
import fixture from './fixtures/vitals-ios.v1.json' with { type: 'json' };
import { MAX_CUSTOM_DATA_BYTES, VitalsIngestBody, VitalsIngestRequest, VitalsPlayerEventType } from '../src/vitals.js';

describe('iOS vitals fixture parity (TS)', () => {
  it('chunk validates as VitalsIngestBody and round-trips', () => {
    expect(VitalsIngestBody.parse(fixture.chunk)).toEqual(fixture.chunk);
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
      if (t === 'dropped_frames') continue;
      expect(seen.has(t), `missing ${t}`).toBe(true);
    }
  });
  // Codex round-4 item 4 (iOS). The SDK's custom-data budget used to measure Foundation's
  // serialisation, which prints an integral double up to 1e21 in exponent notation while
  // JSON.stringify prints it in full: 1e20 is six bytes there and twenty-one here. A payload the
  // SDK thought was 601 bytes reserialised to 2201 and this refinement rejected the WHOLE chunk,
  // losing every unrelated sample and player event in it. `numericCustom` is Swift-produced and
  // sits one byte under the cap, so it fails here the moment that measurement drifts again.
  it('Swift-produced numeric custom entries sit inside the custom-data cap', () => {
    expect(VitalsIngestBody.parse(fixture.numericCustom)).toEqual(fixture.numericCustom);
    for (const e of fixture.numericCustom.entries) {
      expect(Buffer.byteLength(JSON.stringify((e as { data: unknown }).data) ?? '', 'utf8'))
        .toBeLessThanOrEqual(MAX_CUSTOM_DATA_BYTES);
    }
    // The untouched one is one byte under the cap, so the boundary is really being tested.
    const fits = (fixture.numericCustom.entries[0] as { data: unknown }).data;
    expect(Buffer.byteLength(JSON.stringify(fits) ?? '', 'utf8')).toBe(MAX_CUSTOM_DATA_BYTES - 1);
    // …and the second entry is the one the SDK had to cut, so it says so.
    expect((fixture.numericCustom.entries[1] as { truncated?: boolean }).truncated).toBe(true);
  });
  it('the payload the second entry was cut from would be rejected uncut', () => {
    const uncut = { ...(fixture.numericCustom.entries[1] as object), data: Array<number>(100).fill(1e20) };
    const body = { ...fixture.numericCustom, entries: [uncut] };
    expect(Buffer.byteLength(JSON.stringify(uncut.data), 'utf8')).toBeGreaterThan(MAX_CUSTOM_DATA_BYTES);
    expect(() => VitalsIngestBody.parse(body)).toThrow();
  });
  it('dims carry the ios and tvos platforms', () => {
    expect(fixture.summary.dims.platform).toBe('ios');
    expect(fixture.summaryNulls.dims.platform).toBe('tvos');
  });
});
