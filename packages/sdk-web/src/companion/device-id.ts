// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Stable companion device identity (naming spec 2026-08-24 §1).
//
// Resolution chain, most-stable-first for each platform:
//   1. Explicit host config (MDM id, provisioning serial) — the host knows best.
//   2. Samsung Tizen DUID — TV-scoped, survives app reinstall.
//   3. LG webOS LGUDID via Luna — likewise TV-scoped.
//   4. localStorage UUID — browsers have no uninstall; TV WEB APPS DO, and
//      uninstalling wipes origin storage, which is exactly why 2 and 3 exist.
//
// PRIVACY: sources 1–3 are hashed (SHA-256 → UUID shape) before leaving this
// module — the raw hardware identifier never reaches the wire. Source 4 is
// already an opaque random UUID, stored as-is.
//
// NEVER throws; resolves null when no source is usable (no storage AND no
// crypto — e.g. an opaque-origin iframe), and the announce simply omits the
// device block, degrading to legacy behavior. Memoized per page load.

/** Single unscoped key: two Everframe apps on one origin are the same physical
 *  device, so sharing the id is correct (rows are per-project server-side).
 *  Key style follows credential-store.ts's `everframe.` prefix. */
const STORAGE_KEY = 'everframe.companionDeviceId';

/** Lowercase-canonical UUID shape, RESTRICTED to v4 + RFC-4122 variant — the
 *  only shape this module's two writers (`hashToUuid`'s SHA-256 nibble-stamp
 *  and `randomUUID`/`bytesToUuid`) ever produce. A valid-8-4-4-4-12-but-wrong-
 *  version-or-variant stored value (e.g. version 9, variant 'c') would still
 *  fail the server's `z.string().uuid()`, 400ing every announce and silently
 *  stranding the SDK on the ticketless path until site data is cleared — so
 *  it must be rejected here too, not just malformed shapes. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** `explicit` is honored only by the first `resolveCompanionDeviceId()` call
 *  per page load — first-call-wins, mirroring the companion singleton's
 *  first-`start()`-wins contract (state.ts). Once the result is memoized,
 *  later calls (with or without `opts`) just return the memoized promise;
 *  their `opts` is never consulted. Call `__resetDeviceIdForTests()` (tests)
 *  or reload the page (real hosts) to change which source wins. */
export interface DeviceIdOptions {
  explicit?: string | (() => string | Promise<string>);
}

let memo: Promise<string | null> | null = null;

export function __resetDeviceIdForTests(): void {
  memo = null;
}

/** Stamp v4/variant nibbles onto 16 raw bytes and format 8-4-4-4-12.
 *  Nibble stamping mirrors draft-to-envelope.ts's generateReportId. Shared by
 *  `hashToUuid` (hashed hardware ids) and `storedUuid`'s `getRandomValues`
 *  fallback (naming spec 2026-08-24, external review W5) — same shape, two
 *  different byte sources. */
function bytesToUuid(bytes: Uint8Array): string {
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** SHA-256 the source, take 16 bytes, hand off to `bytesToUuid`. */
async function hashToUuid(source: string): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) return null;
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(source));
    return bytesToUuid(new Uint8Array(digest).slice(0, 16));
  } catch {
    return null;
  }
}

function tizenDuid(): string | null {
  try {
    const w = window as unknown as {
      webapis?: { productinfo?: { getDuid?: () => string } };
    };
    const duid = w.webapis?.productinfo?.getDuid?.();
    return typeof duid === 'string' && duid.length > 0 ? duid : null;
  } catch {
    return null;
  }
}

