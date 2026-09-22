// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// In-memory OutboxAdapter default — Map keyed on reportId. Plan 04 ships this as the
// minimum viable adapter; web (IndexedDB) and RN (AsyncStorage) impls land in their
// respective phases.
import type { OutboxAdapter, OutboxItem } from '../types/platform.js';

export function createInMemoryOutbox(): OutboxAdapter {
  const store = new Map<string, OutboxItem>();
  return {
    async enqueue(item) {
      store.set(item.reportId, item);
    },
    async list() {
      return Array.from(store.values()).sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    },
    async delete(reportId) {
      store.delete(reportId);
    },
  };
}
