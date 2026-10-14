// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.js';
import { baseEnvelope } from './helpers/base-envelope.js';

const empty = () => ({ custom: {}, automatic: {} });
const sample = () => ({
  startedAt: 1000,
  initial: empty(),
  changes: [
    { t: 1001, seq: 0, namespace: 'custom', key: 'plan', op: 'set', value: 'free' },
    { t: 1001, seq: 1, namespace: 'custom', key: 'plan', op: 'set', value: 'premium' },
    { t: 1002, seq: 2, namespace: 'custom', key: 'enabled', op: 'set', value: false },
    { t: 1002, seq: 3, namespace: 'custom', key: 'count', op: 'set', value: 0 },
  ],
  current: { custom: { plan: 'premium', enabled: false, count: 0 }, automatic: {} },
  capturedAt: 1003,
  droppedChanges: 0,
});
const schema = () => (protocol as any).ReportState;

describe('report state', () => {
  it('exports an additive named state schema and validates it on envelopes', () => {
    expect(schema()).toBeDefined();
    expect(protocol.ReportEnvelope.safeParse(baseEnvelope()).success).toBe(true);
    const envelope = baseEnvelope();
    envelope.payload.state = sample();
    expect(protocol.ReportEnvelope.safeParse(envelope).success).toBe(true);
    envelope.payload.state.changes[0].value = null;
    expect(protocol.ReportEnvelope.safeParse(envelope).success).toBe(false);
  });
  it('reconstructs typed capture values instead of trusting supplied current', () => {
    expect((protocol as any).reconstructState).toBeTypeOf('function');
    const state = sample();
    state.current.custom.plan = 'contradiction';
    expect((protocol as any).reconstructState(state)).toEqual({
      custom: { plan: 'premium', enabled: false, count: 0 },
      automatic: {},
    });
  });
  it('replays from a checkpoint, including removals without mutating initial', () => {
    expect(schema()).toBeDefined();
    const state = {
      ...sample(),
      checkpoint: {
        t: 1001,
        throughSeq: 1,
        values: { custom: { plan: 'premium' }, automatic: { locale: 'en-US' } },
      },
      changes: [{ t: 1002, seq: 2, namespace: 'custom', key: 'plan', op: 'clear' }],
      droppedChanges: 2,
    };
    expect(schema().safeParse(state).success).toBe(true);
    expect((protocol as any).reconstructState(state)).toEqual({
      custom: {},
      automatic: { locale: 'en-US' },
    });
    expect(state.initial).toEqual(empty());
  });
  it.each([null, {}, [], NaN, Infinity, -Infinity, 'a'.repeat(257)])(
    'rejects invalid value %j',
    (value) => {
      expect(schema()).toBeDefined();
      const state = sample();
      state.changes[0]!.value = value as any;
      expect(schema().safeParse(state).success).toBe(false);
    },
  );
  it.each(['', 'a'.repeat(65), 'bad\u0000key', '\ud800', 'bad\u0085key'])(
    'rejects invalid key %j',
    (key) => {
      expect(schema()).toBeDefined();
      const state = sample();
      state.changes[0]!.key = key;
      expect(schema().safeParse(state).success).toBe(false);
    },
  );
  it('accepts exact string/key bounds and backwards wall clocks with ordered sequences', () => {
    expect(schema()).toBeDefined();
    const state = sample();
    state.changes[0] = {
      ...state.changes[0]!,
      key: 'a'.repeat(64),
      value: '😀'.repeat(128),
      t: 999,
    };
    expect(schema().safeParse(state).success).toBe(true);
  });
  it('rejects duplicate/out-of-order sequences and invalid checkpoint continuity', () => {
    expect(schema()).toBeDefined();
    const state = sample();
    state.changes[1]!.seq = 0;
    expect(schema().safeParse(state).success).toBe(false);
    const checkpoint = { t: 1001, throughSeq: 5, values: empty() };
    expect(schema().safeParse({ ...sample(), checkpoint, droppedChanges: 1 }).success).toBe(false);
    expect(schema().safeParse({ ...sample(), droppedChanges: 1 }).success).toBe(false);
  });
  it('rejects set without value and clear with value', () => {
    expect(schema()).toBeDefined();
    const state = sample();
    delete (state.changes[0] as any).value;
    expect(schema().safeParse(state).success).toBe(false);
    expect(
      schema().safeParse({ ...sample(), changes: [{ ...sample().changes[0], op: 'clear' }] })
        .success,
    ).toBe(false);
  });
  it('enforces 50 distinct custom keys even across cleared history and snapshot copies', () => {
    expect(schema()).toBeDefined();
    const initial = {
      custom: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i])),
      automatic: {},
    };
    expect(
      schema().safeParse({ ...sample(), initial, changes: [], current: initial }).success,
    ).toBe(true);
    expect(schema().safeParse({ ...sample(), initial }).success).toBe(false);
  });
  it('enforces history count and encoded map/block byte budgets', () => {
    expect(schema()).toBeDefined();
    const changes = Array.from({ length: 101 }, (_, seq) => ({ ...sample().changes[0], seq }));
    expect(schema().safeParse({ ...sample(), changes }).success).toBe(false);
    const custom = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`k${i}`, '😀'.repeat(128)]),
    );
    expect(schema().safeParse({ ...sample(), initial: { custom, automatic: {} } }).success).toBe(
      false,
    );
  });
  it('treats prototype-shaped labels as own properties when reconstructing', () => {
    expect((protocol as any).reconstructState).toBeTypeOf('function');
    const state = {
      ...sample(),
      changes: [],
      initial: { custom: JSON.parse('{"__proto__":"label","constructor":false}'), automatic: {} },
    };
    const out = (protocol as any).reconstructState(state);
    expect(Object.hasOwn(out.custom, '__proto__')).toBe(true);
    expect(out.custom.__proto__).toBe('label');
    expect(out.custom.constructor).toBe(false);
    expect(Object.prototype).not.toHaveProperty('label');
    expect(schema().safeParse(state).success).toBe(false);
  });
});
