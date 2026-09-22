// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import {
  ReplayConfigResponse,
  getCompanionBadgeServerConfig,
} from '../src/index.js';

const BASE = { replayEnabled: true, replayDurationSec: 30, samplingRate: 1 };

describe('companionBadge server config', () => {
  it('parses a valid block', () => {
    const cfg = ReplayConfigResponse.parse({
      ...BASE, companionBadge: { enabled: false, position: 'top-left' },
    });
    expect(getCompanionBadgeServerConfig(cfg)).toEqual({ enabled: false, position: 'top-left' });
  });
  it('returns undefined when the block is absent', () => {
    expect(getCompanionBadgeServerConfig(ReplayConfigResponse.parse(BASE))).toBeUndefined();
  });
  it('degrades a malformed block to undefined without failing the whole parse', () => {
    const cfg = ReplayConfigResponse.parse({ ...BASE, companionBadge: { enabled: 'yes' } });
    expect(cfg.replayEnabled).toBe(true);
    expect(getCompanionBadgeServerConfig(cfg)).toBeUndefined();
  });
  it('strips unknown nested fields instead of failing', () => {
    const cfg = ReplayConfigResponse.parse({
      ...BASE, companionBadge: { enabled: true, position: 'top-right', future: 1 },
    });
    expect(getCompanionBadgeServerConfig(cfg)).toEqual({ enabled: true, position: 'top-right' });
  });
  it('an unrecognized position degrades only the position, never the enabled override', () => {
    const cfg = ReplayConfigResponse.parse({
      ...BASE, companionBadge: { enabled: false, position: 'center' },
    });
    expect(getCompanionBadgeServerConfig(cfg)).toEqual({ enabled: false });
  });
});
