// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { WebReleaseHealthRecordSchema, RELEASE_HEALTH_MAX_AGE_MS, type WebReleaseHealthRecord } from '@everframe/protocol';
export interface WebHealthDelivery { endpoint: string; sdkKey: string; record: WebReleaseHealthRecord }
export interface WebHealthJournal {
  put(delivery: WebHealthDelivery): void;
  list(now: Date): WebHealthDelivery[];
  remove(recordId: string): void;
  revoke(endpoint: string, sdkKey: string): void;
}
const PREFIX = 'everframe:release-health:';
/** Individual keys avoid the cross-tab lost-update problem of a whole-queue JSON blob. */
export function createWebHealthJournal(storage: Storage | null): WebHealthJournal {
  const memory = new Map<string, WebHealthDelivery>();
  const remove = (id: string) => { memory.delete(id); try { storage?.removeItem(PREFIX + id); } catch { /* restricted storage */ } };
  const list = (now: Date) => {
    const rows = new Map(memory);
    try {
      const keys: string[] = [];
      for (let i=0; i<(storage?.length ?? 0); i++) { const key=storage!.key(i); if(key?.startsWith(PREFIX)) keys.push(key); }
      for (const key of keys) {
        try {
          const value: unknown = JSON.parse(storage!.getItem(key) ?? 'null');
          const item = value as WebHealthDelivery;
          const parsed = WebReleaseHealthRecordSchema.safeParse(item?.record);
          if (!parsed.success || typeof item.endpoint !== 'string' || !/^https?:\/\//.test(item.endpoint) || typeof item.sdkKey !== 'string' || !item.sdkKey || key !== PREFIX + parsed.data.recordId) {
            storage!.removeItem(key); continue;
          }
          rows.set(parsed.data.recordId, { endpoint:item.endpoint, sdkKey:item.sdkKey, record:parsed.data });
        } catch { try { storage!.removeItem(key); } catch { /* restricted storage */ } }
      }
    } catch { /* use the bounded memory fallback */ }
    const sorted = [...rows.values()].sort((a,b)=>a.record.exposure.startedAt.localeCompare(b.record.exposure.startedAt));
    let bytes = sorted.reduce((n,x)=>n+JSON.stringify(x).length*2,0), count=sorted.length;
    return sorted.filter(item => {
      if (Date.parse(item.record.exposure.startedAt)+RELEASE_HEALTH_MAX_AGE_MS <= +now || count>128 || bytes>1024*1024) {
        remove(item.record.recordId);count--;bytes-=JSON.stringify(item).length*2;return false;
      }
      return true;
    });
  };
  return {
    put(item) {
      const frozen = JSON.parse(JSON.stringify(item)) as WebHealthDelivery;
      try { if (!storage) throw Error('memory'); storage.setItem(PREFIX+item.record.recordId,JSON.stringify(frozen)); }
      catch { memory.set(item.record.recordId,frozen); }
      list(new Date());
    },
    list, remove,
    revoke(endpoint,sdkKey) { for(const item of list(new Date())) if(item.endpoint===endpoint && item.sdkKey===sdkKey) remove(item.record.recordId); },
  };
}
