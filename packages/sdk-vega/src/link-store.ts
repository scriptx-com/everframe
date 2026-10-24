// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Where a device link lives: one JSON record in the host's AsyncStorage,
// bound to the scope (server origin + SDK key) it was issued for. Every method
// catches everything; a broken storage reads as "not linked".
import type { AsyncStorageLike } from './config.js';
import { isDeviceToken, parseOwner, type LinkOwner } from './link-token.js';

export const LINK_STORAGE_KEY = '@everframe/vega/device-link/v1';

export interface StoredLink {
  token: string;
  owner: LinkOwner;
  scope: string;
}

export interface LinkStore {
  load(scope: string): Promise<StoredLink | null>;
  save(link: StoredLink): Promise<boolean>;
  clear(): Promise<void>;
}

function decode(raw: unknown): StoredLink | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as { v?: unknown; s?: unknown; t?: unknown; o?: unknown };
  if (record.v !== 1 || typeof record.s !== 'string' || record.s.length === 0) return null;
  if (!isDeviceToken(record.t)) return null;
  const owner = parseOwner(record.o);
  if (!owner) return null;
  return { token: record.t, owner, scope: record.s };
}

function valid(link: StoredLink): boolean {
  return (
    !!link &&
    isDeviceToken(link.token) &&
    parseOwner(link.owner) !== null &&
    typeof link.scope === 'string' &&
    link.scope.length > 0
  );
}

export function createLinkStore(storage: AsyncStorageLike | undefined): LinkStore {
  let memory: StoredLink | null = null;

  async function write(value: string): Promise<boolean> {
    if (!storage) return true;
    try {
      await storage.setItem(LINK_STORAGE_KEY, value);
      return true;
    } catch {
      return false;
    }
  }

  return {
    async load(scope) {
      if (!storage) return memory && memory.scope === scope ? { ...memory } : null;
      let raw: string | null | undefined;
      try {
        raw = await storage.getItem(LINK_STORAGE_KEY);
      } catch {
        return null;
      }
      if (typeof raw !== 'string' || raw.length === 0) return null;
      let link: StoredLink | null = null;
      try {
        link = decode(JSON.parse(raw));
      } catch {
        link = null;
      }
      if (!link) {
        // A corrupt record is useless to every scope: drop it.
        await write('');
        return null;
      }
      // Another endpoint's or key's link stays stored for when the app goes
      // back to it, and is never handed out here.
      return link.scope === scope ? link : null;
    },
    async save(link) {
      if (!valid(link)) return false;
      const record = { token: link.token, owner: parseOwner(link.owner)!, scope: link.scope };
      if (!storage) {
        memory = record;
        return true;
      }
      return write(JSON.stringify({ v: 1, s: record.scope, t: record.token, o: record.owner }));
    },
    async clear() {
      memory = null;
      // AsyncStorageLike has no removeItem.
      await write('');
    },
  };
}
