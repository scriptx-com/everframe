// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Turns remote key events into the capture gesture. Pure: keys in, `onFire`
// out. It only observes keys; it never stops one from reaching the app.
import type { GestureKey } from './remote-keys.js';

export type GestureBinding =
  | { kind: 'longPress'; keys: [GestureKey]; holdMs: number }
  | { kind: 'sequence'; keys: GestureKey[]; windowMs: number }
  | { kind: 'chord'; keys: GestureKey[] };

export const DEFAULT_TV_BINDING: GestureBinding = {
  kind: 'longPress',
  keys: ['MEDIA_PLAY_PAUSE'],
  holdMs: 1500,
};

/**
 * How long an up may be followed by a down of the same key and still count
 * as one hold. Vega repeats a held key as more downs (one up at the end), so
 * no gap is needed.
 */
export const REPEAT_GAP_MS = 0;

export interface GestureDetectorDeps {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  onFire: () => void;
}

export interface GestureDetector {
  /** A key event; `null` is a key the contract has no name for. */
  onKey(key: GestureKey | null, action: 'down' | 'up'): void;
  /** Forget any held key and cancel a pending hold. */
  reset(): void;
}

export function createGestureDetector(
  binding: GestureBinding,
  deps: GestureDetectorDeps,
): GestureDetector {
  // PR 2 adds sequences and chords; until then only a long press runs.
  if (binding.kind !== 'longPress') return { onKey: () => undefined, reset: () => undefined };
  const bound = binding.keys[0];
  const holdMs = binding.holdMs;
  let held = false;
  let timer: unknown;

  function cancel(): void {
    if (timer !== undefined) deps.clearTimeout(timer);
    timer = undefined;
  }

  return {
    onKey(key, action) {
      if (key !== bound) {
        // Another key pressed during the hold ends it.
        if (action === 'down' && held) {
          cancel();
          held = false;
        }
        return;
      }
      if (action === 'up') {
        cancel();
        held = false;
        return;
      }
      // A repeat of the held key changes nothing.
      if (held) return;
      held = true;
      timer = deps.setTimeout(() => {
        timer = undefined;
        // Still held: the up would have cancelled this timer.
        try {
          deps.onFire();
        } catch {
          // Never into the host.
        }
      }, holdMs);
    },
    reset() {
      cancel();
      held = false;
    },
  };
}
