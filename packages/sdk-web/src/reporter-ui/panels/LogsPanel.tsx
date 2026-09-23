// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { JSX } from 'react';
import type { LogEntry } from '@everframe/sdk-core';
import { X } from 'lucide-react';
import { Button } from '../primitives/Button.js';
import { CollapsiblePanel } from './CollapsiblePanel.js';

export interface LogsPanelProps {
  logs: LogEntry[];
  included: boolean;
  onToggle: (next: boolean) => void;
  redacted: Set<number>;
  onToggleRedact: (index: number) => void;
}

export function LogsPanel({
  logs,
  included,
  onToggle,
  redacted,
  onToggleRedact,
}: LogsPanelProps): JSX.Element {
  return (
    <CollapsiblePanel
      title="Console"
      count={`${logs.length} entries`}
      included={included}
      onToggle={onToggle}
      testId="logs-panel"
    >
      {logs.length === 0 ? <p>No console activity captured</p> : null}
      {logs.map((entry, i) => {
        const rowCls = ['everframe-row', redacted.has(i) && 'everframe-row-redacted']
          .filter(Boolean)
          .join(' ');
        const verb = redacted.has(i) ? 'Restore' : 'Redact';
        return (
          <div key={i} className={rowCls} data-testid={`log-row-${i}`}>
            <span>
              [{entry.level}] {entry.message}
            </span>
            <span>{new Date(entry.timestamp).toISOString().slice(11, 23)}</span>
            <Button
              iconOnly
              variant="icon"
              size="sm"
              aria-label={`${verb} this log line`}
              onClick={() => onToggleRedact(i)}
              data-testid={`log-redact-${i}`}
            >
              <X size={12} aria-hidden="true" />
            </Button>
          </div>
        );
      })}
    </CollapsiblePanel>
  );
}
