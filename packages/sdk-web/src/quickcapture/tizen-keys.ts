// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture (Samsung Tizen): registering remote keys so they
// reach the page. Arrows, Enter and Back are delivered without registration;
// Menu, media, color and digit keys need `tizen.tvinputdevice.registerKey` and the
// app's `http://tizen.org/privilege/tv.inputdevice` privilege. Lazy chunk.
//
// The SDK registers only on a linked TV or a debug build (and for the whole
// contract while recording), and NEVER unregisters: the app may have
// registered the same key itself, and Tizen keeps one registration per app.
import { globalScope } from '../internal/global-scope.js';
import { GESTURE_KEY_NAMES, tizenSupportedNames, type GestureKeyName } from './remote-keys.js';

export interface TizenInputDevice {
  getKey?(n: string): { name: string; code: number } | null;
  getSupportedKeys?(): Array<{ name: string; code: number }>;
  registerKey?(n: string): void;
  registerKeyBatch?(n: string[], ok?: () => void, err?: (e: unknown) => void): void;
}

/** `tizen.tvinputdevice`, or null when this is not a Tizen engine with the API. */
export function tizenInputDevice(win?: unknown): TizenInputDevice | null {
  try {
    const scope = (win === undefined ? globalScope() : win) as {
      tizen?: { tvinputdevice?: unknown };
    } | null;
    if (!scope || typeof scope !== 'object') return null;
    const tizen = scope.tizen;
    const device = tizen && typeof tizen === 'object' ? tizen.tvinputdevice : undefined;
    return device && typeof device === 'object' ? (device as TizenInputDevice) : null;
  } catch {
    return null;
  }
}

const TIZEN_NAMES: { [name: string]: string } = {
  MENU: 'Menu',
  MEDIA_PLAY_PAUSE: 'MediaPlayPause',
  MEDIA_FAST_FORWARD: 'MediaFastForward',
  MEDIA_REWIND: 'MediaRewind',
  PROG_RED: 'ColorF0Red',
  PROG_GREEN: 'ColorF1Green',
  PROG_YELLOW: 'ColorF2Yellow',
  PROG_BLUE: 'ColorF3Blue',
  '0': '0',
  '1': '1',
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
};

/** The registrable Tizen names among `names`, deduplicated, in order. */
export function tizenKeyNamesFor(names: readonly GestureKeyName[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const t = TIZEN_NAMES[n];
    if (t !== undefined && out.indexOf(t) === -1) out.push(t);
  }
  return out;
}

/** Every registrable key in the contract (record on device). */
export const ALL_TIZEN_KEY_NAMES: readonly string[] = tizenKeyNamesFor(GESTURE_KEY_NAMES);

// Keys this SDK registered on a device, so a routine re-arm does not repeat it.
const registered = new WeakMap<object, { [name: string]: true }>();

function registerOne(device: TizenInputDevice, name: string, done: { [n: string]: true }): void {
  try {
    if (typeof device.registerKey !== 'function') return;
    device.registerKey(name);
    done[name] = true;
  } catch {
    /* a missing privilege or an unsupported key: the key just won't arrive */
  }
}

/**
 * Registers `tizenNames` (from `tizenKeyNamesFor`) on the device. Keys the TV
 * does not list as supported are skipped; MediaPlayPause becomes MediaPlay and
 * MediaPause on a TV without it. Never unregisters, never throws.
 */
export function registerTizenKeys(device: TizenInputDevice | null, tizenNames: string[]): void {
  try {
    if (!device || !tizenNames || tizenNames.length === 0) return;
    let done = registered.get(device);
    if (!done) {
      done = {};
      registered.set(device, done);
    }
    const doneSet = done;
    const supported = tizenSupportedNames(device);
    const wanted: string[] = [];
    const add = (n: string): void => {
      if (supported !== null && supported[n] !== true) return;
      if (doneSet[n] === true || wanted.indexOf(n) !== -1) return;
      wanted.push(n);
    };
    for (const n of tizenNames) {
      if (n === 'MediaPlayPause' && supported !== null && supported.MediaPlayPause !== true) {
        add('MediaPlay');
        add('MediaPause');
      } else {
        add(n);
      }
    }
    if (wanted.length === 0) return;
    const oneByOne = (): void => {
      for (const n of wanted) {
        delete doneSet[n];
        registerOne(device, n, doneSet);
      }
    };
    if (typeof device.registerKeyBatch !== 'function') {
      oneByOne();
      return;
    }
    // Counted as registered from the call on (the success callback may come
    // later); a failed batch falls back to one key at a time.
    for (const n of wanted) doneSet[n] = true;
    let failed = false;
    const fail = (): void => {
      if (failed) return;
      failed = true;
      try {
        oneByOne();
      } catch {
        /* DEFE-02 */
      }
    };
    try {
      device.registerKeyBatch(wanted.slice(), () => undefined, fail);
    } catch {
      fail();
    }
  } catch {
    /* DEFE-02 */
  }
}
