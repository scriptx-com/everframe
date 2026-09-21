// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { ReactNode, JSX } from 'react';

export type NoticeTone = 'degraded' | 'error';

export interface NoticeStripProps {
  tone?: NoticeTone;
  children: ReactNode;
}

/**
 * NoticeStrip — inline non-modal notice (degraded capture, screenshot-failed). Color +
 * text/icon (callers add icon as children) per UI-SPEC §"Color" status pairs. Never blocks
 * submission — purely informational.
 */
export function NoticeStrip({ tone = 'degraded', children }: NoticeStripProps): JSX.Element {
  return (
    <div className={`txx-notice txx-notice-${tone}`} role="status">
      {children}
    </div>
  );
}
