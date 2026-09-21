// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Contract lock: the response production `GET /api/config` actually serves must
// survive the `.strict()` schema. A field the server adds and the schema does
// not know about fails the parse, and every consumer then fail-closes to
// REPLAY_CONFIG_OFF — replay silently never starts, with a clean 200 in the
// network trace. Captured from traceitx.com on 2026-08-27.
import { describe, it, expect } from 'vitest';
import { ReplayConfigResponse } from '../../src/types/replay/config-provider.js';

const LIVE_RESPONSE = {
  replayEnabled: true,
  replayDurationSec: 30,
  samplingRate: 1,
  replies: { enabled: true },
  networkBodies: {
    captureBodies: true,
    bodyByteCap: 16384,
    bodyContentTypes: ['application/json', 'text/*'],
    bodyTotalBudget: 524288,
  },
  identity: { enabled: true },
};

describe('live /api/config response', () => {
  it('parses against the strict schema', () => {
    const result = ReplayConfigResponse.safeParse(LIVE_RESPONSE);
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it('keeps replay enabled through the parse', () => {
    const result = ReplayConfigResponse.safeParse(LIVE_RESPONSE);
    expect(result.success && result.data.replayEnabled).toBe(true);
  });
});
