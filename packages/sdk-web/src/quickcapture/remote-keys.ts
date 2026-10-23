// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture (web TVs): the contract's platform-neutral key
// names (`captureGesture.tv`, gesture recordings), the binding they form, and
// the remote `keyCode`s they stand for on webOS and Tizen. Lazy chunk only.
//
// webOS: Play (415), Pause (19) and the combined MediaPlayPause (179) all read
// as MEDIA_PLAY_PAUSE. Tizen: the codes come from `tvinputdevice.getKey`
// first, then the table; Play and Pause stand in for MEDIA_PLAY_PAUSE only on
// a TV whose supported keys lack MediaPlayPause.
import type { TvPlatform } from '../devicelink/tv-platform.js';
import type { TizenInputDevice } from './tizen-keys.js';

export type GestureKeyName =
  | 'DPAD_UP'
  | 'DPAD_DOWN'
  | 'DPAD_LEFT'
  | 'DPAD_RIGHT'
  | 'DPAD_CENTER'
  | 'BACK'
  | 'MENU'
  | 'MEDIA_PLAY_PAUSE'
  | 'MEDIA_FAST_FORWARD'
  | 'MEDIA_REWIND'
  | 'PROG_RED'
  | 'PROG_GREEN'
  | 'PROG_YELLOW'
  | 'PROG_BLUE'
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | 'E'
  | 'F'
  | 'G'
  | 'H'
  | 'I'
  | 'J'
  | 'K'
  | 'L'
  | 'M'
  | 'N'
  | 'O'
  | 'P'
  | 'Q'
  | 'R'
  | 'S'
  | 'T'
  | 'U'
  | 'V'
  | 'W'
  | 'X'
  | 'Y'
  | 'Z'
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | 'SHIFT';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';

function buildNames(): GestureKeyName[] {
  const names: GestureKeyName[] = [
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
  ];
  for (let i = 0; i < LETTERS.length; i++) names.push(LETTERS.charAt(i) as GestureKeyName);
  for (let i = 0; i < DIGITS.length; i++) names.push(DIGITS.charAt(i) as GestureKeyName);
  names.push('SHIFT');
  return names;
}

export const GESTURE_KEY_NAMES: readonly GestureKeyName[] = buildNames();
const NAME_SET: { [name: string]: true } = {};
for (const n of GESTURE_KEY_NAMES) NAME_SET[n] = true;

export function isGestureKeyName(raw: unknown): raw is GestureKeyName {
  return typeof raw === 'string' && NAME_SET[raw] === true;
}

export type TvGestureBinding =
  | { kind: 'longPress'; keys: [GestureKeyName]; holdMs: number }
  | { kind: 'sequence'; keys: GestureKeyName[]; windowMs: number }
  | { kind: 'chord'; keys: GestureKeyName[] };

export const DEFAULT_TV_BINDING: TvGestureBinding = {
  kind: 'longPress',
  keys: ['MEDIA_PLAY_PAUSE'],
  holdMs: 1500,
};

// The server's ranges (`device-link/gesture.ts`).
const HOLD_MIN_MS = 500;
const HOLD_MAX_MS = 5_000;
const WINDOW_MIN_MS = 300;
const WINDOW_MAX_MS = 5_000;

function intIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= min && v <= max;
}

function keyList(v: unknown, min: number, max: number): GestureKeyName[] | null {
  if (!Array.isArray(v) || v.length < min || v.length > max) return null;
  const out: GestureKeyName[] = [];
  for (const k of v as unknown[]) {
    if (!isGestureKeyName(k)) return null;
    out.push(k);
  }
  return out;
}

/**
 * The armed TV binding from the `captureGesture` block: an absent block (or
 * one without `tv`) is the contract default; an invalid binding is null, and
 * then the gesture is not armed.
 */
