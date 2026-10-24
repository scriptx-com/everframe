// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Turns remote key events into the capture gesture. Pure: keys in, `onFire`
// out. It only observes keys; it never stops one from reaching the app.
import { vegaKeySupported, type GestureKey } from './remote-keys.js';

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

/** Same kind, same keys in the same order, same timing. */
export function bindingsEqual(a: GestureBinding | null, b: GestureBinding | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind || a.keys.length !== b.keys.length) return false;
  if (a.keys.some((key, i) => key !== b.keys[i])) return false;
  if (a.kind === 'longPress') return a.holdMs === (b as { holdMs: number }).holdMs;
  if (a.kind === 'sequence') return a.windowMs === (b as { windowMs: number }).windowMs;
  return true;
}

/**
 * The binding a Vega device runs for the app's configured one. No binding
 * (absent or invalid on the wire) is the default. A binding with a key a Vega
 * remote cannot send would never fire, so it disarms the gesture instead.
 */
export function resolveTvBinding(configured: GestureBinding | undefined): {
  binding: GestureBinding | null;
  unsupported: boolean;
} {
  if (!configured) return { binding: DEFAULT_TV_BINDING, unsupported: false };
  if (!configured.keys.every((key) => vegaKeySupported(key)))
    return { binding: null, unsupported: true };
  return { binding: configured, unsupported: false };
}

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
  const fire = (): void => {
    try {
      deps.onFire();
    } catch {
      // Never into the host.
    }
  };
  if (binding.kind === 'sequence')
    return sequenceDetector(binding.keys, binding.windowMs, deps.now, fire);
  if (binding.kind === 'chord') return chordDetector(binding.keys, fire);
  return longPressDetector(binding.keys[0], binding.holdMs, deps, fire);
}

/**
 * A down of the bound key that is not already held starts a `holdMs` timer;
 * the timer fires once. An up, or another key's down, cancels it. Repeated
 * downs while held are ignored.
 */
function longPressDetector(
  bound: GestureKey,
  holdMs: number,
  deps: GestureDetectorDeps,
  fire: () => void,
): GestureDetector {
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
        fire();
      }, holdMs);
    },
    reset() {
      cancel();
      held = false;
    },
  };
}

/**
 * Fresh downs only: a held key's repeated downs are one press. Fires when the
 * last `keys.length` presses equal `keys` and the first of them is at most
 * `windowMs` before the last; then the history starts over. Any other press,
 * including a key with no contract name, breaks the run.
 */
function sequenceDetector(
  keys: GestureKey[],
  windowMs: number,
  now: () => number,
  fire: () => void,
): GestureDetector {
  const held = new Set<GestureKey>();
  let presses: Array<{ key: GestureKey | null; at: number }> = [];

  return {
    onKey(key, action) {
      if (action === 'up') {
        if (key !== null) held.delete(key);
        return;
      }
      if (key !== null) {
        if (held.has(key)) return;
        held.add(key);
      }
      presses.push({ key, at: now() });
      if (presses.length > keys.length) presses.shift();
      if (presses.length < keys.length) return;
      if (presses.some((press, i) => press.key !== keys[i])) return;
      if (presses[presses.length - 1]!.at - presses[0]!.at > windowMs) return;
      presses = [];
      fire();
    },
    reset() {
      held.clear();
      presses = [];
    },
  };
}

/**
 * Fires once when every key is down at the same time, and rearms once all of
 * them are up again. State is kept per key, so a repeat or a re-press of one
 * key while another is still held never fires twice.
 */
function chordDetector(keys: GestureKey[], fire: () => void): GestureDetector {
  const bound = new Set<GestureKey>(keys);
  const held = new Set<GestureKey>();
  let fired = false;

  return {
    onKey(key, action) {
      if (key === null || !bound.has(key)) return;
      if (action === 'up') {
        held.delete(key);
        if (held.size === 0) fired = false;
        return;
      }
      held.add(key);
      if (fired || held.size !== bound.size) return;
      fired = true;
      fire();
    },
    reset() {
      held.clear();
      fired = false;
    },
  };
}
