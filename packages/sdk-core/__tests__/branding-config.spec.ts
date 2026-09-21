// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Branding block (watermark + theme, spec 2026-08-25) — lenient client-side
// parse posture, mirroring companionBadge: a malformed BLOCK degrades to
// absent (SDK stays watermarked + default-themed — fail closed), never fails
// the whole config parse; a malformed FIELD inside `theme` degrades only that
// field, so `watermark: false` (the entitlement signal) survives a bad color.
import { describe, it, expect } from 'vitest';
import {
  ReplayConfigResponse,
  getBrandingServerConfig,
} from '../src/types/replay/config-provider.js';

const BASE = { replayEnabled: false, replayDurationSec: 30, samplingRate: 1 };

function parse(body: unknown) {
  const parsed = ReplayConfigResponse.safeParse(body);
  expect(parsed.success).toBe(true);
  return parsed.success ? parsed.data : (undefined as never);
}

describe('branding server config (client parse)', () => {
  it('parses a full branding block and exposes it via the getter', () => {
    const cfg = parse({
      ...BASE,
      branding: { watermark: false, theme: { accent: '#336699', background: '#101215' } },
    });
    expect(getBrandingServerConfig(cfg)).toEqual({
      watermark: false,
      theme: { accent: '#336699', background: '#101215' },
    });
  });

  it('absent block → undefined (old server / not negotiated / free plan posture)', () => {
    expect(getBrandingServerConfig(parse(BASE))).toBeUndefined();
  });

  it('a malformed BLOCK degrades to absent without failing the whole parse', () => {
    const cfg = parse({ ...BASE, branding: { watermark: 'yes' } });
    expect(getBrandingServerConfig(cfg)).toBeUndefined();
    expect(cfg.replayDurationSec).toBe(30); // unrelated blocks survive
  });

  it('a bad hex in ONE theme field degrades only that field — watermark survives', () => {
    const cfg = parse({
      ...BASE,
      branding: { watermark: false, theme: { accent: 'red', background: '#101215' } },
    });
    expect(getBrandingServerConfig(cfg)).toEqual({
      watermark: false,
      theme: { background: '#101215' },
    });
  });

  it('unknown keys inside branding and inside theme are stripped, not fatal', () => {
    const cfg = parse({
      ...BASE,
      branding: { watermark: true, futureFlag: 1, theme: { accent: '#336699', futureRole: '#000000' } },
    });
    expect(getBrandingServerConfig(cfg)).toEqual({ watermark: true, theme: { accent: '#336699' } });
  });

  it('a malformed theme SUB-OBJECT degrades to theme-absent — watermark survives', () => {
    const cfg = parse({ ...BASE, branding: { watermark: false, theme: 'dark' } });
    expect(getBrandingServerConfig(cfg)).toEqual({ watermark: false });
  });
});
