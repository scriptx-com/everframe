// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Reports wait here until the server accepts them. Every capture is written
// before it is sent, because a fatal on Vega aborts the JavaScript thread a
// few milliseconds after the default handler runs; the next launch sends
// whatever is left. One storage key holds the whole (small, capped) list so a
// write is one setItem, and writes run one at a time behind the initial load,
// so a capture during startup can never overwrite stored reports.
//
// Every report is bound to where it was captured for: the ingest URL and a
// fingerprint of the SDK key. An outbox only ever holds reports for its own
// binding; anything else found in storage (another key, another endpoint, or
// a report from before bindings existed) is dropped, never sent, so one app's
// report can never travel under another app's key.
import type { AsyncStorageLike } from './config.js';

export const OUTBOX_KEY = '@everframe/vega/outbox/v1';
export const MAX_ITEMS = 10;
export const MAX_SERIALIZED_CHARS = 512 * 1024;
export const MAX_ATTEMPTS = 8;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Where a report may be delivered: its capture-time ingest URL and key fingerprint. */
export interface OutboxBinding {
  endpoint: string;
  /** Non-reversible fingerprint of the SDK key (never the key itself). */
  keyHash: string;
}

export interface OutboxItem extends OutboxBinding {
  reportId: string;
  /** The envelope exactly as it will be sent. Kept serialized: a resend is byte-identical. */
  body: string;
  enqueuedAt: number;
  attempts: number;
  fatal: boolean;
  /** A quick capture: sent with the link rules, never with a reply token. */
  quickCapture?: boolean;
  /**
   * A linked quick capture: the first 16 hex chars of SHA-256 of the device
   * token it was captured under. Never the token. It is sent only while the
   * device still holds that token.
   */
  linkFingerprint?: string;
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
  storageKey?: string;
  maxItems?: number;
  now: () => number;
  warn: (message: string) => void;
  /** The running configuration; only reports bound to it are kept. */
  binding: OutboxBinding;
  /** Development-only log for reports dropped because their binding differs. */
  debug: (message: string) => void;
}

export function sameBinding(item: OutboxBinding, binding: OutboxBinding): boolean {
  return item.endpoint === binding.endpoint && item.keyHash === binding.keyHash;
}

function isItem(value: unknown): value is OutboxItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.reportId === 'string' &&
    typeof item.body === 'string' &&
    typeof item.enqueuedAt === 'number' &&
    typeof item.attempts === 'number' &&
    typeof item.fatal === 'boolean' &&
    typeof item.endpoint === 'string' &&
    typeof item.keyHash === 'string' &&
    (item.quickCapture === undefined || typeof item.quickCapture === 'boolean') &&
    (item.linkFingerprint === undefined ||
      (typeof item.linkFingerprint === 'string' && /^[0-9a-f]{16}$/.test(item.linkFingerprint)))
  );
}

function expired(item: OutboxItem, now: number): boolean {
  return (
    item.attempts >= MAX_ATTEMPTS ||
    now - item.enqueuedAt > MAX_AGE_MS ||
    item.enqueuedAt > now + MAX_AGE_MS
  );
}

/** Oldest non-fatal reports go first, then the oldest of the rest. */
export function fit(items: OutboxItem[], maxItems = MAX_ITEMS): OutboxItem[] {
  const kept = items.slice();
  const size = () => kept.reduce((total, item) => total + item.body.length + 128, 2);
  while (kept.length > maxItems || (kept.length > 1 && size() > MAX_SERIALIZED_CHARS)) {
    const nonFatal = kept.findIndex((item) => !item.fatal);
    kept.splice(nonFatal >= 0 ? nonFatal : 0, 1);
  }
  return kept;
}

export function createOutbox(deps: OutboxDeps): Outbox {
  let items: OutboxItem[] = [];
  const storageKey = deps.storageKey ?? OUTBOX_KEY;
  const maxItems = Math.max(1, deps.maxItems ?? MAX_ITEMS);
  let warnedWrite = false;

  let stale = false;
  const load = async (): Promise<void> => {
    if (!deps.storage) return;
    try {
      const raw = await deps.storage.getItem(storageKey);
      if (typeof raw !== 'string' || raw.length === 0) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const seen = new Set<string>();
      let foreign = 0;
      items = parsed.filter((item): item is OutboxItem => {
        if (!isItem(item) || seen.has(item.reportId)) {
          stale = true;
          return false;
        }
        if (!sameBinding(item, deps.binding)) {
          foreign++;
          return false;
        }
        seen.add(item.reportId);
        return true;
      });
      const bounded = fit(
        items.filter((item) => !expired(item, deps.now())),
        maxItems,
      );
      if (bounded.length !== items.length) stale = true;
      items = bounded;
      if (foreign > 0) {
        stale = true;
        deps.debug(
          `[everframe] dropped ${foreign} stored report(s) captured for another SDK key or endpoint; they are not sent`,
        );
      }
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
      await deps.storage.setItem(storageKey, JSON.stringify(items));
    } catch {
      if (!warnedWrite) {
        warnedWrite = true;
        deps.warn(
          '[everframe] could not write pending reports to storage; they are kept in memory only',
        );
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

  // Dropped items must leave storage too, not only memory.
  queue = queue.then(async () => {
    if (stale) await persist();
  });

  return {
    ready,
    add(item) {
      if (!sameBinding(item, deps.binding)) return Promise.resolve();
      return mutate((current) =>
        fit([...current.filter((existing) => existing.reportId !== item.reportId), item], maxItems),
      );
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
          ? current.map((item) =>
              item.reportId === reportId ? { ...item, attempts: item.attempts + 1 } : item,
            )
          : current,
      );
    },
    async due() {
      const now = deps.now();
      await mutate((current) =>
        current.some((item) => expired(item, now))
          ? current.filter((item) => !expired(item, now))
          : current,
      );
      return items.slice().sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    },
    size() {
      return items.length;
    },
  };
}
