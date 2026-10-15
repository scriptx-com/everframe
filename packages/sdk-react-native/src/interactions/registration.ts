// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import {
  normalizeInteractionTargetAnnotation,
  type InteractionTargetAnnotation,
  type InteractionEvent,
} from '@everframe/protocol';
import type { InteractionPolicy } from './policy.js';

/** Legacy helper declarations are accepted for compatibility; native observation retains ownership. */
export type HelperType = 'text_edit' | 'control_change' | 'scroll';
export interface InteractionHookOptions {
  target?: InteractionTargetAnnotation;
  /** Compatibility only. All helpers remain native-owned regardless of this list. */
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
    if (Array.isArray(raw) && raw.length <= 3) {
      const values = Array.from({ length: raw.length }, (_, index) => own(raw, String(index)));
      if (!values.every((value) => types.includes(value as HelperType)))
        return { ...(target ? { target } : {}), helperTypes: [] };
    }
    // JS cannot prove original native privacy for any host-bound state.
    // Validate legacy declarations above, but never suppress native fallback.
    return { ...(target ? { target } : {}), helperTypes: [] };
  } catch {
    return { helperTypes: [] };
  }
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
    /** Compatibility no-op: native UI observations own text privacy, lengths and values. */
    textChanged(
      _text: string,
      _input?: { composing?: boolean; reason?: 'change' | 'end' | 'submit' },
    ) {},
    /** Compatibility no-op: JS cannot prove privacy when the control state originated. */
    controlChanged(_change: ControlChangeInput) {},
    /** Compatibility no-op: native observation owns scroll evidence. */
    scrollSettled(_change: ScrollInput) {},
  };
}
