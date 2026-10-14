// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.js';
import fixtures from './fixtures/interaction-events.v1.json';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020.js';

describe('interaction evidence producer contract', () => {
  it('publishes a portable schema matching runtime Unicode and argument limits', () => {
    const schema = JSON.parse(
      readFileSync(
        new URL('../schemas-json/interaction-event.v1.schema.json', import.meta.url),
        'utf8',
      ),
    );
    const validate = new Ajv({ strict: false }).compile(schema);
    for (const event of fixtures)
      expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    const text = {
      type: 'text_edit',
      source: 'native',
      observedAt: 1000,
      length: 258,
      reason: 'end',
      value: '😀'.repeat(129),
    };
    expect(validate(text)).toBe(false);
    expect(validate({ ...text, value: '😀'.repeat(128) })).toBe(true);
    expect(
      validate({
        type: 'launch',
        source: 'native',
        observedAt: 1,
        start: 'cold',
        arguments: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, true])),
      }),
    ).toBe(false);
  });
  it.each(fixtures)('admits $type evidence without extending envelope kinds', (event) => {
    expect(protocol).toHaveProperty('InteractionEventSchema');
    expect(protocol.InteractionEventSchema.parse(event)).toEqual(event);
    const kind = protocol.interactionBreadcrumbKind(event.type as protocol.InteractionEventType);
    expect(
      protocol.Breadcrumb.parse({
        t: 1000,
        seq: 1,
        kind,
        message: 'Interaction',
        data: { interaction: event },
      }).data,
    ).toEqual({ interaction: event });
  });

  it('uses compatible categories for new semantic evidence', () => {
    expect(protocol).toHaveProperty('interactionBreadcrumbKind');
    expect(
      ['text_edit', 'control_change', 'scroll', 'deep_link', 'permission', 'launch'].map((type) =>
        protocol.interactionBreadcrumbKind(type as protocol.InteractionEventType),
      ),
    ).toEqual(['custom', 'custom', 'custom', 'navigation', 'lifecycle', 'lifecycle']);
  });

  it.each([
    { type: 'text_edit', reason: 'end', length: -1 },
    { type: 'text_edit', reason: 'change', length: 1 },
    { type: 'text_edit', reason: 'end' },
    { type: 'control_change', control: 'switch', checked: true, optionId: 'bad' },
    { type: 'control_change', control: 'slider', position: Infinity },
    { type: 'control_change', control: 'picker', value: 'unidentified option' },
    { type: 'scroll', axis: 'y' },
    { type: 'deep_link', delivery: 'initial', url: '' },
    { type: 'permission', permission: 'camera', phase: 'result' },
    { type: 'permission', permission: 'camera', phase: 'requested', result: 'granted' },
    { type: 'launch', start: 'maybe' },
    { type: 'launch', start: 'cold', arguments: { private: { nested: 'secret' } } },
  ])('rejects absent or ambiguous core facts: %j', (input) => {
    expect(protocol).toHaveProperty('InteractionEventSchema');
    expect(
      protocol.InteractionEventSchema.safeParse({ source: 'native', observedAt: 1000, ...input })
        .success,
    ).toBe(false);
  });

  it('enforces UTF-16 value limits and rejects unpaired surrogates', () => {
    expect(protocol).toHaveProperty('InteractionEventSchema');
    const base = {
      type: 'text_edit',
      source: 'native',
      observedAt: 1000,
      length: 2,
      reason: 'end',
    };
    expect(protocol.InteractionEventSchema.safeParse({ ...base, value: '😀' }).success).toBe(true);
    expect(
      protocol.InteractionEventSchema.safeParse({ ...base, value: '😀'.repeat(128) }).success,
    ).toBe(true);
    for (const value of ['a'.repeat(257), '😀'.repeat(129), '\ud800', 'bad\u0000value']) {
      expect(protocol.InteractionEventSchema.safeParse({ ...base, value }).success).toBe(false);
    }
  });

  it('bounds arguments and rejects nonfinite values and unknown wire fields', () => {
    expect(protocol).toHaveProperty('InteractionEventSchema');
    const launch = { type: 'launch', source: 'native', observedAt: 1000, start: 'cold' };
    expect(
      protocol.InteractionEventSchema.safeParse({ ...launch, arguments: { count: NaN } }).success,
    ).toBe(false);
    expect(
      protocol.InteractionEventSchema.safeParse({
        ...launch,
        arguments: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`arg${i}`, i])),
      }).success,
    ).toBe(false);
    expect(
      protocol.InteractionEventSchema.safeParse({ ...launch, rawNotification: 'secret' }).success,
    ).toBe(false);
    expect(
      protocol.InteractionEventSchema.safeParse({ ...launch, observedAt: Infinity }).success,
    ).toBe(false);
  });
});
