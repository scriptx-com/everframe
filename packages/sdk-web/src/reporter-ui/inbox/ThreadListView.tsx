// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { useEffect, useState, type JSX } from 'react';
import type { EverframeClient } from '@everframe/sdk-core';

export interface ThreadListViewProps {
  threads: EverframeClient['threads'];
  onOpenThread: (threadId: string) => void;
  onNewReport: () => void;
}

/**
 * "Your reports" list — reads live state off the `threads` facade (public
 * `tx.threads.*` surface, spec 2026-07-31). Seeds from `getState()` then
 * subscribes for liveness; unmount unsubscribes. Rows render in the order
 * the facade serves them (newest first) — never re-sorted here.
 */
export function ThreadListView({ threads, onOpenThread, onNewReport }: ThreadListViewProps): JSX.Element {
  const [state, setState] = useState(() => threads.getState());
  useEffect(() => threads.subscribe(setState), [threads]);

  const rows = state.threads;

  if (rows.length === 0) {
    return (
      <div className="everframe-inbox-empty">
        <p>No reports yet.</p>
        <button type="button" className="everframe-btn everframe-btn-primary" onClick={onNewReport}>
          New report
        </button>
      </div>
    );
  }

  return (
    <>
      {state.readOnly ? (
        <div className="everframe-notice everframe-notice-degraded">
          Replies are turned off. Existing conversations are read-only.
        </div>
      ) : null}
      {/* Plain <ul>/<li>/<button> — native list + native button semantics,
       * no ARIA role overrides. A `role="listitem"` on the `<button>` itself
       * (the prior shape here) replaces its implicit button role for AT
       * users, which is why this was restructured. */}
      <ul className="everframe-inbox-list">
        {rows.map((t) => (
          <li key={t.id}>
            <button type="button" className="everframe-inbox-row" onClick={() => onOpenThread(t.id)}>
              <span className="everframe-inbox-row-title">
                {t.reportTitle ?? `Report from ${new Date(t.createdAt).toLocaleDateString()}`}
              </span>
              <span
                className={`everframe-inbox-chip ${t.status === 'open' ? 'everframe-inbox-chip-open' : 'everframe-inbox-chip-closed'}`}
              >
                {t.status === 'open' ? 'Open' : 'Closed'}
              </span>
              {t.unreadCount > 0 ? (
                <span className="everframe-inbox-unread-dot" aria-label={`${t.unreadCount} unread`} />
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
