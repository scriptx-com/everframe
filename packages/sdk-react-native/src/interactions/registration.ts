// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import {
  normalizeInteractionTargetAnnotation,
  InteractionTargetSchema,
  type InteractionTargetAnnotation,
  type InteractionEvent,
} from '@everframe/protocol';
import type { InteractionPolicy } from './policy.js';

/** text_edit is accepted for compatibility; native observation retains ownership. */
export type HelperType = 'text_edit' | 'control_change' | 'scroll';
export interface InteractionHookOptions {
  target?: InteractionTargetAnnotation;
  helperTypes?: readonly HelperType[];
}
type EventInput<T> = T extends unknown ? Omit<T, 'type' | 'source' | 'observedAt'> : never;
export type ControlChangeInput = EventInput<Extract<InteractionEvent, { type: 'control_change' }>>;
export type ScrollInput = EventInput<Extract<InteractionEvent, { type: 'scroll' }>>;
export interface InteractionScope {
  readonly policy: InteractionPolicy;
  owner(): object | undefined;
}
const types: HelperType[] = ['text_edit', 'control_change', 'scroll'];
let generation = 0;
function own(input: unknown, key: string): unknown {
  if (input === null || typeof input !== 'object') return undefined;
  const property = Object.getOwnPropertyDescriptor(input, key);
  if (property && !('value' in property)) throw Error('Accessor input');
  return property?.value;
}
export function normalizeInteractionOptions(input: unknown): InteractionHookOptions {
  try {
    const rawTarget = own(input, 'target');
    const target = normalizeInteractionTargetAnnotation(rawTarget);
    const rawId = own(rawTarget, 'testId');
    // Metadata normalization can remove NUL/truncate. It must never grant a value permission.
    if (
      target?.testId !== undefined &&
      (target.testId !== rawId ||
        typeof rawId !== 'string' ||
        rawId.trim() !== rawId ||
        /[\u0000-\u001f\u007f\uD800-\uDFFF*]/u.test(rawId))
    )
      delete target.testId;
    const raw = own(input, 'helperTypes');
    let helpers: HelperType[] = [];
    if (Array.isArray(raw) && raw.length <= 3) {
      const values = Array.from({ length: raw.length }, (_, index) => own(raw, String(index)));
      if (values.every((value) => types.includes(value as HelperType)))
        // A JS callback cannot prove native sensitivity at observation time.
        // Leave automatic text capture active instead of owning an unsafe helper.
        helpers = [...new Set(values)].filter((value) => value !== 'text_edit') as HelperType[];
    }
    return { ...(target ? { target } : {}), helperTypes: helpers };
  } catch {
    return { helperTypes: [] };
  }
}
function bounded(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || value.includes('\0')) return undefined;
  let text = value.slice(0, limit);
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return /[\uD800-\uDFFF]/u.test(text) ? undefined : text;
}
function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    bounded(value, 128) === value
  );
}
function utf8Length(value: string): number {
  let bytes = 0;
  for (const point of value) {
    const code = point.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
interface Bridge {
  findNodeHandle(host: unknown): unknown;
  getInteractionLease(): unknown;
  setInteractionObserver(
    tag: number,
    id: string,
    generation: number,
    lease: string,
    optionsJson: string,
  ): unknown;
  clearInteractionObserver(id: string, generation: number): unknown;
  recordInteraction(lease: string, id: string, generation: number, eventJson: string): unknown;
}
/** A controller belongs to one committed option set and never renews a revoked observation. */
export function createInteractionRegistration(
  bridge: unknown,
  scope: InteractionScope | undefined,
  id: string,
  input: unknown,
) {
  const options = normalizeInteractionOptions(input);
  let host: unknown,
    attempted = false;
  let binding: { lease: string; generation: number; owner: object } | undefined;
  function clear() {
    const previous = binding;
    binding = undefined;
    if (!previous) return;
    try {
      (bridge as Bridge).clearInteractionObserver(id, ++generation);
    } catch {
      /* Optional observation. */
    }
  }
  function start() {
    if (host == null || attempted) return;
    try {
      const owner = scope?.owner();
      if (!owner || scope?.policy.disabled) return;
      attempted = true;
      const b = bridge as Bridge;
      if (
        !b ||
        [
          'findNodeHandle',
          'getInteractionLease',
          'setInteractionObserver',
          'clearInteractionObserver',
          'recordInteraction',
        ].some((key) => typeof (b as unknown as Record<string, unknown>)[key] !== 'function')
      )
        return;
      const lease = b.getInteractionLease(),
        tag = b.findNodeHandle(host);
      if (
        typeof lease !== 'string' ||
        !lease ||
        typeof tag !== 'number' ||
        !Number.isInteger(tag) ||
        tag <= 0 ||
        tag > 2147483647 ||
        generation >= Number.MAX_SAFE_INTEGER - 1
      )
        return;
      const json = JSON.stringify(options);
      if (utf8Length(json) > 8192) return;
      binding = { lease, generation: ++generation, owner };
      if (b.setInteractionObserver(tag, id, binding.generation, lease, json) !== true) clear();
    } catch {
      clear();
    }
  }
  function emit(type: HelperType, fields: () => Record<string, unknown> | undefined) {
    const captured = binding;
    if (!captured || !options.helperTypes?.includes(type)) return;
    try {
      const b = bridge as Bridge;
      if (scope?.owner() !== captured.owner || b.getInteractionLease() !== captured.lease) {
        clear();
        return;
      }
      const input = fields();
      if (!input) return;
      const json = JSON.stringify({ ...input, type, source: 'app', observedAt: Date.now() });
      if (utf8Length(json) <= 8192)
        b.recordInteraction(captured.lease, id, captured.generation, json);
    } catch {
      /* App callbacks and custom refs remain authoritative. */
    }
  }
  function permittedValue(value: unknown): string | undefined {
    return options.target?.testId && scope?.policy.valueTestIds.includes(options.target.testId)
      ? bounded(value, 256)
      : undefined;
  }
  return {
    attach(next: unknown) {
      clear();
      host = next;
      attempted = false;
      start();
    },
    start,
    dispose() {
      clear();
      host = undefined;
      attempted = true;
    },
    textChanged(
      _text: string,
      _input?: { composing?: boolean; reason?: 'change' | 'end' | 'submit' },
    ) {
      // Reserved compatibility API. Native UI observations own text privacy,
      // composition, length and optional values; JS text never crosses the bridge.
    },
    controlChanged(change: ControlChangeInput) {
      emit('control_change', () => {
        const control = own(change, 'control');
        if (control === 'switch' || control === 'checkbox') {
          const checked = own(change, 'checked');
          return typeof checked === 'boolean' ? { control, checked } : undefined;
        }
        if (control === 'slider') {
          const position = own(change, 'position');
          return typeof position === 'number' && Number.isFinite(position)
            ? { control, position }
            : undefined;
        }
        if (control === 'radio' || control === 'picker') {
          const optionId = own(change, 'optionId');
          if (!identifier(optionId)) return;
          const value = permittedValue(own(change, 'value'));
          return { control, optionId, ...(value === undefined ? {} : { value }) };
        }
      });
    },
    scrollSettled(change: ScrollInput) {
      emit('scroll', () => {
        const axis = own(change, 'axis'),
          direction = own(change, 'direction');
        if (
          !['x', 'y'].includes(axis as string) ||
          !['forward', 'backward'].includes(direction as string)
        )
          return;
        const parsed = InteractionTargetSchema.safeParse(own(change, 'item'));
        return { axis, direction, ...(parsed.success ? { item: parsed.data } : {}) };
      });
    },
  };
}
