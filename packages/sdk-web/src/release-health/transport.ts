// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { WebHealthDelivery, WebHealthJournal } from './journal.js';
const destination = (endpoint: string, sdkKey: string) => JSON.stringify([endpoint, sdkKey]);
/** Acknowledged delivery; only exit failures may bypass a pending request. */
export function createWebHealthTransport(journal: WebHealthJournal) {
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0,
    rerun = false,
    keepalive = false,
    notBefore = 0;
  const revoked = new Set<string>();
  const active = new Map<string, { key: string; controller: AbortController | null }>();
  const deliver = async (item: WebHealthDelivery, exit: boolean): Promise<void> => {
    const id = item.record.recordId,
      key = destination(item.endpoint, item.sdkKey);
    if (active.has(id)) return;
    if (revoked.has(key)) {
      journal.remove(id);
      return;
    }
    const controller = typeof AbortController === 'undefined' ? null : new AbortController();
    active.set(id, { key, controller });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: { Authorization: `Bearer ${item.sdkKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(item.record),
        signal: controller?.signal ?? null,
      };
      if (exit && typeof Request !== 'undefined' && 'keepalive' in Request.prototype)
        init.keepalive = true;
      let request: Promise<Response>;
      try {
        request = fetch(item.endpoint.replace(/\/$/, '') + '/api/ingest/release-health', init);
      } catch {
        delete init.keepalive;
        request = fetch(item.endpoint.replace(/\/$/, '') + '/api/ingest/release-health', init);
      }
      const response = await Promise.race([
        request,
        new Promise<never>((_r, reject) => {
          timeout = setTimeout(() => {
            controller?.abort();
            reject(Error('health delivery timeout'));
          }, 10000);
        }),
      ]);
      if (
        response.ok ||
        (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status))
      )
        journal.remove(id);
      if (response.status === 429) {
        const value = response.headers.get('Retry-After') ?? '';
        const delay = /^\d+$/.test(value)
          ? Number(value) * 1000
          : Math.max(0, Date.parse(value) - Date.now()) || 0;
        notBefore = Math.max(notBefore, Date.now() + delay);
      }
    } catch {
      /* keep immutable records for retry; never reject into the host */
    } finally {
      if (timeout) clearTimeout(timeout);
      active.delete(id);
    }
  };
  const flush = (options: { keepalive?: boolean; urgent?: boolean } = {}): Promise<void> => {
    keepalive ||= options.keepalive === true;
    if (Date.now() < notBefore) {
      // A concurrent urgent response can extend the deadline after the drain
      // scheduled its retry. An early timer must re-arm, not strand the queue.
      if (!timer)
        timer = setTimeout(
          () => {
            timer = undefined;
            void flush();
          },
          Math.min(notBefore - Date.now(), 2147483647),
        );
      return running ?? Promise.resolve();
    }
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (running) {
      rerun = true;
      // A departing document cannot wait for a completion's response before
      // starting its failure request. Track both so consent withdrawal aborts both.
      if (options.urgent && options.keepalive) {
        return Promise.all(
          journal
            .list(new Date())
            .filter((item) => item.record.phase === 'failure')
            .map((item) => deliver(item, true)),
        ).then(() => undefined);
      }
      return running;
    }
    running = (async () => {
      do {
        rerun = false;
        for (const item of journal.list(new Date())) {
          // A callback/tab may supersede a record while an earlier fetch awaits.
          if (
            !journal
              .list(new Date())
              .some((pending) => pending.record.recordId === item.record.recordId)
          )
            continue;
          if (Date.now() < notBefore) break;
          await deliver(item, keepalive);
        }
      } while (rerun && Date.now() >= notBefore);
      keepalive = false;
      if (journal.list(new Date()).length) {
        const delay = Math.max(
          notBefore - Date.now(),
          [1000, 5000, 30000, 300000][Math.min(attempt++, 3)]!,
        );
        timer = setTimeout(
          () => {
            timer = undefined;
            void flush();
          },
          Math.min(delay, 2147483647),
        );
      } else attempt = 0;
    })().finally(() => {
      running = null;
    });
    return running;
  };
  return {
    flush,
    revoke(endpoint: string, sdkKey: string) {
      const key = destination(endpoint, sdkKey);
      revoked.add(key);
      for (const request of active.values()) if (request.key === key) request.controller?.abort();
      journal.revoke(endpoint, sdkKey);
      if (timer && !journal.list(new Date()).length) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
