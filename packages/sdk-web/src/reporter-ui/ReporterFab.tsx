// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The replies FAB: the feature's ENTIRE ambient footprint (spec) — a small
// floating button with an unread dot. No toasts, no interstitials. Rendered
// by the Provider only when this device actually has threads.
import { MessageSquare } from 'lucide-react';

export interface ReporterFabProps {
  unreadCount: number;
  onOpen: () => void;
}

export function ReporterFab({ unreadCount, onOpen }: ReporterFabProps) {
  const label = unreadCount > 0 ? `Your reports — ${unreadCount} unread` : 'Your reports';
  return (
    <div className="txx-root txx-fab-wrap">
      <button type="button" className="txx-fab" aria-label={label} data-testid="reporter-fab" onClick={onOpen}>
        <MessageSquare size={20} aria-hidden="true" />
        {unreadCount > 0 ? <span className="txx-fab-dot" aria-hidden="true" /> : null}
      </button>
    </div>
  );
}
