// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Native from '../NativeEverframe.js';
import { __getCurrentContext } from '../contextSeam.js';
import type { InteractionScope } from './registration.js';
export interface InteractionBridge {
  getInteractionLease(): unknown;
  recordInteraction(lease: string, id: string, generation: number, json: string): unknown;
}
export function currentInteractionScope(): InteractionScope | undefined {
  return (__getCurrentContext() as { interactionEvents?: InteractionScope } | null)
    ?.interactionEvents;
}
export function own(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object') return undefined;
  const property = Object.getOwnPropertyDescriptor(input, key);
  if (property && !('value' in property)) throw Error('Accessor input');
  return property?.value;
}
export function bounded(value: string, max: number): string | undefined {
  if (/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value)) return undefined;
  let out = value.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out;
}
/** One operation retains only an opaque owner/lease; revocation never renews it. */
export function captureInteractionOperation(
  scope = currentInteractionScope(),
  bridge: InteractionBridge = Native,
) {
  try {
    if (!scope || scope.policy.disabled) return;
    const owner = scope.owner(),
      lease = bridge.getInteractionLease();
    if (
      !owner ||
      typeof lease !== 'string' ||
      !lease ||
      typeof bridge.recordInteraction !== 'function'
    )
      return;
    const active = () => scope.owner() === owner && bridge.getInteractionLease() === lease;
    return {
      policy: scope.policy,
      emit(fields: Record<string, unknown>, source: 'app' | 'native' = 'app') {
        try {
          if (!active()) return;
          const json = JSON.stringify({ ...fields, source, observedAt: Date.now() });
          // All producer strings have bounded UTF16 length; this exact byte check is the final bridge ceiling.
          let bytes = 0;
          for (const point of json) {
            const c = point.codePointAt(0)!;
            bytes += c < 128 ? 1 : c < 2048 ? 2 : c < 65536 ? 3 : 4;
          }
          if (bytes <= 8192 && active()) bridge.recordInteraction(lease, '', 0, json);
        } catch {
          /* Observation cannot interfere with the app. */
        }
      },
    };
  } catch {
    return;
  }
}
