// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';

export const MAX_STATE_KEYS = 50;
export const MAX_STATE_KEY_UNITS = 64;
export const MAX_STATE_VALUE_UNITS = 256;
export const MAX_STATE_CHANGES = 100;
export const MAX_STATE_CUSTOM_BYTES = 8192;
export const MAX_STATE_BYTES = 32768;
// Automatic facts have a fixed vocabulary; leave modest room for additive facts.
export const MAX_AUTOMATIC_STATE_KEYS = 32;

export const StateKey = z
  .string()
  .min(1)
  .max(MAX_STATE_KEY_UNITS)
  .regex(/^(?!__proto__$)[^\u0000-\u001f\u007f-\u009f\p{Surrogate}]+$/u);
export const StateValue = z
  .union([z.string().max(MAX_STATE_VALUE_UNITS), z.number(), z.boolean()])
  .meta({ id: 'StateValue', title: 'StateValue' });
export type StateValue = z.infer<typeof StateValue>;
// Zod deliberately skips __proto__ entries before validating record keys.
const values = z.preprocess(
  (input, ctx) => {
    if (input && typeof input === 'object' && Object.hasOwn(input, '__proto__')) {
      ctx.addIssue({ code: 'custom', message: 'reserved state key' });
    }
    return input;
  },
  z.record(StateKey, StateValue),
);
export const StateSnapshot = z
  .object({ custom: values, automatic: values })
  .strict()
  .meta({ id: 'StateSnapshot', title: 'StateSnapshot' });
export type StateSnapshot = z.infer<typeof StateSnapshot>;
export const StateChange = z
  .object({
    t: z.number(),
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    namespace: z.enum(['custom', 'automatic']).meta({ title: 'StateNamespace' }),
    key: StateKey,
    op: z.enum(['set', 'clear']).meta({ title: 'StateOperation' }),
    value: StateValue.optional(),
  })
  .strict()
  .superRefine((change, ctx) => {
    if ((change.op === 'set') !== (change.value !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'set requires value; clear forbids it',
        path: ['value'],
      });
    }
  })
  .meta({ id: 'StateChange', title: 'StateChange' });
export type StateChange = z.infer<typeof StateChange>;

/** Bytes on the wire, including escaping. No Buffer dependency in shared protocol. */
export function stateJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export const ReportState = z
  .object({
    startedAt: z.number(),
    initial: StateSnapshot,
    checkpoint: z
      .object({
        t: z.number(),
        throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        values: StateSnapshot,
      })
      .strict()
      .meta({ title: 'StateCheckpoint' })
      .optional(),
    changes: z.array(StateChange).max(MAX_STATE_CHANGES),
    current: StateSnapshot,
    capturedAt: z.number(),
    droppedChanges: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((state, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (Boolean(state.checkpoint) !== state.droppedChanges > 0)
      issue('checkpoint must describe dropped history');
    let previous = state.checkpoint?.throughSeq ?? -1;
    const custom = new Set<string>();
    const automatic = new Set<string>();
    const snapshots = [
      state.initial,
      state.current,
      ...(state.checkpoint ? [state.checkpoint.values] : []),
    ];
    for (const snapshot of snapshots) {
      Object.keys(snapshot.custom).forEach((key) => custom.add(key));
      Object.keys(snapshot.automatic).forEach((key) => automatic.add(key));
      if (stateJsonBytes(snapshot.custom) > MAX_STATE_CUSTOM_BYTES)
        issue('custom state byte budget exceeded');
    }
    for (const change of state.changes) {
      if (change.seq <= previous) issue('state sequences must strictly increase after checkpoint');
      previous = change.seq;
      (change.namespace === 'custom' ? custom : automatic).add(change.key);
    }
    if (custom.size > MAX_STATE_KEYS || automatic.size > MAX_AUTOMATIC_STATE_KEYS)
      issue('state key budget exceeded');
    if (stateJsonBytes(state) > MAX_STATE_BYTES) issue('state block byte budget exceeded');
  })
  .meta({ id: 'ReportState', title: 'ReportState' });
export type ReportState = z.infer<typeof ReportState>;

/** Replay evidence, never trust the redundant current map supplied by a sender. */
export function reconstructState(state: ReportState): StateSnapshot {
  const base = state.checkpoint?.values ?? state.initial;
  const current: StateSnapshot = {
    custom: Object.assign(Object.create(null), base.custom),
    automatic: Object.assign(Object.create(null), base.automatic),
  };
  for (const change of state.changes) {
    const map = current[change.namespace];
    if (change.op === 'clear') delete map[change.key];
    else if (change.value !== undefined) map[change.key] = change.value;
  }
  return current;
}
