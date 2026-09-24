// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { JSX } from 'react';
import { Toggle } from './primitives/Toggle.js';

export interface IncludeRow {
  /** Stable key for excludedArtifacts wiring. */
  key: string;
  /** Display name (left of the row). */
  name: string;
  /** Pre-formatted count chip (e.g. "12 events", "—"). */
  count: string;
  /** Whether this artifact is included in the report. */
  included: boolean;
  /** Toggle handler. Locked rows pass undefined. */
  onToggle?: () => void;
}

export interface IncludeCardProps {
  rows: IncludeRow[];
}

/**
 * Native-parity "Include in this report" card. Replaces the previous
 * per-section collapsible panels — receiver-side previews live in admin
 * event detail, so the modal only surfaces the include/exclude decision.
 * Mirrors Android IncludeCard.kt (Phase 13 D1).
 *
 * Row layout: [name (1fr)] [count chip] [switch]. The switch is the only
 * interactive child — making the entire row clickable would nest a button
 * inside a button (invalid HTML); the 44pt switch target is large enough
 * on its own.
 */
export function IncludeCard({ rows }: IncludeCardProps): JSX.Element {
  return (
    <>
      <span className="everframe-include-label">Include in this report</span>
      <div className="everframe-include-card" data-testid="include-card">
        {rows.map((row) => (
          <div
            key={row.key}
            className="everframe-include-row"
            data-testid={`include-row-${row.key}`}
          >
            <span className="everframe-include-row-name">{row.name}</span>
            <span className="everframe-include-row-count">{row.count}</span>
            <Toggle
              checked={row.included}
              onCheckedChange={() => row.onToggle?.()}
              disabled={row.onToggle === undefined}
              data-testid={`include-toggle-${row.key}`}
            />
          </div>
        ))}
      </div>
    </>
  );
}
