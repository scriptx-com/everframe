// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture (web TVs): the device link in `localStorage`,
// one entry per ingest origin + SDK key (see `deviceLinkScope`). Eager.
//
// A memory mirror is written first, as in `reporter/credential-store.ts`, so
// a TV whose storage is blocked or full stays linked for the session. Every
// storage touch is try/caught, including the `localStorage` getter, which
// throws on opaque origins. A link stored under another scope is never
// returned and never deleted.
import { globalScope } from '../internal/global-scope.js';
import { isDeviceToken, parseOwner, type DeviceLinkOwner } from './token.js';

export interface StoredDeviceLink {
  token: string;
  owner: DeviceLinkOwner;
  scope: string;
}

export interface DeviceLinkStore {
  readonly scope: string;
  load(): StoredDeviceLink | null;
  /** False only for an invalid token. */
  save(token: string, owner: DeviceLinkOwner): boolean;
  /** Only if `token` is the stored token. */
  updateOwner(token: string, owner: DeviceLinkOwner): void;
  /**
   * Removes the stored link. With `onlyIfToken`, only when that token is the
   * stored one. True when a link was removed; false when a different token
   * is stored or nothing is.
   */
  clear(onlyIfToken?: string): boolean;
}

export function deviceLinkStorageKey(scope: string): string {
  return `everframe.deviceLink.v1.${scope.slice(0, 32)}`;
}

function defaultStorage(): Storage | null {
  return (globalScope() as { localStorage?: Storage }).localStorage ?? null;
}

export function createDeviceLinkStore(
  scope: string,
  storage: () => Storage | null = defaultStorage,
): DeviceLinkStore {
  const key = deviceLinkStorageKey(scope);
  // Once this session saved or cleared, memory is the truth: a storage write
  // that failed must not resurrect (or hide) a link.
  let memoryOwnsTruth = false;
  let memory: StoredDeviceLink | null = null;

  function storageOrNull(): Storage | null {
    try {
      return storage();
    } catch {
      return null;
    }
  }

  function readStorage(): StoredDeviceLink | null {
    const s = storageOrNull();
    if (!s) return null;
    let raw: string | null;
    try {
      raw = s.getItem(key);
    } catch {
      return null;
    }
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const v = parsed as { v?: unknown; s?: unknown; t?: unknown; o?: unknown } | null | undefined;
    // Another scope's entry under a colliding key: leave it alone.
    if (v && typeof v === 'object' && v.v === 1 && typeof v.s === 'string' && v.s !== scope) {
      return null;
    }
    const owner = v && typeof v === 'object' ? parseOwner(v.o) : null;
    if (
      !v ||
      typeof v !== 'object' ||
      v.v !== 1 ||
      v.s !== scope ||
      !isDeviceToken(v.t) ||
      !owner
    ) {
      try {
        s.removeItem(key);
      } catch {
        /* best effort */
      }
      return null;
    }
    return { token: v.t, owner, scope };
  }

  function write(link: StoredDeviceLink | null): void {
    memoryOwnsTruth = true;
    memory = link;
    const s = storageOrNull();
    if (!s) return;
    try {
      if (link) {
        s.setItem(key, JSON.stringify({ v: 1, s: scope, t: link.token, o: link.owner }));
      } else {
        s.removeItem(key);
      }
    } catch {
      /* the memory mirror keeps this session right */
    }
  }

  function load(): StoredDeviceLink | null {
    try {
      if (memoryOwnsTruth) return memory ? { ...memory } : null;
      return readStorage();
    } catch {
      return null;
    }
  }

  return {
    scope,
    load,
    save(token: string, owner: DeviceLinkOwner): boolean {
      if (!isDeviceToken(token)) return false;
      const clean = parseOwner(owner);
      if (!clean) return false;
      try {
        write({ token, owner: clean, scope });
      } catch {
        /* write() is total; belt and braces for DEFE-02 */
      }
      return true;
    },
    updateOwner(token: string, owner: DeviceLinkOwner): void {
      try {
        const cur = load();
        const clean = parseOwner(owner);
        if (!cur || cur.token !== token || !clean) return;
        write({ token, owner: clean, scope });
      } catch {
        /* never throws into the host */
      }
    },
    clear(onlyIfToken?: string): boolean {
      try {
        const cur = load();
        if (!cur) return false;
        if (onlyIfToken !== undefined && cur.token !== onlyIfToken) return false;
        write(null);
        return true;
      } catch {
        return false;
      }
    },
  };
}
