// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import * as protocol from '../src/index.js';
import corpus from './fixtures/interaction-targets.v1.json';
import envelope from './fixtures/v1-minimal.json';

describe('interaction target producer contract', () => {
  it('preserves only explicit reporter trigger annotations', () => {
    expect(protocol.normalizeInteractionTargetAnnotation({ reporterTrigger: 'button' })).toEqual({
      reporterTrigger: 'button',
    });
    expect(protocol.normalizeInteractionTargetAnnotation({ reporterTrigger: 'menu' })).toEqual({
      reporterTrigger: 'menu',
    });
    expect(protocol.normalizeInteractionTargetAnnotation({ name: 'Report bug' })).toEqual({
      name: 'Report bug',
    });
    expect(
      protocol.normalizeInteractionTargetAnnotation({ reporterTrigger: 'playPause' }),
    ).toBeUndefined();
    expect(
      protocol.InteractionTargetAnnotationSchema.safeParse({ reporterTrigger: 'button' }).success,
    ).toBe(true);
  });
  it('exports the optional target contract without tightening legacy breadcrumb data', () => {
    expect(protocol).toHaveProperty('InteractionTargetSchema');
    expect(
      protocol.Breadcrumb.safeParse({
        t: 1,
        seq: 0,
        kind: 'tap',
        message: 'tap old',
        data: { target: 'legacy-host-value' },
      }).success,
    ).toBe(true);
  });

  it.each(corpus)('accepts $scenario', ({ target }) => {
    expect(protocol.InteractionTargetSchema.parse(target)).toEqual(target);
  });

  it.each([
    { masked: true, name: 'secret' },
    { masked: true, testId: 'secret' },
    { masked: true, screen: 'Profile' },
    { name: 'Orphan' },
    { nameFrom: 'text' },
    { role: 3 },
    { container: { index: -1 } },
  ])('rejects contradictory target %j', (target) => {
    expect(protocol.InteractionTargetSchema.safeParse(target).success).toBe(false);
  });

  it('normalizes annotations independently and keeps unrelated valid fields', () => {
    expect(
      protocol.normalizeInteractionTargetAnnotation({
        name: 'Play',
        masked: true,
        nameFrom: 'text',
        screen: 'Wrong',
        container: { name: 'Originals', index: 12, count: 12 },
      }),
    ).toEqual({ name: 'Play', container: { name: 'Originals' } });
    expect(
      protocol.normalizeInteractionTargetAnnotation({
        testId: 'poster-low-orbit',
        role: 'button',
        name: 'Low Orbit',
        container: { index: 0, count: 12 },
      }),
    ).toEqual({
      testId: 'poster-low-orbit',
      role: 'button',
      name: 'Low Orbit',
      container: { index: 0, count: 12 },
    });
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'drops invalid logical positions %s',
    (index) => {
      expect(
        protocol.normalizeInteractionTargetAnnotation({
          container: { name: 'Originals', index, count: index },
        }),
      ).toEqual({ container: { name: 'Originals' } });
    },
  );

  it('truncates names without splitting Unicode pairs and omits empty annotations', () => {
    expect(protocol.normalizeInteractionTargetAnnotation({ name: '😀'.repeat(129) })).toEqual({
      name: '😀'.repeat(128),
    });
    expect(protocol.normalizeInteractionTargetAnnotation({ name: 'a'.repeat(255) + '😀' })).toEqual(
      { name: 'a'.repeat(255) },
    );
    expect(protocol.normalizeInteractionTargetAnnotation({ role: 'a'.repeat(65) })).toEqual({
      role: 'a'.repeat(64),
    });
    expect(
      protocol.normalizeInteractionTargetAnnotation({ name: '', container: {} }),
    ).toBeUndefined();
    expect(protocol.normalizeInteractionTargetAnnotation(null)).toBeUndefined();
  });

  it('generates a portable schema with matching structural and UTF-16 limits', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const schema = JSON.parse(
      readFileSync(
        new URL('../schemas-json/interaction-target.v1.schema.json', import.meta.url),
        'utf8',
      ),
    );
    const validate = ajv.compile(schema);
    for (const { target } of corpus)
      expect(validate(target), JSON.stringify(validate.errors)).toBe(true);
    for (const target of [
      { masked: true, name: 'secret' },
      { name: 'a' },
      { name: '😀'.repeat(129), nameFrom: 'text' },
      { container: { index: -1 } },
    ]) {
      expect(validate(target)).toBe(false);
      expect(protocol.InteractionTargetSchema.safeParse(target).success).toBe(false);
    }
    expect(validate({ name: '😀'.repeat(128), nameFrom: 'text' })).toBe(true);
    const oldSchema = JSON.parse(
      readFileSync(new URL('../schemas-json/envelope.v1.schema.json', import.meta.url), 'utf8'),
    );
    const acceptsEnvelope = ajv.compile(oldSchema);
    expect(acceptsEnvelope(envelope)).toBe(true);
    const withTarget = structuredClone(envelope) as any;
    withTarget.payload.breadcrumbs = [
      { t: 1, seq: 0, kind: 'tap', message: 'tap Low Orbit', data: { target: corpus[0]!.target } },
    ];
    expect(acceptsEnvelope(withTarget), JSON.stringify(acceptsEnvelope.errors)).toBe(true);
  });
});
