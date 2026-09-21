// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import {
  ReplayConfigResponse,
  REPLAY_CONFIG_OFF,
  getNetworkBodiesConfig,
  NETWORK_BODIES_CONFIG_DEFAULT,
  NetworkBodiesServerConfig,
} from '../src/types/replay/config-provider.js';

describe('network bodies config', () => {
  it('defaults to OFF with SDK defaults when the server omits the block', () => {
    const eff = getNetworkBodiesConfig(REPLAY_CONFIG_OFF);
    expect(eff).toEqual(NETWORK_BODIES_CONFIG_DEFAULT);
    expect(eff.captureBodies).toBe(false);
    expect(eff.bodyByteCap).toBe(8192);
    expect(eff.bodyContentTypes).toEqual(['application/json', 'text/*']);
    expect(eff.bodyTotalBudget).toBe(262144);
  });

  it('applies server overrides field-by-field, falling back per missing field', () => {
    const parsed = ReplayConfigResponse.parse({
      replayEnabled: false,
      replayDurationSec: 30,
      samplingRate: 1,
      networkBodies: { captureBodies: true, bodyByteCap: 4096 },
    });
    const eff = getNetworkBodiesConfig(parsed);
    expect(eff.captureBodies).toBe(true);
    expect(eff.bodyByteCap).toBe(4096);
    expect(eff.bodyContentTypes).toEqual(['application/json', 'text/*']); // fallback
    expect(eff.bodyTotalBudget).toBe(262144); // fallback
  });

  // F21 (round-2 review): an out-of-ceiling networkBodies block must degrade
  // to absent (fail-closed: capture off, SDK defaults) WITHOUT taking down
  // the whole config parse — replay/breadcrumbs are unrelated blocks and
  // must keep resolving. Mirrors iOS's `NetworkBodiesConfigWire` decode
  // degrading the whole block to `nil` (826e5f76 F10) rather than the
  // pre-fix behavior of fail-closing the entire response.
  it('an out-of-range byte cap degrades the networkBodies block to absent, not the whole parse', () => {
    const r = ReplayConfigResponse.safeParse({
      replayEnabled: true,
      replayDurationSec: 30,
      samplingRate: 1,
      networkBodies: { captureBodies: true, bodyByteCap: -1 },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.networkBodies).toBeUndefined();
      // The rest of the response — unrelated to networkBodies — survives.
      expect(r.data.replayEnabled).toBe(true);
      expect(r.data.replayDurationSec).toBe(30);
      // Degraded block ⇒ SDK defaults ⇒ capture stays OFF (fail-closed).
      expect(getNetworkBodiesConfig(r.data).captureBodies).toBe(false);
    }
  });

  // Final-review Finding 2 (2026-08-01-network-body-capture-native): a future
  // server-added field INSIDE the networkBodies block must not fail-close the
  // WHOLE config parse (which would also take down replay + breadcrumbs
  // config) — the same nested-leniency hazard the native SDKs already guard
  // against for their own nested blocks.
  it('tolerates an unknown field INSIDE the networkBodies block (nested leniency)', () => {
    const r = ReplayConfigResponse.safeParse({
      replayEnabled: false,
      replayDurationSec: 30,
      samplingRate: 1,
      networkBodies: {
        captureBodies: true,
        bodyByteCap: 4096,
        futureField: 'ignored',
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.networkBodies).toEqual({ captureBodies: true, bodyByteCap: 4096 });
      // The rest of the response — unrelated to networkBodies — survives too.
      expect(r.data.replayEnabled).toBe(false);
      expect(r.data.replayDurationSec).toBe(30);
    }
  });

  it('still rejects an unrelated unknown TOP-LEVEL key (outer schema stays strict)', () => {
    const r = ReplayConfigResponse.safeParse({
      replayEnabled: false,
      replayDurationSec: 30,
      samplingRate: 1,
      networkBodies: { captureBodies: true },
      somethingUnexpected: true,
    });
    expect(r.success).toBe(false);
  });
});

// F21 (round-2 review): the server enforces hard ceilings on the known
// networkBodies fields (NetworkBodiesBlockSchema, the ingest service/src/
// ingest/config-route.ts) — bodyByteCap 1...65536, bodyTotalBudget
// 1...1_048_576, bodyContentTypes 1...16 entries of 1...64 chars — and the
// native SDKs enforce the identical ceilings at decode time (826e5f76 F10).
// Reviewer verified a block with both budgets at 999999999 and 10,000
// content types previously parsed clean and reached the live web buffer.
describe('F21: NetworkBodiesServerConfig wire ceilings (mirrors server + native)', () => {
  function withByteCap(bodyByteCap: number) {
    return NetworkBodiesServerConfig.safeParse({ captureBodies: true, bodyByteCap });
  }
  function withTotalBudget(bodyTotalBudget: number) {
    return NetworkBodiesServerConfig.safeParse({ captureBodies: true, bodyTotalBudget });
  }
  function withContentTypes(bodyContentTypes: string[]) {
    return NetworkBodiesServerConfig.safeParse({ captureBodies: true, bodyContentTypes });
  }

  it('bodyByteCap: 65536 is accepted (upper bound, inclusive)', () => {
    expect(withByteCap(65_536).success).toBe(true);
  });
  it('bodyByteCap: 65537 is rejected (one past the upper bound)', () => {
    expect(withByteCap(65_537).success).toBe(false);
  });
  it('bodyByteCap: 0 is rejected', () => {
    expect(withByteCap(0).success).toBe(false);
  });
  it('bodyByteCap: negative is rejected', () => {
    expect(withByteCap(-1).success).toBe(false);
  });
  it('bodyByteCap: 999999999 (reviewer repro) is rejected', () => {
    expect(withByteCap(999_999_999).success).toBe(false);
  });

  it('bodyTotalBudget: 1048576 (1 MiB) is accepted (upper bound, inclusive)', () => {
    expect(withTotalBudget(1_048_576).success).toBe(true);
  });
  it('bodyTotalBudget: 1048577 is rejected (one past the upper bound)', () => {
    expect(withTotalBudget(1_048_577).success).toBe(false);
  });
  it('bodyTotalBudget: 0 is rejected', () => {
    expect(withTotalBudget(0).success).toBe(false);
  });
  it('bodyTotalBudget: negative is rejected', () => {
    expect(withTotalBudget(-1).success).toBe(false);
  });
  it('bodyTotalBudget: 999999999 (reviewer repro) is rejected', () => {
    expect(withTotalBudget(999_999_999).success).toBe(false);
  });

  it('bodyContentTypes: 16 entries is accepted (upper bound, inclusive)', () => {
    expect(withContentTypes(Array.from({ length: 16 }, (_, i) => `type/${i}`)).success).toBe(true);
  });
  it('bodyContentTypes: 17 entries is rejected (one past the upper bound)', () => {
    expect(withContentTypes(Array.from({ length: 17 }, (_, i) => `type/${i}`)).success).toBe(false);
  });
  it('bodyContentTypes: empty array is rejected (min 1 entry)', () => {
    expect(withContentTypes([]).success).toBe(false);
  });
  it('bodyContentTypes: 10,000 entries (reviewer repro) is rejected', () => {
    expect(withContentTypes(Array.from({ length: 10_000 }, (_, i) => `type/${i}`)).success).toBe(false);
  });
  it('bodyContentTypes: a 64-char entry is accepted (upper bound, inclusive)', () => {
    expect(withContentTypes(['a'.repeat(64)]).success).toBe(true);
  });
  it('bodyContentTypes: a 65-char entry is rejected (one past the upper bound)', () => {
    expect(withContentTypes(['a'.repeat(65)]).success).toBe(false);
  });
  it('bodyContentTypes: an empty-string entry is rejected (min 1 char)', () => {
    expect(withContentTypes(['']).success).toBe(false);
  });

  it('reviewer repro: a block with both budgets at 999999999 and 10,000 content types is rejected at the schema level and degrades to absent in the full response (never reaches the live buffer)', () => {
    const hostileBlock = {
      captureBodies: true,
      bodyByteCap: 999_999_999,
      bodyTotalBudget: 999_999_999,
      bodyContentTypes: Array.from({ length: 10_000 }, (_, i) => `type/${i}`),
    };
    expect(NetworkBodiesServerConfig.safeParse(hostileBlock).success).toBe(false);

    const r = ReplayConfigResponse.safeParse({
      replayEnabled: true,
      replayDurationSec: 30,
      samplingRate: 1,
      networkBodies: hostileBlock,
    });
    expect(r.success).toBe(true); // whole config parse survives (F21 failure posture)
    if (r.success) {
      expect(r.data.networkBodies).toBeUndefined();
      const eff = getNetworkBodiesConfig(r.data);
      expect(eff.captureBodies).toBe(false); // never enables capture
      expect(eff.bodyByteCap).toBe(NETWORK_BODIES_CONFIG_DEFAULT.bodyByteCap);
      expect(eff.bodyTotalBudget).toBe(NETWORK_BODIES_CONFIG_DEFAULT.bodyTotalBudget);
    }
  });
});