export function parseTvBinding(block: { tv?: unknown } | undefined): TvGestureBinding | null {
  try {
    if (!block || block.tv === undefined) return DEFAULT_TV_BINDING;
    const tv = block.tv as { kind?: unknown; keys?: unknown; holdMs?: unknown; windowMs?: unknown };
    if (!tv || typeof tv !== 'object') return null;
    switch (tv.kind) {
      case 'longPress': {
        const keys = keyList(tv.keys, 1, 1);
        if (!keys || !intIn(tv.holdMs, HOLD_MIN_MS, HOLD_MAX_MS)) return null;
        return { kind: 'longPress', keys: [keys[0] as GestureKeyName], holdMs: tv.holdMs };
      }
      case 'sequence': {
        const keys = keyList(tv.keys, 2, 8);
        if (!keys || !intIn(tv.windowMs, WINDOW_MIN_MS, WINDOW_MAX_MS)) return null;
        return { kind: 'sequence', keys, windowMs: tv.windowMs };
      }
      case 'chord': {
        const keys = keyList(tv.keys, 2, 4);
        if (!keys) return null;
        for (let i = 0; i < keys.length; i++) {
          if (keys.indexOf(keys[i] as GestureKeyName) !== i) return null;
        }
        return { kind: 'chord', keys };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function bindingsEqual(a: TvGestureBinding | null, b: TvGestureBinding | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind || a.keys.length !== b.keys.length) return false;
  for (let i = 0; i < a.keys.length; i++) if (a.keys[i] !== b.keys[i]) return false;
  if (a.kind === 'longPress') return a.holdMs === (b as typeof a).holdMs;
  if (a.kind === 'sequence') return a.windowMs === (b as typeof a).windowMs;
  return true;
}

/** True for a key a keyboard types: a letter, a digit or SHIFT. */
export function isTypingKey(name: GestureKeyName): boolean {
  return name === 'SHIFT' || name.length === 1;
}

/** A binding that types stands aside while a text field has focus. */
export function isTypingBinding(b: TvGestureBinding): boolean {
  for (const k of b.keys) if (isTypingKey(k)) return true;
  return false;
}

export interface RemoteKeyMap {
  codesFor(name: GestureKeyName): readonly number[];
  nameFor(keyCode: number, key: string): GestureKeyName | null;
}

// `KeyboardEvent.key` values used when an engine reports keyCode 0.
const KEY_NAMES: { [key: string]: GestureKeyName } = {
  ArrowUp: 'DPAD_UP',
  ArrowDown: 'DPAD_DOWN',
  ArrowLeft: 'DPAD_LEFT',
  ArrowRight: 'DPAD_RIGHT',
  Enter: 'DPAD_CENTER',
  MediaPlayPause: 'MEDIA_PLAY_PAUSE',
  MediaFastForward: 'MEDIA_FAST_FORWARD',
  MediaRewind: 'MEDIA_REWIND',
  ColorF0Red: 'PROG_RED',
  ColorF1Green: 'PROG_GREEN',
  ColorF2Yellow: 'PROG_YELLOW',
  ColorF3Blue: 'PROG_BLUE',
  Shift: 'SHIFT',
};
// With Play/Pause aliasing on, these `key` values count too.
const PLAY_PAUSE_KEYS = ['MediaPlay', 'MediaPause', 'Pause'];

function commonCodes(): { [name: string]: number[] } {
  const t: { [name: string]: number[] } = {
    DPAD_UP: [38],
    DPAD_DOWN: [40],
    DPAD_LEFT: [37],
    DPAD_RIGHT: [39],
    DPAD_CENTER: [13],
    MEDIA_FAST_FORWARD: [417],
    MEDIA_REWIND: [412],
    PROG_RED: [403],
    PROG_GREEN: [404],
    PROG_YELLOW: [405],
    PROG_BLUE: [406],
    SHIFT: [16],
  };
  for (let i = 0; i < LETTERS.length; i++) t[LETTERS.charAt(i)] = [65 + i];
  for (let i = 0; i < DIGITS.length; i++) t[DIGITS.charAt(i)] = [48 + i];
  return t;
}

function tizenCode(device: TizenInputDevice | null | undefined, name: string): number | null {
  try {
    if (!device || typeof device.getKey !== 'function') return null;
    const k = device.getKey(name);
    return k && typeof k.code === 'number' && isFinite(k.code) ? k.code : null;
  } catch {
    return null;
  }
}

/** The names in `getSupportedKeys()`, or null when the list is unavailable. */
export function tizenSupportedNames(
  device: TizenInputDevice | null | undefined,
): { [name: string]: true } | null {
  try {
    if (!device || typeof device.getSupportedKeys !== 'function') return null;
    const list = device.getSupportedKeys();
    if (!Array.isArray(list)) return null;
    const out: { [name: string]: true } = {};
    for (const k of list) if (k && typeof k.name === 'string') out[k.name] = true;
    return out;
  } catch {
    return null;
  }
}

export function createRemoteKeyMap(
  platform: TvPlatform,
  tizen?: TizenInputDevice | null,
): RemoteKeyMap {
  const codes = commonCodes();
  let aliasPlayPause: boolean;
  if (platform === 'webos') {
    codes.BACK = [461];
    codes.MENU = [];
    codes.MEDIA_PLAY_PAUSE = [415, 19, 179];
    aliasPlayPause = true;
  } else {
    const resolve = (tizenName: string, fallback: number): number =>
      tizenCode(tizen, tizenName) ?? fallback;
    codes.BACK = [10009];
    const menu = tizenCode(tizen, 'Menu');
    codes.MENU = menu === null ? [] : [menu];
    const playPause = [resolve('MediaPlayPause', 10252), 179];
    const supported = tizenSupportedNames(tizen);
    aliasPlayPause = supported !== null && supported.MediaPlayPause !== true;
    if (aliasPlayPause) playPause.push(resolve('MediaPlay', 415), resolve('MediaPause', 19));
    codes.MEDIA_PLAY_PAUSE = playPause;
    codes.MEDIA_FAST_FORWARD = [resolve('MediaFastForward', 417)];
    codes.MEDIA_REWIND = [resolve('MediaRewind', 412)];
    codes.PROG_RED = [resolve('ColorF0Red', 403)];
    codes.PROG_GREEN = [resolve('ColorF1Green', 404)];
    codes.PROG_YELLOW = [resolve('ColorF2Yellow', 405)];
    codes.PROG_BLUE = [resolve('ColorF3Blue', 406)];
  }

  const byCode: { [code: number]: GestureKeyName } = {};
  for (const name of GESTURE_KEY_NAMES) {
    for (const c of codes[name] ?? []) if (byCode[c] === undefined) byCode[c] = name;
  }

  return {
    codesFor(name: GestureKeyName): readonly number[] {
      return codes[name] ?? [];
    },
    nameFor(keyCode: number, key: string): GestureKeyName | null {
      if (typeof keyCode === 'number' && keyCode !== 0) return byCode[keyCode] ?? null;
      if (typeof key !== 'string' || key.length === 0) return null;
      const named = KEY_NAMES[key];
      if (named) return named;
      if (aliasPlayPause && PLAY_PAUSE_KEYS.indexOf(key) !== -1) return 'MEDIA_PLAY_PAUSE';
      if (key.length === 1) {
        const upper = key.toUpperCase();
        if (LETTERS.indexOf(upper) !== -1 || DIGITS.indexOf(upper) !== -1) {
          return upper as GestureKeyName;
        }
      }
      return null;
    },
  };
}
