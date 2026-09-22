// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report Resource Window (spec 2026-09-05) — client parse of the
// capability-negotiated `resources` block. Same lenient posture as
// branding/companionBadge: a malformed BLOCK degrades to absent (the
// feature stays OFF), never fails the whole `GET /api/config` parse; a
// malformed `windowSec` alone degrades only that field, so `enabled` still
// comes through.
import { describe, it, expect } from 'vitest';
import {
  ReplayConfigResponse,
  getResourcesServerConfig,
} from '../src/types/replay/config-provider.js';

const BASE = { replayEnabled: false, replayDurationSec: 30, samplingRate: 1 };

function parse(body: unknown) {
  const parsed = ReplayConfigResponse.safeParse(body);
  expect(parsed.success).toBe(true);
  return parsed.success ? parsed.data : (undefined as never);
}

describe('resources server config (client parse)', () => {
  it('parses a full resources block and exposes it via the getter', () => {
    const cfg = parse({ ...BASE, resources: { enabled: true, windowSec: 60 } });
    expect(getResourcesServerConfig(cfg)).toEqual({ enabled: true, windowSec: 60 });
  });

  it('absent block → undefined (old server / not negotiated / feature off)', () => {
    expect(getResourcesServerConfig(parse(BASE))).toBeUndefined();
  });

  it('a malformed BLOCK degrades to absent without failing the whole parse', () => {
    const cfg = parse({ ...BASE, resources: { enabled: 'yes' } });
    expect(getResourcesServerConfig(cfg)).toBeUndefined();
    expect(cfg.replayDurationSec).toBe(30); // unrelated fields survive
  });

  it('a malformed windowSec degrades only that field — enabled survives', () => {
    const cfg = parse({ ...BASE, resources: { enabled: true, windowSec: -5 } });
    expect(getResourcesServerConfig(cfg)).toEqual({ enabled: true });
  });

  it('unknown keys inside resources are stripped, not fatal', () => {
    const cfg = parse({
      ...BASE,
      resources: { enabled: false, windowSec: 30, futureFlag: 1 },
    });
    expect(getResourcesServerConfig(cfg)).toEqual({ enabled: false, windowSec: 30 });
  });

  it('does not affect the unrelated vitals fields, and vice versa', () => {
    const cfg = parse({
      ...BASE,
      resources: { enabled: true, windowSec: 120 },
      vitalsEnabled: true,
      vitalsSampleRate: 0.5,
    });
    expect(getResourcesServerConfig(cfg)).toEqual({ enabled: true, windowSec: 120 });
    expect(cfg.vitalsEnabled).toBe(true);
    expect(cfg.vitalsSampleRate).toBe(0.5);
  });
});
