// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { describe, it, expect } from 'vitest';
import { relay } from '../src/index.js';

describe('PairBonded companion fields', () => {
  it('accepts a bond carrying companion_user and attribution_token', () => {
    const parsed = relay.PairBonded.parse({
      type: 'pair.bonded',
      pair_id: 'p1',
      device_token: 'dt',
      device_token_expires_at: '2026-08-07T10:00:00.000Z',
      companion_user: { display_name: 'Aurimas', email: 'aurimas@scriptx.com' },
      attribution_token: 'att.token.value',
    });
    expect(parsed.companion_user?.display_name).toBe('Aurimas');
    expect(parsed.attribution_token).toBe('att.token.value');
  });

  it('still accepts a QR bond with neither field (backward compatible)', () => {
    const parsed = relay.PairBonded.parse({ type: 'pair.bonded', pair_id: 'p1' });
    expect(parsed.companion_user).toBeUndefined();
    expect(parsed.attribution_token).toBeUndefined();
  });

  it('rejects a companion_user missing display_name', () => {
    expect(() =>
      relay.PairBonded.parse({
        type: 'pair.bonded',
        pair_id: 'p1',
        companion_user: { email: 'a@b.com' },
      }),
    ).toThrow();
  });

  it('never sends user_id to the device', () => {
    const parsed = relay.PairBonded.parse({
      type: 'pair.bonded',
      pair_id: 'p1',
      companion_user: { display_name: 'Aurimas', user_id: 'leaked' },
    });
    expect((parsed.companion_user as Record<string, unknown>).user_id).toBeUndefined();
  });
});

describe('preview messages', () => {
  it('round-trips preview.start', () => {
    const msg = { type: 'preview.start', correlation_id: 'c1' };
    expect(relay.RelayMessage.parse(msg)).toEqual(msg);
  });

  it('round-trips preview.stop with a reason', () => {
    const msg = { type: 'preview.stop', correlation_id: 'c1', reason: 'user' as const };
    expect(relay.RelayMessage.parse(msg)).toEqual(msg);
  });

  it('rejects a preview.stop reason outside the catalog', () => {
    expect(() =>
      relay.RelayMessage.parse({ type: 'preview.stop', correlation_id: 'c1', reason: 'whatever' }),
    ).toThrow();
  });

  it('round-trips preview.frame and pins the announced geometry', () => {
    const msg = {
      type: 'preview.frame',
      correlation_id: 'c1',
      seq: 7,
      mime: 'image/jpeg' as const,
      width: 854,
      height: 480,
    };
    expect(relay.RelayMessage.parse(msg)).toEqual(msg);
  });

  it('rejects a preview.frame with a non-positive dimension', () => {
    expect(() =>
      relay.RelayMessage.parse({
        type: 'preview.frame',
        correlation_id: 'c1',
        seq: 1,
        mime: 'image/jpeg',
        width: 0,
        height: 480,
      }),
    ).toThrow();
  });
});

describe('shot messages', () => {
  it('round-trips a full-screen shot.request (no rect)', () => {
    const msg = { type: 'shot.request', correlation_id: 'c1', shot_id: 's1' };
    expect(relay.RelayMessage.parse(msg)).toEqual(msg);
  });

  it('round-trips a cropped shot.request', () => {
    const msg = {
      type: 'shot.request',
      correlation_id: 'c1',
      shot_id: 's1',
      rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.25 },
    };
    expect(relay.RelayMessage.parse(msg)).toEqual(msg);
  });

  it('rejects a rect outside the normalized 0–1 space', () => {
    expect(() =>
      relay.RelayMessage.parse({
        type: 'shot.request',
        correlation_id: 'c1',
        shot_id: 's1',
        rect: { x: 0.1, y: 0.2, w: 1.5, h: 0.25 },
      }),
    ).toThrow();
  });

  it('round-trips shot.assembled', () => {
    const msg = {
      type: 'shot.assembled',
      correlation_id: 'c1',
      shot_id: 's1',
      mime: 'image/webp' as const,
      width: 3840,
      height: 2160,
      size: 91_233,
    };
    expect(relay.RelayMessage.parse(msg)).toEqual(msg);
  });

  it('round-trips shot.failed', () => {
    const msg = {
      type: 'shot.failed',
      correlation_id: 'c1',
      shot_id: 's1',
      reason: 'no_foreground_activity',
    };
    expect(relay.RelayMessage.parse(msg)).toEqual(msg);
  });

  it('round-trips shot.binary, the ordering marker before a submit image', () => {
    const msg = { type: 'shot.binary', correlation_id: 'c1', shot_id: 's1' };
    expect(relay.RelayMessage.parse(msg)).toEqual(msg);
  });
});

describe('report.submit shots', () => {
  it('accepts a submit with no shots — wire-compatible with single-shot TVs', () => {
    const msg = {
      type: 'report.submit',
      correlation_id: 'c1',
      title: 't',
      description: { text: 'd', redactions: [] },
      annotations: [],
      includes: { logs: true, network: true, uiTree: true, metadata: true, screenshot: true as const },
    };
    expect(relay.RelayMessage.parse(msg)).toEqual(msg);
  });

  it('round-trips per-shot annotations', () => {
    const msg = {
      type: 'report.submit',
      correlation_id: 'c1',
      title: 't',
      description: { text: 'd', redactions: [] },
      annotations: [],
      includes: { logs: true, network: true, uiTree: true, metadata: true, screenshot: true as const },
      shots: [
        {
          shot_id: 's2',
          annotations: [{ kind: 'blur' as const, rect: { x: 1, y: 2, w: 3, h: 4 } }],
        },
      ],
    };
    expect(relay.RelayMessage.parse(msg)).toEqual(msg);
  });
});

describe('companion.name', () => {
  it('parses a server→device name update', () => {
    const frame = { type: 'companion.name', name: 'Pixel 7 · Android 14 · Emulator' };
    const parsed = relay.RelayMessage.parse(frame);
    expect(parsed).toEqual(frame);
  });

  it('rejects an empty and an over-long name', () => {
    expect(relay.RelayMessage.safeParse({ type: 'companion.name', name: '' }).success).toBe(false);
    expect(
      relay.RelayMessage.safeParse({ type: 'companion.name', name: 'x'.repeat(81) }).success,
    ).toBe(false);
  });
});
