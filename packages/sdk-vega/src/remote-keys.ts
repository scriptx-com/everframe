// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Remote keys: the contract's platform-neutral key names and the React
// Native for Vega `onHWKeyEvent` names they come from. Measured on the Vega
// Virtual Device (OS 1.1, 2026-10-24): Play, Pause and Play/Pause all arrive
// as `playpause`; fast forward and rewind as `skip_forward`/`skip_backward`;
// the color keys as `unknown`; letters not at all.

export const GESTURE_KEYS = [
  'DPAD_UP',
  'DPAD_DOWN',
  'DPAD_LEFT',
  'DPAD_RIGHT',
  'DPAD_CENTER',
  'BACK',
  'MENU',
  'MEDIA_PLAY_PAUSE',
  'MEDIA_FAST_FORWARD',
  'MEDIA_REWIND',
  'PROG_RED',
  'PROG_GREEN',
  'PROG_YELLOW',
  'PROG_BLUE',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  ...'0123456789'.split(''),
  'SHIFT',
] as const;

export type GestureKey = (typeof GESTURE_KEYS)[number];

const VEGA_EVENTS: Record<string, GestureKey> = {
  up: 'DPAD_UP',
  down: 'DPAD_DOWN',
  left: 'DPAD_LEFT',
  right: 'DPAD_RIGHT',
  select: 'DPAD_CENTER',
  back: 'BACK',
  menu: 'MENU',
  playpause: 'MEDIA_PLAY_PAUSE',
  forward: 'MEDIA_FAST_FORWARD',
  skip_forward: 'MEDIA_FAST_FORWARD',
  rewind: 'MEDIA_REWIND',
  skip_backward: 'MEDIA_REWIND',
  num_0: '0',
  num_1: '1',
  num_2: '2',
  num_3: '3',
  num_4: '4',
  num_5: '5',
  num_6: '6',
  num_7: '7',
  num_8: '8',
  num_9: '9',
};

const SUPPORTED = new Set<string>(Object.keys(VEGA_EVENTS).map((name) => VEGA_EVENTS[name]!));

/** The contract key for a Vega event name, or null for anything else. */
export function keyForVegaEvent(eventType: unknown): GestureKey | null {
  if (
    typeof eventType !== 'string' ||
    !Object.prototype.hasOwnProperty.call(VEGA_EVENTS, eventType)
  )
    return null;
  return VEGA_EVENTS[eventType]!;
}

/** Whether a Vega remote can send this key at all. */
export function vegaKeySupported(key: GestureKey): boolean {
  return SUPPORTED.has(key);
}

/** `eventKeyAction`: 0 is down (also every repeat of a held key), 1 is up. */
export function keyAction(raw: unknown): 'down' | 'up' | null {
  if (raw === 0) return 'down';
  if (raw === 1) return 'up';
  return null;
}
