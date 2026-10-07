// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { ReleaseHealthRecordSchema, RELEASE_HEALTH_BODY_LIMIT, type ReleaseHealthRecord } from '@everframe/protocol';

export const HEALTH_QUEUE_MAX_RECORDS = 256;
export const HEALTH_QUEUE_MAX_BYTES = 1024 * 1024;
export const HEALTH_QUEUE_MAX_AGE_MS = 7 * 86_400_000;
const MAX_ROUTES = 32;
const DB_NAME = 'everframe-release-health-v1';
interface RouteState { route: string; generation: string; revoked: boolean; losses: number; updatedAt: number }
export interface HealthQueueRow { key: string; route: string; generation: string; record: ReleaseHealthRecord; enqueuedAt: number; bytes: number }
export class HealthJournalError extends Error {
  constructor(readonly code: 'capacity' | 'revoked' | 'conflict' | 'corrupt') { super(`Release health journal: ${code}`); }
}
const request = <T>(value: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error);
});
const finished = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Journal transaction aborted'));
  tx.onerror = () => undefined; // abort owns the rejection
});
const increment = (value: number) => Math.min(2_147_483_647, value + 1);

export async function openReleaseHealthJournal() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('records', { keyPath: 'key' });
      open.result.createObjectStore('routes', { keyPath: 'route' });
    };
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('Release health storage upgrade blocked'));
    open.onsuccess = () => resolve(open.result);
  });
  db.onversionchange = () => db.close();

  async function transaction<T>(operation: (records: IDBObjectStore, routes: IDBObjectStore) => Promise<T>): Promise<T> {
    const tx = db.transaction(['records', 'routes'], 'readwrite');
    const completion = finished(tx);
    try {
      const result = await operation(tx.objectStore('records'), tx.objectStore('routes'));
      await completion; return result;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be finished */ }
      await completion.catch(() => undefined); throw error;
    }
  }
  async function inventory(records: IDBObjectStore, routes: IDBObjectStore, now: number) {
    const [rows, states] = await Promise.all([
      request<HealthQueueRow[]>(records.getAll(undefined, HEALTH_QUEUE_MAX_RECORDS + 1)),
      request<RouteState[]>(routes.getAll(undefined, MAX_ROUTES + 1)),
    ]);
    if (rows.length > HEALTH_QUEUE_MAX_RECORDS || states.length > MAX_ROUTES) throw new HealthJournalError('capacity');
    const byRoute = new Map(states.map(state => [state.route, state]));
    const live: HealthQueueRow[] = [];
    for (const row of rows) {
      if (!Number.isFinite(row.enqueuedAt) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 ||
          !ReleaseHealthRecordSchema.safeParse(row.record).success) throw new HealthJournalError('corrupt');
      if (now - row.enqueuedAt > HEALTH_QUEUE_MAX_AGE_MS) {
        const state = byRoute.get(row.route);
        if (!state) throw new HealthJournalError('corrupt');
        state.losses = increment(state.losses); state.updatedAt = now;
        routes.put(state); records.delete(row.key);
      } else live.push(row);
    }
    return { rows: live, states: byRoute };
  }
  async function checked(routes: IDBObjectStore, route: string, generation: string): Promise<RouteState> {
    const state = await request<RouteState | undefined>(routes.get(route));
    if (!state || state.revoked || state.generation !== generation) throw new HealthJournalError('revoked');
    return state;
  }
  return {
    close() { db.close(); },
    async activate(route: string, now = Date.now()) {
      return transaction(async (records, routes) => {
        const inventoryValue = await inventory(records, routes, now);
        let state = inventoryValue.states.get(route);
        if (!state) {
          // Empty old routes can be retired; live queues and recent revocations survive.
          for (const [key, old] of inventoryValue.states) {
            if (now - old.updatedAt > HEALTH_QUEUE_MAX_AGE_MS && !inventoryValue.rows.some(row => row.route === key)) {
              routes.delete(key); inventoryValue.states.delete(key);
            }
          }
          if (inventoryValue.states.size >= MAX_ROUTES) throw new HealthJournalError('capacity');
          state = { route, generation: crypto.randomUUID(), revoked: false, losses: 0, updatedAt: now };
        } else if (state.revoked) { state.generation = crypto.randomUUID(); state.revoked = false; }
        state.updatedAt = now; routes.put(state);
        return { generation: state.generation, losses: state.losses };
      });
    },
    async append(route: string, generation: string, input: ReleaseHealthRecord, now = Date.now()) {
      const record = ReleaseHealthRecordSchema.parse(input);
      const json = JSON.stringify(record); const bytes = new TextEncoder().encode(json).byteLength;
      if (bytes > RELEASE_HEALTH_BODY_LIMIT) throw new HealthJournalError('capacity');
      const result = await transaction(async (records, routes) => {
        const { rows } = await inventory(records, routes, now);
        const state = await checked(routes, route, generation);
        const key = route + ':' + record.recordId;
        const existing = rows.find(row => row.key === key);
        if (existing) {
          if (JSON.stringify(existing.record) !== json) throw new HealthJournalError('conflict');
          return true;
        }
        if (rows.length >= HEALTH_QUEUE_MAX_RECORDS || rows.reduce((sum, row) => sum + row.bytes, 0) + bytes > HEALTH_QUEUE_MAX_BYTES) {
          state.losses = increment(state.losses); state.updatedAt = now; routes.put(state); return false;
        }
        records.add({ key, route, generation, record, enqueuedAt: now, bytes } satisfies HealthQueueRow);
        return true;
      });
      // Commit the loss diagnostic even though the append was refused.
      if (!result) throw new HealthJournalError('capacity');
    },
    async list(route: string, generation: string, now = Date.now()) {
      return transaction(async (records, routes) => {
        const { rows } = await inventory(records, routes, now);
        const state = await checked(routes, route, generation);
        return { rows: rows.filter(row => row.route === route).sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.record.sequence - b.record.sequence), losses: state.losses };
      });
    },
    async acknowledge(route: string, generation: string, key: string, lost: boolean) {
      return transaction(async (records, routes) => {
        const state = await checked(routes, route, generation);
        const row = await request<HealthQueueRow | undefined>(records.get(key));
        if (!row || row.route !== route) return;
        records.delete(key);
        if (lost) { state.losses = increment(state.losses); state.updatedAt = Date.now(); routes.put(state); }
      });
    },
    async revoke(route: string) {
      return transaction(async (records, routes) => {
        const { rows, states } = await inventory(records, routes, Date.now());
        const state = states.get(route);
        // With no state/rows there can be no accepted write from an older generation.
        if (state) routes.put({ ...state, generation: crypto.randomUUID(), revoked: true, updatedAt: Date.now() });
        for (const row of rows) if (row.route === route) records.delete(row.key);
      });
    },
  };
}
export type ReleaseHealthJournal = Awaited<ReturnType<typeof openReleaseHealthJournal>>;
