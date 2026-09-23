// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { OutboxAdapter, OutboxItem } from '@everframe/sdk-core';

/**
 * localStorage-backed OutboxAdapter (PIPE-02 reload-survival primary).
 *
 * Storage key shape: `everframe:outbox:<reportId>` (namespaced + iterable).
 * Aggregate cap: 5 MB (CONTEXT lock); enforced via oldest-first eviction.
 * Uint8Array <-> base64 round-trip uses chunked btoa to avoid call-stack overflow
 * for ~MB-scale payloads (CHUNK = 0x8000 string-fromCharCode batches).
 *
 * Returns null when localStorage is unavailable (private mode, quota=0, SSR) — caller
 * (createOutbox factory in ./index.ts) falls back to in-memory and warns once.
 */
export const KEY_PREFIX = 'everframe:outbox:';
export const QUOTA_BYTES = 5 * 1024 * 1024; // CONTEXT lock: 5 MB aggregate cap
const PROBE_KEY = '__everframe_probe__';

interface SerializedItem {
  reportId: string;
  enqueuedAt: number;
  attempts: number;
  payloadB64: string;
  metadata: Record<string, string>;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked btoa to avoid call-stack overflow on ~MB-scale payloads.
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function tryStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    localStorage.setItem(PROBE_KEY, '1');
    localStorage.removeItem(PROBE_KEY);
    return localStorage;
  } catch {
    return null;
  }
}

interface ListedRow {
  key: string;
  value: string;
  item: SerializedItem;
  bytes: number;
}

function listSerialized(store: Storage): ListedRow[] {
  const out: ListedRow[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key || !key.startsWith(KEY_PREFIX)) continue;
    const value = store.getItem(key);
    if (!value) continue;
    try {
      const item = JSON.parse(value) as SerializedItem;
      out.push({ key, value, item, bytes: value.length });
    } catch {
      // corrupt entry — skip (left in place for diagnosability)
    }
  }
  return out;
}

function totalBytes(store: Storage): number {
  return listSerialized(store).reduce((acc, r) => acc + r.bytes, 0);
}

export function createLocalStorageOutbox(): OutboxAdapter | null {
  const store = tryStorage();
  if (!store) return null;
  return {
    async enqueue(item: OutboxItem): Promise<void> {
      const serialized: SerializedItem = {
        reportId: item.reportId,
        enqueuedAt: item.enqueuedAt,
        attempts: item.attempts,
        payloadB64: bytesToBase64(item.payload),
        metadata: item.metadata,
      };
      const value = JSON.stringify(serialized);
      const key = KEY_PREFIX + item.reportId;
      const incomingBytes = value.length;

      // Evict oldest until the incoming entry fits within QUOTA.
      while (totalBytes(store) + incomingBytes > QUOTA_BYTES) {
        const all = listSerialized(store).sort((a, b) => a.item.enqueuedAt - b.item.enqueuedAt);
        const oldest = all[0];
        if (!oldest) break;
        store.removeItem(oldest.key);
      }

      try {
        store.setItem(key, value);
      } catch {
        // Quota still exceeded despite eviction (browser-imposed per-origin cap below 5 MB).
        // DEFE-02: never throw out to the caller; drop silently.
      }
    },
    async list(): Promise<OutboxItem[]> {
      return listSerialized(store)
        .map(({ item }) => ({
          reportId: item.reportId,
          enqueuedAt: item.enqueuedAt,
          attempts: item.attempts,
          payload: base64ToBytes(item.payloadB64),
          metadata: item.metadata,
        }))
        .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    },
    async delete(reportId: string): Promise<void> {
      store.removeItem(KEY_PREFIX + reportId);
    },
  };
}
