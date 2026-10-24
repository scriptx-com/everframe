// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import {
  bindingsEqual,
  createRemoteKeyMap,
  DEFAULT_TV_BINDING,
  GESTURE_KEY_NAMES,
  isTypingBinding,
  parseTvBinding,
  type GestureKeyName,
} from '../../src/quickcapture/remote-keys.js';
import type { TizenInputDevice } from '../../src/quickcapture/tizen-keys.js';

function tizenDevice(supported: Array<[string, number]>): TizenInputDevice {
  const keys = supported.map(([name, code]) => ({ name, code }));
  return {
    getKey: (n: string) => keys.find((k) => k.name === n) ?? null,
    getSupportedKeys: () => keys,
  };
}

describe('parseTvBinding', () => {
  it('parses the three kinds and refuses out-of-range values', () => {
    expect(
      parseTvBinding({ tv: { kind: 'longPress', keys: ['MEDIA_PLAY_PAUSE'], holdMs: 1500 } }),
    ).toEqual(DEFAULT_TV_BINDING);
    expect(
      parseTvBinding({
        tv: {
          kind: 'sequence',
          keys: ['DPAD_UP', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_DOWN'],
          windowMs: 1000,
        },
      }),
    ).toEqual({
      kind: 'sequence',
      keys: ['DPAD_UP', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_DOWN'],
      windowMs: 1000,
    });
    expect(parseTvBinding({ tv: { kind: 'chord', keys: ['SHIFT', 'B'] } })).toEqual({
      kind: 'chord',
      keys: ['SHIFT', 'B'],
    });
    for (const tv of [
      { kind: 'longPress', keys: ['MEDIA_PLAY_PAUSE'], holdMs: 499 },
      { kind: 'longPress', keys: ['BACK'], holdMs: 5001 },
      { kind: 'sequence', keys: ['DPAD_UP'], windowMs: 1000 },
      { kind: 'sequence', keys: Array(9).fill('DPAD_UP'), windowMs: 1000 },
      { kind: 'sequence', keys: ['DPAD_UP', 'DPAD_UP'], windowMs: 299 },
      { kind: 'sequence', keys: ['DPAD_UP', 'DPAD_UP'], windowMs: 5001 },
      { kind: 'chord', keys: ['SHIFT', 'SHIFT'] },
      { kind: 'chord', keys: ['SHIFT', 'POWER'] },
      { kind: 'chord', keys: ['A', 'B', 'C', 'D', 'E'] },
      { kind: 'chord', keys: ['A'] },
      { kind: 'swipe', keys: [] },
      { kind: 'longPress', keys: ['BACK'], holdMs: 1500.5 },
      { kind: 'longPress', keys: ['BACK', 'MENU'], holdMs: 1500 },
      { kind: 'longPress', keys: 'BACK', holdMs: 1500 },
      { kind: 'longPress', keys: ['BACK'], holdMs: '1500' },
      { kind: 'longPress', keys: ['BACK'], holdMs: Infinity },
      'longPress',
      null,
      42,
    ])
      expect(parseTvBinding({ tv })).toBeNull();
  });

  it('an absent captureGesture block uses the contract default', () => {
    expect(parseTvBinding(undefined)).toEqual(DEFAULT_TV_BINDING);
    expect(parseTvBinding({})).toEqual(DEFAULT_TV_BINDING);
    expect(DEFAULT_TV_BINDING).toEqual({
      kind: 'longPress',
      keys: ['MEDIA_PLAY_PAUSE'],
      holdMs: 1500,
    });
  });

  it('returns a fresh binding that does not alias the wire arrays', () => {
    const keys = ['DPAD_UP', 'DPAD_DOWN'];
    const b = parseTvBinding({ tv: { kind: 'sequence', keys, windowMs: 1000 } });
    keys.push('BACK');
    expect(b?.keys).toEqual(['DPAD_UP', 'DPAD_DOWN']);
  });
});

describe('bindingsEqual and isTypingBinding', () => {
  it('compares kind, keys in order and the duration', () => {
    const seq = { kind: 'sequence' as const, keys: ['DPAD_UP', 'DPAD_DOWN'] as GestureKeyName[] };
    expect(bindingsEqual(DEFAULT_TV_BINDING, { ...DEFAULT_TV_BINDING })).toBe(true);
    expect(
      bindingsEqual(DEFAULT_TV_BINDING, {
        kind: 'longPress',
        keys: ['MEDIA_PLAY_PAUSE'],
        holdMs: 2000,
      }),
    ).toBe(false);
    expect(bindingsEqual({ ...seq, windowMs: 1000 }, { ...seq, windowMs: 1000 })).toBe(true);
    expect(
      bindingsEqual(
        { ...seq, windowMs: 1000 },
        { kind: 'sequence', keys: ['DPAD_DOWN', 'DPAD_UP'], windowMs: 1000 },
      ),
    ).toBe(false);
    expect(bindingsEqual(null, null)).toBe(true);
    expect(bindingsEqual(DEFAULT_TV_BINDING, null)).toBe(false);
  });

  it('a binding with a letter, a digit or SHIFT types', () => {
    expect(isTypingBinding(DEFAULT_TV_BINDING)).toBe(false);
    expect(isTypingBinding({ kind: 'chord', keys: ['SHIFT', 'B'] })).toBe(true);
    expect(isTypingBinding({ kind: 'sequence', keys: ['1', '2'], windowMs: 1000 })).toBe(true);
    expect(isTypingBinding({ kind: 'chord', keys: ['PROG_RED', 'PROG_BLUE'] })).toBe(false);
  });
});

describe('createRemoteKeyMap', () => {
  it('webOS maps Play and Pause to MEDIA_PLAY_PAUSE', () => {
    const map = createRemoteKeyMap('webos');
    expect(map.nameFor(415, 'MediaPlay')).toBe('MEDIA_PLAY_PAUSE');
    expect(map.nameFor(19, 'Pause')).toBe('MEDIA_PLAY_PAUSE');
    expect(map.nameFor(179, 'MediaPlayPause')).toBe('MEDIA_PLAY_PAUSE');
    expect(map.codesFor('MEDIA_PLAY_PAUSE')).toEqual([415, 19, 179]);
    expect(map.nameFor(461, '')).toBe('BACK');
    expect(map.nameFor(10009, '')).toBeNull();
  });

  it('Tizen resolves codes through tvinputdevice.getKey and falls back to the table', () => {
    const resolved = createRemoteKeyMap(
      'tizen',
      tizenDevice([
        ['MediaPlayPause', 20252],
        ['MediaFastForward', 20417],
        ['ColorF0Red', 20403],
        ['Menu', 18],
      ]),
    );
    expect(resolved.nameFor(20252, '')).toBe('MEDIA_PLAY_PAUSE');
    expect(resolved.nameFor(179, '')).toBe('MEDIA_PLAY_PAUSE');
    expect(resolved.nameFor(10252, '')).toBeNull();
    expect(resolved.nameFor(20417, '')).toBe('MEDIA_FAST_FORWARD');
    expect(resolved.nameFor(20403, '')).toBe('PROG_RED');
    expect(resolved.nameFor(18, '')).toBe('MENU');
    // Not in getKey: the table.
    expect(resolved.nameFor(412, '')).toBe('MEDIA_REWIND');
    expect(resolved.nameFor(10009, '')).toBe('BACK');

    const fallback = createRemoteKeyMap('tizen', null);
    expect(fallback.nameFor(10252, '')).toBe('MEDIA_PLAY_PAUSE');
    expect(fallback.nameFor(179, '')).toBe('MEDIA_PLAY_PAUSE');
    expect(fallback.nameFor(417, '')).toBe('MEDIA_FAST_FORWARD');
    expect(fallback.nameFor(403, '')).toBe('PROG_RED');
    expect(fallback.codesFor('MENU')).toEqual([]);
    expect(fallback.nameFor(461, '')).toBeNull();
  });

  it('a getKey that throws falls back to the table', () => {
    const map = createRemoteKeyMap('tizen', {
      getKey: () => {
        throw new Error('not supported');
      },
      getSupportedKeys: () => {
        throw new Error('no privilege');
      },
    });
    expect(map.nameFor(10252, '')).toBe('MEDIA_PLAY_PAUSE');
    expect(map.nameFor(415, '')).toBeNull();
  });

  it('Tizen aliases Play and Pause only when MediaPlayPause is unsupported', () => {
    const combined = createRemoteKeyMap(
      'tizen',
      tizenDevice([
        ['MediaPlayPause', 10252],
        ['MediaPlay', 415],
        ['MediaPause', 19],
      ]),
    );
    expect(combined.nameFor(415, 'MediaPlay')).toBeNull();
    expect(combined.nameFor(19, 'Pause')).toBeNull();

    const split = createRemoteKeyMap(
      'tizen',
      tizenDevice([
        ['MediaPlay', 415],
        ['MediaPause', 19],
      ]),
    );
    expect(split.nameFor(415, 'MediaPlay')).toBe('MEDIA_PLAY_PAUSE');
    expect(split.nameFor(19, 'Pause')).toBe('MEDIA_PLAY_PAUSE');
    expect(split.nameFor(10252, '')).toBe('MEDIA_PLAY_PAUSE');
  });

  it('nameFor falls back to KeyboardEvent.key when keyCode is 0', () => {
    for (const platform of ['webos', 'tizen'] as const) {
      const map = createRemoteKeyMap(platform, null);
      expect(map.nameFor(0, 'ArrowUp')).toBe('DPAD_UP');
      expect(map.nameFor(0, 'ArrowDown')).toBe('DPAD_DOWN');
      expect(map.nameFor(0, 'ArrowLeft')).toBe('DPAD_LEFT');
      expect(map.nameFor(0, 'ArrowRight')).toBe('DPAD_RIGHT');
      expect(map.nameFor(0, 'Enter')).toBe('DPAD_CENTER');
      expect(map.nameFor(0, 'MediaPlayPause')).toBe('MEDIA_PLAY_PAUSE');
      expect(map.nameFor(0, 'MediaFastForward')).toBe('MEDIA_FAST_FORWARD');
      expect(map.nameFor(0, 'MediaRewind')).toBe('MEDIA_REWIND');
      expect(map.nameFor(0, 'ColorF0Red')).toBe('PROG_RED');
      expect(map.nameFor(0, 'ColorF1Green')).toBe('PROG_GREEN');
      expect(map.nameFor(0, 'ColorF2Yellow')).toBe('PROG_YELLOW');
      expect(map.nameFor(0, 'ColorF3Blue')).toBe('PROG_BLUE');
      expect(map.nameFor(0, 'b')).toBe('B');
      expect(map.nameFor(0, 'B')).toBe('B');
      expect(map.nameFor(0, '7')).toBe('7');
      expect(map.nameFor(0, 'Shift')).toBe('SHIFT');
      expect(map.nameFor(0, 'Unidentified')).toBeNull();
      expect(map.nameFor(0, '')).toBeNull();
      expect(map.nameFor(0, 'é')).toBeNull();
    }
    // A non-zero code that is not in the table is not rescued by `key`.
    expect(createRemoteKeyMap('webos').nameFor(1234, 'ArrowUp')).toBeNull();
  });

  it('every contract key has a webOS mapping except MENU', () => {
    const map = createRemoteKeyMap('webos');
    expect(GESTURE_KEY_NAMES).toHaveLength(14 + 26 + 10 + 1);
    for (const name of GESTURE_KEY_NAMES) {
      const codes = map.codesFor(name);
      if (name === 'MENU') {
        expect(codes).toEqual([]);
        continue;
      }
      expect(codes.length).toBeGreaterThan(0);
      for (const code of codes) expect(map.nameFor(code, '')).toBe(name);
    }
    expect(map.nameFor(65, 'a')).toBe('A');
    expect(map.nameFor(90, 'z')).toBe('Z');
    expect(map.nameFor(48, '0')).toBe('0');
    expect(map.nameFor(57, '9')).toBe('9');
    expect(map.nameFor(16, 'Shift')).toBe('SHIFT');
  });

  it('every contract key except MENU and BACK maps the same on Tizen without a device', () => {
    const webos = createRemoteKeyMap('webos');
    const tizen = createRemoteKeyMap('tizen', null);
    for (const name of GESTURE_KEY_NAMES) {
      if (name === 'MENU' || name === 'BACK' || name === 'MEDIA_PLAY_PAUSE') continue;
      expect(tizen.codesFor(name)).toEqual(webos.codesFor(name));
    }
    expect(tizen.codesFor('BACK')).toEqual([10009]);
    expect(tizen.codesFor('MEDIA_PLAY_PAUSE')).toEqual([10252, 179]);
  });
});
