// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { JSX } from 'react';
import type { NetworkEntry } from '@everframe/sdk-core';
import { CollapsiblePanel } from './CollapsiblePanel.js';

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export interface NetworkPanelProps {
  entries: NetworkEntry[];
  included: boolean;
  onToggle: (next: boolean) => void;
}

/**
 * Network panel — rows are display-only. Per-row redaction was dropped; the
 * artifact-level switch in the header is the sole control. Rows ship in the
 * envelope when included.
 */
export function NetworkPanel({ entries, included, onToggle }: NetworkPanelProps): JSX.Element {
  return (
    <CollapsiblePanel
      title="Network"
      count={`${entries.length} requests`}
      included={included}
      onToggle={onToggle}
      testId="network-panel"
    >
      {entries.length === 0 ? <p>No network requests captured</p> : null}
      {entries.map((entry, i) => (
        <div key={i} className="everframe-row" data-testid={`net-row-${i}`}>
          <span>{entry.method}</span>
          <span title={entry.url}>{trunc(entry.url, 48)}</span>
          <span>{entry.status ?? '-'}</span>
          <span>
            {typeof entry.durationMs === 'number' ? `${entry.durationMs.toFixed(0)}ms` : '-'}
          </span>
        </div>
      ))}
    </CollapsiblePanel>
  );
}
