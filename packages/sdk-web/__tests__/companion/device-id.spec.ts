// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Stable companion device id (naming spec 2026-08-24 §1). The chain:
// explicit → Tizen DUID → webOS LGUDID → localStorage UUID. Hardware ids
// are hashed before use — asserting the OUTPUT differs from the INPUT and
// is deterministic is the privacy property under test.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveCompanionDeviceId,
  __resetDeviceIdForTests,
  UUID_RE as STORED_UUID_RE,
} from '../../src/companion/device-id.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  __resetDeviceIdForTests();
  delete (window as { webapis?: unknown }).webapis;
  delete (window as { webOS?: unknown }).webOS;
  localStorage.clear();
});

describe('resolveCompanionDeviceId', () => {
  it('explicit config wins, is hashed, lowercase-UUID-shaped, deterministic', async () => {
    const a = await resolveCompanionDeviceId({ explicit: 'MDM-SERIAL-001' });
    __resetDeviceIdForTests();
    const b = await resolveCompanionDeviceId({ explicit: 'MDM-SERIAL-001' });
    expect(a).toMatch(UUID_RE);
    expect(a).toBe(b);                        // stable across resolutions
    expect(a).not.toContain('MDM');           // raw value never leaks through
    __resetDeviceIdForTests();
    const c = await resolveCompanionDeviceId({ explicit: 'MDM-SERIAL-002' });
    expect(c).not.toBe(a);
  });

  // Locks the exact algorithm (not just its shape/determinism, which the
  // first test above already covers) to the SAME literal computed
  // out-of-band as the two native suites: SHA-256("everframe-test-vector"),
  // first 16 bytes, byte 6 -> (b & 0x0f) | 0x40, byte 8 -> (b & 0x3f) | 0x80,
  // hex-formatted 8-4-4-4-12. Same pinned vector as
  // `CompanionDeviceTests.swift.hashToUuid_knownVector` (iOS) and
  // `CompanionDeviceTest.kt.hashToUuid_knownVector` (Android) — those two
  // files' own comments already claimed this file pinned it too; this test
  // is what makes that claim true.
  it('pins the SAME cross-platform known vector as the iOS/Android suites', async () => {
    const id = await resolveCompanionDeviceId({ explicit: 'everframe-test-vector' });
    expect(id).toBe('abb64861-9a56-4d83-9384-9c6559a5599e');
  });

  it('explicit accepts an async provider', async () => {
    const id = await resolveCompanionDeviceId({
      explicit: async () => 'from-provider',
    });
    expect(id).toMatch(UUID_RE);
  });

  it('uses the Tizen DUID when webapis is present', async () => {
    (window as { webapis?: unknown }).webapis = {
      productinfo: { getDuid: () => 'DUID-ABC-123' },
    };
    const id = await resolveCompanionDeviceId();
    expect(id).toMatch(UUID_RE);
    // Same DUID → same id; the TV survives app reinstalls.
    __resetDeviceIdForTests();
    const again = await resolveCompanionDeviceId();
    expect(again).toBe(id);
    // And it beat the localStorage path: nothing was persisted.
    expect(localStorage.getItem('everframe.companionDeviceId')).toBeNull();
  });

  it('uses the webOS LGUDID via the Luna bridge', async () => {
    (window as { webOS?: unknown }).webOS = {
      service: {
        request: (
          uri: string,
          params: {
            method: string;
            parameters: { idType: string[] };
            onSuccess: (r: { idList: Array<{ idType: string; idValue: string }> }) => void;
            onFailure: (e: unknown) => void;
          },
        ) => {
          expect(uri).toBe('luna://com.webos.service.sm');
          expect(params.method).toBe('deviceid/getIDs');
          params.onSuccess({ idList: [{ idType: 'LGUDID', idValue: 'LG-UDID-XYZ' }] });
        },
      },
    };
    const id = await resolveCompanionDeviceId();
    expect(id).toMatch(UUID_RE);
  });

  it('falls back to a persisted localStorage UUID and reuses it', async () => {
    const first = await resolveCompanionDeviceId();
    expect(first).toMatch(UUID_RE);
    expect(localStorage.getItem('everframe.companionDeviceId')).toBe(first);
    __resetDeviceIdForTests();
    const second = await resolveCompanionDeviceId();
    expect(second).toBe(first);
  });

  it('a throwing platform API falls through to the next source, never throws out', async () => {
    (window as { webapis?: unknown }).webapis = {
      productinfo: { getDuid: () => { throw new Error('denied'); } },
    };
    const id = await resolveCompanionDeviceId();
    expect(id).toMatch(UUID_RE);              // localStorage fallback won
    expect(localStorage.getItem('everframe.companionDeviceId')).toBe(id);
  });

  // Fix round 1, Finding 1: opts are honored only on the call that creates
  // the memo (first-call-wins, matching the singleton's first-start()-wins
  // contract) — a second call's opts must be silently ignored, not merged
  // or preferred.
  it('opts are honored only by the first call per page load (first-call-wins)', async () => {
    const first = await resolveCompanionDeviceId({ explicit: 'FIRST-CALL' });
    const second = await resolveCompanionDeviceId({ explicit: 'SECOND-CALL' }); // no reset between calls
    expect(second).toBe(first);
  });

  // Fix round 1, Finding 2: a Luna bridge that hangs (never invokes
  // onSuccess/onFailure) must still resolve, via the 2s internal timeout,
  // falling through to the localStorage UUID. Round 2 W1: shortened from 3s
  // to 2s so ws-client's outer DEVICE_PREFLIGHT_TIMEOUT_MS (4s) can always
  // outlast this, the slowest inner adapter — see ws-client.ts's invariant
  // comment on that constant.
  it('a Luna bridge that never calls back falls through to localStorage after the timeout', async () => {
    vi.useFakeTimers();
    try {
      (window as { webOS?: unknown }).webOS = {
        service: {
          request: () => {
            // Deliberately never invoke onSuccess or onFailure.
          },
        },
      };
      const pending = resolveCompanionDeviceId();
      await vi.advanceTimersByTimeAsync(2_000);
      const id = await pending;
      expect(id).toMatch(UUID_RE);
      expect(localStorage.getItem('everframe.companionDeviceId')).toBe(id);
    } finally {
      vi.useRealTimers();
    }
  });

  // Fix round 1, Finding 2: the Luna onFailure path must also fall through
  // to the next source rather than throwing or hanging.
  it('a Luna onFailure callback falls through to localStorage, never throws', async () => {
    (window as { webOS?: unknown }).webOS = {
      service: {
        request: (
          _uri: string,
          params: { onFailure: (e: unknown) => void },
        ) => {
          params.onFailure(new Error('LGUDID denied'));
        },
      },
    };
    const id = await resolveCompanionDeviceId();
    expect(id).toMatch(UUID_RE);
    expect(localStorage.getItem('everframe.companionDeviceId')).toBe(id);
  });

  // Fix round 1, Finding 3: with no crypto AND no usable storage, every
  // source is exhausted — the module must resolve null, never throw.
  it('resolves null when no source is usable (no crypto, no storage)', async () => {
    vi.stubGlobal('crypto', undefined);
    const getItemSpy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => { throw new Error('opaque origin'); });
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => { throw new Error('opaque origin'); });
    try {
      const id = await resolveCompanionDeviceId();
      expect(id).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      getItemSpy.mockRestore();
      setItemSpy.mockRestore();
    }
  });

  // Final-review Item 1: a pre-existing stored value that isn't a UUID
  // (same-origin script, future buggy writer) must never be shipped as-is —
  // the server's z.string().uuid() would 400 the whole announce, silently
  // stranding the SDK on the ticketless path until site data is cleared.
  // This module owns the only legitimate writer, so regenerating is safe.
  it('regenerates a malformed stored device id rather than returning it as-is', async () => {
    localStorage.setItem('everframe.companionDeviceId', 'not-a-uuid');
    const id = await resolveCompanionDeviceId();
    expect(id).toMatch(STORED_UUID_RE);
    expect(id).not.toBe('not-a-uuid');
    expect(localStorage.getItem('everframe.companionDeviceId')).toBe(id);
    expect(localStorage.getItem('everframe.companionDeviceId')).not.toBe('not-a-uuid');
  });

  // Scoped re-review: the original UUID_RE's third group was `{3,4}`,
  // admitting a 35-char near-UUID (short third group) that isn't RFC 4122 —
  // zod's server-side uuid() would still reject it, partially reopening
  // Item 1. UUID_RE is now strict 8-4-4-4-12.
  it('regenerates a near-UUID with a short third group (not RFC 4122)', async () => {
    const seed = '12345678-1234-123-1234-123456789012';
    localStorage.setItem('everframe.companionDeviceId', seed);
    const id = await resolveCompanionDeviceId();
    expect(id).toMatch(STORED_UUID_RE);
    expect(id).not.toBe(seed);
    expect(localStorage.getItem('everframe.companionDeviceId')).toBe(id);
  });

  // External review W4: correct 8-4-4-4-12 shape but the wrong version/
  // variant nibbles (this module and the server both only ever write v4 /
  // RFC-variant) — zod's server-side uuid() rejects it too, so a stored
  // value like this must be regenerated rather than shipped as-is.
  it('regenerates a valid-shape stored id with the wrong version/variant nibble', async () => {
    const seed = '12345678-1234-9234-c234-123456789012';
    localStorage.setItem('everframe.companionDeviceId', seed);
    const id = await resolveCompanionDeviceId();
    expect(id).toMatch(STORED_UUID_RE);
    expect(id).not.toBe(seed);
    expect(localStorage.getItem('everframe.companionDeviceId')).toBe(id);
  });

  // External review W1(c): a malformed Luna onSuccess payload (e.g. the
  // bridge invokes onSuccess with no argument at all) must not throw inside
  // the callback and leave the returned promise hanging / an unhandled
  // rejection — the 3s timer already backstops a silent hang; a throwing
  // callback needs its own catch.
  it('a malformed Luna onSuccess payload falls through to localStorage without an unhandled rejection', async () => {
    (window as { webOS?: unknown }).webOS = {
      service: {
        request: (
          _uri: string,
          params: { onSuccess: (r: unknown) => void },
        ) => {
          // Malformed: no idList at all — reading `.idList.find` (or similar)
          // inside onSuccess would throw if not defensively guarded.
          params.onSuccess(undefined);
        },
      },
    };
    const id = await resolveCompanionDeviceId();
    expect(id).toMatch(UUID_RE);
    expect(localStorage.getItem('everframe.companionDeviceId')).toBe(id);
  });

  // External review W5: older TV WebViews ship `crypto.getRandomValues`
  // without `crypto.randomUUID` — the localStorage fallback must not
  // silently disable device naming there.
  it('generates a valid v4 UUID via getRandomValues when randomUUID is absent', async () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', {
      subtle: realCrypto.subtle,
      getRandomValues: (arr: Uint8Array) => realCrypto.getRandomValues(arr),
      // randomUUID intentionally omitted.
    });
    try {
      const id = await resolveCompanionDeviceId();
      expect(id).toMatch(UUID_RE);
      expect(localStorage.getItem('everframe.companionDeviceId')).toBe(id);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
