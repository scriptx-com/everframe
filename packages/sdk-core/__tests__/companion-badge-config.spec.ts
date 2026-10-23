// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Companion was removed: no SDK reads the `companionBadge` block any more and
// none declares `companionbadge`. An older server, or a stale cached config,
// can still send the block, and the response schema is `.strict()`, so the
// field must stay declared. These are guard tests: they fail if anyone drops
// the field from the schema.
import { describe, expect, it } from 'vitest';
import { ReplayConfigResponse } from '../src/index.js';

const BASE = { replayEnabled: true, replayDurationSec: 30, samplingRate: 1 };

describe('companionBadge server config (deprecated, parsed and unread)', () => {
  it('a config carrying a companionBadge block still parses and its other blocks apply', () => {
    const parsed = ReplayConfigResponse.safeParse({
      ...BASE,
      companionBadge: { enabled: true, position: 'top-left' },
      reportHotkey: { binding: 'Shift+B' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.reportHotkey?.binding).toBe('Shift+B');
    expect(parsed.data?.replayEnabled).toBe(true);
  });

  it('a malformed companionBadge block never fails the whole parse', () => {
    const parsed = ReplayConfigResponse.safeParse({
      ...BASE,
      companionBadge: { enabled: 'yes' },
      reportHotkey: { binding: 'Shift+B' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.reportHotkey?.binding).toBe('Shift+B');
  });
});
