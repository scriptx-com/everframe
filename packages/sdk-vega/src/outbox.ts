// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Reports wait here until the server accepts them. Every capture is written
// before it is sent, because a fatal on Vega aborts the JavaScript thread a
// few milliseconds after the default handler runs; the next launch sends
// whatever is left. One storage key holds the whole (small, capped) list so a
// write is one setItem, and writes run one at a time behind the initial load,
// so a capture during startup can never overwrite stored reports.
import type { AsyncStorageLike } from './config.js';

export const OUTBOX_KEY = '@everframe/vega/outbox/v1';
export const MAX_ITEMS = 10;
export const MAX_SERIALIZED_CHARS = 512 * 1024;
export const MAX_ATTEMPTS = 8;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface OutboxItem {
  reportId: string;
  /** The envelope exactly as it will be sent. Kept serialized: a resend is byte-identical. */
  body: string;
  enqueuedAt: number;
  attempts: number;
  fatal: boolean;
}

export interface Outbox {
  /** Settles once stored reports are loaded (or loading failed). */
  readonly ready: Promise<void>;
  add(item: OutboxItem): Promise<void>;
  remove(reportId: string): Promise<void>;
  recordAttempt(reportId: string): Promise<void>;
  /** Items to send now, oldest first. Expired items are removed on the way. */
  due(): Promise<OutboxItem[]>;
  size(): number;
}

export interface OutboxDeps {
  storage: AsyncStorageLike | undefined;
  now: () => number;
  warn: (message: string) => void;
}

function isItem(value: unknown): value is OutboxItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.reportId === 'string' &&
    typeof item.body === 'string' &&
    typeof item.enqueuedAt === 'number' &&
    typeof item.attempts === 'number' &&
    typeof item.fatal === 'boolean'
  );
}

function expired(item: OutboxItem, now: number): boolean {
  return item.attempts >= MAX_ATTEMPTS || now - item.enqueuedAt > MAX_AGE_MS || item.enqueuedAt > now + MAX_AGE_MS;
}

/** Oldest non-fatal reports go first, then the oldest of the rest. */
export function fit(items: OutboxItem[]): OutboxItem[] {
  const kept = items.slice();
  const size = () => kept.reduce((total, item) => total + item.body.length + 128, 2);
  while (kept.length > MAX_ITEMS || (kept.length > 1 && size() > MAX_SERIALIZED_CHARS)) {
    const nonFatal = kept.findIndex((item) => !item.fatal);
    kept.splice(nonFatal >= 0 ? nonFatal : 0, 1);
  }
  return kept;
}

export function createOutbox(deps: OutboxDeps): Outbox {
  let items: OutboxItem[] = [];
  let warnedWrite = false;

  const load = async (): Promise<void> => {
    if (!deps.storage) return;
    try {
      const raw = await deps.storage.getItem(OUTBOX_KEY);
      if (typeof raw !== 'string' || raw.length === 0) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const seen = new Set<string>();
      items = parsed.filter((item): item is OutboxItem => {
        if (!isItem(item) || seen.has(item.reportId)) return false;
        seen.add(item.reportId);
        return true;
      });
    } catch {
      // Unreadable storage behaves as empty; the next write replaces it.
      items = [];
    }
  };

  const ready = load();
  let queue: Promise<void> = ready;

  const persist = async (): Promise<void> => {
    if (!deps.storage) return;
    try {
      await deps.storage.setItem(OUTBOX_KEY, JSON.stringify(items));
    } catch {
      if (!warnedWrite) {
        warnedWrite = true;
        deps.warn('[everframe] could not write pending reports to storage; they are kept in memory only');
      }
    }
  };

  const mutate = (change: (current: OutboxItem[]) => OutboxItem[]): Promise<void> => {
    const run = queue.then(async () => {
      const next = change(items);
      if (next === items) return;
      items = next;
      await persist();
    });
    // A failed mutation must not wedge every later one.
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    ready,
    add(item) {
      return mutate((current) => fit([...current.filter((existing) => existing.reportId !== item.reportId), item]));
    },
    remove(reportId) {
      return mutate((current) =>
        current.some((item) => item.reportId === reportId)
          ? current.filter((item) => item.reportId !== reportId)
          : current,
      );
    },
    recordAttempt(reportId) {
      return mutate((current) =>
        current.some((item) => item.reportId === reportId)
          ? current.map((item) => (item.reportId === reportId ? { ...item, attempts: item.attempts + 1 } : item))
          : current,
      );
    },
    async due() {
      const now = deps.now();
      await mutate((current) =>
        current.some((item) => expired(item, now)) ? current.filter((item) => !expired(item, now)) : current,
      );
      return items.slice().sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    },
    size() {
      return items.length;
    },
  };
}
