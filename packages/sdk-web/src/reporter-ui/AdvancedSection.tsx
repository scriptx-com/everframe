// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { useState, type ReactNode, type JSX } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

export interface AdvancedSectionProps {
  children: ReactNode;
}

/**
 * Advanced expander — UI-SPEC §"Reporter modal" Show what's being sent / Hide what's
 * being sent toggle row. Default-collapsed; chevron rotates on toggle; the four artifact
 * panels (UITree → Logs → Network → Metadata) live as children rendered only when expanded.
 */
export function AdvancedSection({ children }: AdvancedSectionProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <div data-testid="advanced-section">
      <button
        type="button"
        className="txx-advanced-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        data-testid="advanced-toggle"
      >
        <span>{expanded ? "Hide what's being sent" : "Show what's being sent"}</span>
        {expanded ? (
          <ChevronUp size={18} aria-hidden="true" />
        ) : (
          <ChevronDown size={18} aria-hidden="true" />
        )}
      </button>
      {expanded ? <div data-testid="advanced-content">{children}</div> : null}
    </div>
  );
}
