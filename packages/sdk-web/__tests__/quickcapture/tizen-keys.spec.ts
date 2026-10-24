// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it, vi } from 'vitest';
import {
  ALL_TIZEN_KEY_NAMES,
  registerTizenKeys,
  tizenInputDevice,
  tizenKeyNamesFor,
  type TizenInputDevice,
} from '../../src/quickcapture/tizen-keys.js';

const SUPPORTED: Array<[string, number]> = [
  ['MediaPlayPause', 10252],
  ['MediaPlay', 415],
  ['MediaPause', 19],
  ['MediaFastForward', 417],
  ['MediaRewind', 412],
  ['ColorF0Red', 403],
  ['ColorF1Green', 404],
  ['ColorF2Yellow', 405],
  ['ColorF3Blue', 406],
  ['Menu', 18],
  ['0', 48],
  ['1', 49],
  ['2', 50],
  ['3', 51],
  ['4', 52],
  ['5', 53],
  ['6', 54],
  ['7', 55],
  ['8', 56],
  ['9', 57],
];

function device(supported: Array<[string, number]> = SUPPORTED) {
  const unregisterKey = vi.fn();
  const unregisterKeyBatch = vi.fn();
  const d = {
    getSupportedKeys: vi.fn(() => supported.map(([name, code]) => ({ name, code }))),
    getKey: vi.fn((n: string) => {
      const hit = supported.find(([name]) => name === n);
      return hit ? { name: hit[0], code: hit[1] } : null;
    }),
    registerKey: vi.fn(),
    registerKeyBatch: vi.fn((_names: string[], ok?: () => void) => ok?.()),
    unregisterKey,
    unregisterKeyBatch,
  };
  return d;
}

describe('tizenKeyNamesFor', () => {
  it('maps Menu, media, color and digit keys and nothing else', () => {
    expect(tizenKeyNamesFor(['MEDIA_PLAY_PAUSE'])).toEqual(['MediaPlayPause']);
    expect(
      tizenKeyNamesFor([
        'DPAD_UP',
        'DPAD_CENTER',
        'BACK',
        'MENU',
        'MEDIA_FAST_FORWARD',
        'MEDIA_REWIND',
        'PROG_RED',
        'PROG_GREEN',
        'PROG_YELLOW',
        'PROG_BLUE',
        '0',
        '9',
        'A',
        'SHIFT',
        'PROG_RED',
      ]),
    ).toEqual([
      'Menu',
      'MediaFastForward',
      'MediaRewind',
      'ColorF0Red',
      'ColorF1Green',
      'ColorF2Yellow',
      'ColorF3Blue',
      '0',
      '9',
    ]);
    expect(ALL_TIZEN_KEY_NAMES).toHaveLength(1 + 3 + 4 + 10);
    expect(ALL_TIZEN_KEY_NAMES).toContain('Menu');
  });
});