function webosLgudid(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const w = window as unknown as {
        webOS?: {
          service?: {
            request?: (uri: string, params: {
              method: string;
              parameters: { idType: string[] };
              onSuccess: (r: { idList?: Array<{ idType: string; idValue: string }> }) => void;
              onFailure: (e: unknown) => void;
            }) => void;
          };
        };
      };
      const request = w.webOS?.service?.request;
      if (typeof request !== 'function') { resolve(null); return; }
      // Luna callbacks can simply never fire on a broken bridge — bound it.
      // Round 2 W1: kept below ws-client's outer DEVICE_PREFLIGHT_TIMEOUT_MS
      // (4s) so a hung Luna bridge degrades to the NEXT source in the chain
      // (localStorage UUID) within that outer bound, rather than the outer
      // race winning first and the announce omitting the device block
      // entirely. See the invariant comment on DEVICE_PREFLIGHT_TIMEOUT_MS.
      const timer = setTimeout(() => resolve(null), 2_000);
      request('luna://com.webos.service.sm', {
        method: 'deviceid/getIDs',
        parameters: { idType: ['LGUDID'] },
        onSuccess: (r) => {
          // A malformed Luna payload (bad bridge implementation, unexpected
          // shape) must still resolve rather than throw out of this
          // callback — the 3s timer above only backstops a silent hang, not
          // a synchronous throw once onSuccess actually fires.
          try {
            clearTimeout(timer);
            const hit = r.idList?.find((e) => e.idType === 'LGUDID')?.idValue;
            resolve(typeof hit === 'string' && hit.length > 0 ? hit : null);
          } catch {
            clearTimeout(timer);
            resolve(null);
          }
        },
        onFailure: () => { clearTimeout(timer); resolve(null); },
      });
    } catch {
      resolve(null);
    }
  });
}

/** localStorage, with credential-store.ts's opaque-origin discipline: the
 *  window.localStorage GETTER itself can throw, so everything sits in try. */
function storedUuid(): string | null {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    // A malformed stored value (same-origin script, future buggy writer)
    // must NOT be returned as-is: the server's z.string().uuid() rejects
    // it, 400ing every announce and silently stranding the SDK on the
    // ticketless path until site data is cleared. This module owns the
    // only legitimate writer, so regenerating over it is safe.
    if (existing !== null && existing.length > 0 && UUID_RE.test(existing)) {
      return existing.toLowerCase();
    }
    // Older TV WebViews (the actual target hardware for this module) ship
    // `crypto.getRandomValues` without `crypto.randomUUID` — naming must not
    // silently disable there (external review W5). Fall back to building a
    // v4 UUID from 16 random bytes via the same nibble-stamp `hashToUuid`
    // uses.
    const fresh =
      globalThis.crypto?.randomUUID?.() ??
      (globalThis.crypto?.getRandomValues
        ? bytesToUuid(globalThis.crypto.getRandomValues(new Uint8Array(16)))
        : undefined);
    if (fresh === undefined) return null;
    // Memory-first is unnecessary here (the caller memoizes); a failed
    // setItem just means a fresh id next page load — still functional.
    try { localStorage.setItem(STORAGE_KEY, fresh); } catch { /* quota/private mode */ }
    return fresh;
  } catch {
    return null;
  }
}

async function resolveOnce(opts: DeviceIdOptions): Promise<string | null> {
  if (opts.explicit !== undefined) {
    try {
      const raw = typeof opts.explicit === 'function' ? await opts.explicit() : opts.explicit;
      if (typeof raw === 'string' && raw.length > 0) {
        const hashed = await hashToUuid(raw);
        if (hashed !== null) return hashed;
      }
    } catch { /* fall through */ }
  }
  const duid = tizenDuid();
  if (duid !== null) {
    const hashed = await hashToUuid(duid);
    if (hashed !== null) return hashed;
  }
  const lgudid = await webosLgudid();
  if (lgudid !== null) {
    const hashed = await hashToUuid(lgudid);
    if (hashed !== null) return hashed;
  }
  return storedUuid();
}

/** Resolves the stable hashed device id. See `DeviceIdOptions` — `opts` is
 *  only honored on the call that creates the memo (first-call-wins). */
export function resolveCompanionDeviceId(opts: DeviceIdOptions = {}): Promise<string | null> {
  if (memo === null) memo = resolveOnce(opts);
  return memo;
}
