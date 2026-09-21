// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { useEffect, useState, type JSX } from 'react';
import type { TraceItXClient } from '@traceitx/sdk-core';

export interface ThreadListViewProps {
  threads: TraceItXClient['threads'];
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
      <div className="txx-inbox-empty">
        <p>No reports yet.</p>
        <button type="button" className="txx-btn txx-btn-primary" onClick={onNewReport}>
          New report
        </button>
      </div>
    );
  }

  return (
    <>
      {state.readOnly ? (
        <div className="txx-notice txx-notice-degraded">
          Replies are turned off. Existing conversations are read-only.
        </div>
      ) : null}
      {/* Plain <ul>/<li>/<button> — native list + native button semantics,
       * no ARIA role overrides. A `role="listitem"` on the `<button>` itself
       * (the prior shape here) replaces its implicit button role for AT
       * users, which is why this was restructured. */}
      <ul className="txx-inbox-list">
        {rows.map((t) => (
          <li key={t.id}>
            <button type="button" className="txx-inbox-row" onClick={() => onOpenThread(t.id)}>
              <span className="txx-inbox-row-title">
                {t.reportTitle ?? `Report from ${new Date(t.createdAt).toLocaleDateString()}`}
              </span>
              <span
                className={`txx-inbox-chip ${t.status === 'open' ? 'txx-inbox-chip-open' : 'txx-inbox-chip-closed'}`}
              >
                {t.status === 'open' ? 'Open' : 'Closed'}
              </span>
              {t.unreadCount > 0 ? (
                <span className="txx-inbox-unread-dot" aria-label={`${t.unreadCount} unread`} />
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
