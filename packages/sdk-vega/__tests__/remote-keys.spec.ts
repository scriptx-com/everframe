// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { GESTURE_KEYS, keyAction, keyForVegaEvent, vegaKeySupported } from '../src/remote-keys.js';

describe('remote keys', () => {
  it('mapsEveryContractKeyVegaHas', () => {
    // Event names measured on the Vega Virtual Device (OS 1.1), 2026-10-24.
    const table: Array<[string, string]> = [
      ['up', 'DPAD_UP'],
      ['down', 'DPAD_DOWN'],
      ['left', 'DPAD_LEFT'],
      ['right', 'DPAD_RIGHT'],
      ['select', 'DPAD_CENTER'],
      ['back', 'BACK'],
      ['menu', 'MENU'],
      ['playpause', 'MEDIA_PLAY_PAUSE'],
      ['skip_forward', 'MEDIA_FAST_FORWARD'],
      ['forward', 'MEDIA_FAST_FORWARD'],
      ['skip_backward', 'MEDIA_REWIND'],
      ['rewind', 'MEDIA_REWIND'],
    ];
    for (let d = 0; d <= 9; d++) table.push([`num_${d}`, String(d)]);
    for (const [event, key] of table) {
      expect(keyForVegaEvent(event)).toBe(key);
      expect(vegaKeySupported(key as never)).toBe(true);
    }
  });

  it('lettersShiftAndColorsUnsupported', () => {
    for (const key of [
      'A',
      'Z',
      'B',
      'SHIFT',
      'PROG_RED',
      'PROG_GREEN',
      'PROG_YELLOW',
      'PROG_BLUE',
    ])
      expect(vegaKeySupported(key as never)).toBe(false);
    expect(GESTURE_KEYS).toContain('SHIFT');
    expect(GESTURE_KEYS).toContain('A');
    expect(GESTURE_KEYS).toHaveLength(14 + 26 + 10 + 1);
  });

  it('unknownEventIsNull', () => {
    for (const raw of [
      'unknown',
      'left_shift',
      'media_next',
      'pause',
      'red',
      '',
      'PLAYPAUSE',
      null,
      42,
      {},
    ])
      expect(keyForVegaEvent(raw)).toBeNull();
  });

  it('actionValues', () => {
    expect(keyAction(0)).toBe('down');
    expect(keyAction(1)).toBe('up');
    for (const raw of [-1, 2, '0', '1', null, undefined, 0.5]) expect(keyAction(raw)).toBeNull();
  });
});
