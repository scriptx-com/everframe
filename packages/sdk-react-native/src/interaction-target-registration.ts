// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import {
  normalizeInteractionTargetAnnotation,
  type InteractionTargetAnnotation,
} from '@everframe/protocol';

let generation = 0;
let registration = 0;
const runtimeId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
export function nextInteractionTargetId(): string {
  return `${runtimeId}:${++registration}`;
}

/** Pure controller: only attach/update/dispose in a committed lifecycle publish native metadata. */
export function createInteractionTargetRegistration(bridge: unknown, registrationId: string) {
  let host: unknown;
  let annotation: InteractionTargetAnnotation | undefined;
  let registered = false;
  function clear() {
    if (!registered) return;
    registered = false;
    try {
      const b = bridge as { clearInteractionTarget?: unknown } | undefined;
      if (typeof b?.clearInteractionTarget === 'function')
        b.clearInteractionTarget(registrationId, ++generation);
    } catch {
      /* Optional metadata must never break host rendering. */
    }
  }
  function publish() {
    if (host == null || !annotation) return;
    try {
      const b = bridge as { findNodeHandle?: unknown; setInteractionTarget?: unknown } | undefined;
      if (typeof b?.setInteractionTarget !== 'function' || typeof b.findNodeHandle !== 'function')
        return;
      const tag: unknown = b.findNodeHandle(host);
      if (typeof tag !== 'number' || !Number.isInteger(tag) || tag <= 0 || tag > 2147483647) return;
      // Also attempt cleanup if an old binary throws after accepting a call.
      registered = true;
      b.setInteractionTarget(tag, registrationId, ++generation, annotation);
    } catch {
      /* Unsupported custom refs and older native binaries are harmless. */
    }
  }
  return {
    attach(next: unknown) {
      clear();
      host = next;
      publish();
    },
    update(next: InteractionTargetAnnotation | undefined) {
      clear();
      try {
        annotation = normalizeInteractionTargetAnnotation(next);
      } catch {
        annotation = undefined;
      }
      publish();
    },
    dispose() {
      clear();
      host = undefined;
    },
  };
}
