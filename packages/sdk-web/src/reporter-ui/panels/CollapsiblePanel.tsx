// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { useState, type ReactNode, type JSX } from 'react';
import { ChevronDown } from 'lucide-react';
import { Toggle } from '../primitives/Toggle.js';

export interface CollapsiblePanelProps {
  title: string;
  /** Right-of-title metadata (e.g. "12 entries"). Renders inline. */
  count?: string;
  included: boolean;
  onToggle: (next: boolean) => void;
  /** Set true to omit the disclosure chevron + body entirely (header-only panel). */
  headerOnly?: boolean;
  /** Lock the include/exclude switch on. Use for artifacts that always ship. */
  toggleDisabled?: boolean;
  /** Stable id slug for test selectors (e.g. `logs-panel`). */
  testId: string;
  children?: ReactNode;
}

/**
 * Shared panel chrome — collapsible disclosure with a switch in the header.
 * Mirrors the per-artifact section UI from the native phone reporters: tap
 * anywhere on the header (except the switch) to expand/collapse the body;
 * the switch controls inclusion in the report independently.
 */
export function CollapsiblePanel({
  title,
  count,
  included,
  onToggle,
  headerOnly = false,
  toggleDisabled = false,
  testId,
  children,
}: CollapsiblePanelProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const cls = ['everframe-panel', !included && 'everframe-panel-excluded'].filter(Boolean).join(' ');
  return (
    <section className={cls} data-testid={testId}>
      <div className="everframe-panel-header">
        {headerOnly ? (
          <span className="everframe-panel-title">{title}</span>
        ) : (
          <button
            type="button"
            className="everframe-panel-disclosure"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            data-testid={`${testId}-disclosure`}
          >
            <ChevronDown
              size={14}
              aria-hidden="true"
              className={['everframe-panel-chevron', open && 'everframe-panel-chevron-open']
                .filter(Boolean)
                .join(' ')}
            />
            <span className="everframe-panel-title">{title}</span>
          </button>
        )}
        {count !== undefined ? <span className="everframe-panel-count">{count}</span> : null}
        <Toggle checked={included} onCheckedChange={onToggle} disabled={toggleDisabled} />
      </div>
      {!headerOnly && open ? <div className="everframe-panel-body">{children}</div> : null}
    </section>
  );
}
