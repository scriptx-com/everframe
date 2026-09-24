// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { JSX } from 'react';
import type { DeviceMetadata } from '@everframe/sdk-core';
import { CollapsiblePanel } from './CollapsiblePanel.js';

export interface MetadataPanelProps {
  meta: DeviceMetadata | null;
}

/**
 * Metadata always ships — the switch is rendered locked-on so the inclusion
 * is visible but not opt-out-able. Without device metadata reports are
 * essentially untriageable; mirrors the locked-toggle on the phone-companion
 * reporter.
 */
export function MetadataPanel({ meta }: MetadataPanelProps): JSX.Element {
  const rows: Array<[string, string]> = meta
    ? [
        ['OS', meta.os],
        ['OS version', meta.osVersion],
        ['Screen', `${meta.screenSize.width}×${meta.screenSize.height}`],
        ['Pixel ratio', String(meta.pixelRatio)],
        ['Locale', meta.locale],
        ['Timezone', meta.timezone],
        ['Network', meta.network ?? 'unknown'],
        ...(meta.userAgent ? ([['User agent', meta.userAgent]] as [string, string][]) : []),
      ]
    : [];
  return (
    <CollapsiblePanel
      title="Metadata"
      included
      onToggle={() => {}}
      toggleDisabled
      testId="metadata-panel"
    >
      <dl>
        {rows.map(([k, v]) => (
          <div key={k} className="everframe-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </CollapsiblePanel>
  );
}