describe('registerTizenKeys', () => {
  it("registers only the binding's registrable keys, in one batch", () => {
    const d = device();
    registerTizenKeys(d, tizenKeyNamesFor(['MEDIA_PLAY_PAUSE']));
    expect(d.registerKeyBatch).toHaveBeenCalledTimes(1);
    expect(d.registerKeyBatch.mock.calls[0]![0]).toEqual(['MediaPlayPause']);
    expect(d.registerKey).not.toHaveBeenCalled();
  });

  it('registers Menu for a MENU binding on a TV that has it, and skips it otherwise', () => {
    const d = device();
    registerTizenKeys(d, tizenKeyNamesFor(['MENU']));
    expect(d.registerKeyBatch.mock.calls[0]![0]).toEqual(['Menu']);
    const without = device(SUPPORTED.filter(([n]) => n !== 'Menu'));
    registerTizenKeys(without, tizenKeyNamesFor(['MENU']));
    expect(without.registerKeyBatch).not.toHaveBeenCalled();
    expect(without.registerKey).not.toHaveBeenCalled();
  });

  it('registers nothing for an arrow-key binding', () => {
    const d = device();
    registerTizenKeys(d, tizenKeyNamesFor(['DPAD_UP', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_DOWN']));
    expect(d.registerKeyBatch).not.toHaveBeenCalled();
    expect(d.registerKey).not.toHaveBeenCalled();
  });

  it('registers MediaPlay and MediaPause when MediaPlayPause is unsupported', () => {
    const d = device(SUPPORTED.filter(([n]) => n !== 'MediaPlayPause'));
    registerTizenKeys(d, ['MediaPlayPause']);
    expect(d.registerKeyBatch.mock.calls[0]![0]).toEqual(['MediaPlay', 'MediaPause']);
  });

  it('skips keys the TV does not support', () => {
    const d = device(SUPPORTED.filter(([n]) => n !== 'ColorF3Blue'));
    registerTizenKeys(d, ['ColorF0Red', 'ColorF3Blue']);
    expect(d.registerKeyBatch.mock.calls[0]![0]).toEqual(['ColorF0Red']);
  });

  it('falls back to registerKey per key and swallows a missing privilege', () => {
    const noBatch = device();
    const plain: TizenInputDevice = {
      getSupportedKeys: noBatch.getSupportedKeys,
      registerKey: vi.fn(() => {
        throw new Error('SecurityError');
      }),
    };
    expect(() => registerTizenKeys(plain, ['MediaPlayPause', 'ColorF0Red'])).not.toThrow();
    expect(plain.registerKey).toHaveBeenCalledTimes(2);

    // The batch reports an error: each key is tried on its own.
    const failing = device();
    failing.registerKeyBatch.mockImplementation(
      (_n: string[], _ok?: () => void, err?: (e: unknown) => void) => err?.(new Error('x')),
    );
    expect(() => registerTizenKeys(failing, ['MediaPlayPause', 'ColorF0Red'])).not.toThrow();
    expect(failing.registerKey.mock.calls.map((c) => c[0])).toEqual([
      'MediaPlayPause',
      'ColorF0Red',
    ]);

    // The batch throws synchronously: the same.
    const throwing = device();
    throwing.registerKeyBatch.mockImplementation(() => {
      throw new Error('SecurityError');
    });
    throwing.registerKey.mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => registerTizenKeys(throwing, ['MediaPlayPause'])).not.toThrow();
    expect(throwing.registerKey).toHaveBeenCalledWith('MediaPlayPause');

    // getSupportedKeys throws: register what was asked.
    const blind = device();
    blind.getSupportedKeys.mockImplementation(() => {
      throw new Error('SecurityError');
    });
    registerTizenKeys(blind, ['MediaPlayPause']);
    expect(blind.registerKeyBatch.mock.calls[0]![0]).toEqual(['MediaPlayPause']);
  });

  it('does not register a key twice on the same device', () => {
    const d = device();
    registerTizenKeys(d, ['MediaPlayPause']);
    registerTizenKeys(d, ['MediaPlayPause', 'ColorF0Red']);
    expect(d.registerKeyBatch.mock.calls.map((c) => c[0])).toEqual([
      ['MediaPlayPause'],
      ['ColorF0Red'],
    ]);
  });

  it('never unregisters', () => {
    const d = device();
    registerTizenKeys(d, ALL_TIZEN_KEY_NAMES.slice());
    registerTizenKeys(d, []);
    registerTizenKeys(d, ['MediaPlayPause']);
    expect(d.unregisterKey).not.toHaveBeenCalled();
    expect(d.unregisterKeyBatch).not.toHaveBeenCalled();
  });

  it('does nothing without the tizen global', () => {
    expect(tizenInputDevice({})).toBeNull();
    expect(tizenInputDevice({ tizen: {} })).toBeNull();
    expect(tizenInputDevice(undefined)).toBeNull();
    expect(
      tizenInputDevice(
        Object.defineProperty({}, 'tizen', {
          get() {
            throw new Error('denied');
          },
        }),
      ),
    ).toBeNull();
    expect(() => registerTizenKeys(null, ['MediaPlayPause'])).not.toThrow();
    const d = device();
    expect(tizenInputDevice({ tizen: { tvinputdevice: d } })).toBe(d);
  });
});
