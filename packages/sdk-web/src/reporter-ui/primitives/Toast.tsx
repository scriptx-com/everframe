// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { useEffect, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { resolvePortalTarget } from '../portal-target.js';

export type ToastTone = 'success' | 'warning' | 'error' | 'info';

export interface ToastProps {
  open: boolean;
  tone: ToastTone;
  message: string;
  durationMs?: number;
  onDismiss: () => void;
}

/**
 * Toast primitive — UI-SPEC §"Toast" lock. Single-toast-at-a-time; auto-dismiss; click to
 * dismiss immediately; `role=alert` for error tone, `role=status` for everything else.
 */
export function Toast({
  open,
  tone,
  message,
  durationMs = 3000,
  onDismiss,
}: ToastProps): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(t);
  }, [open, durationMs, onDismiss]);
  if (!open) return null;
  const portalTarget = resolvePortalTarget();
  if (!portalTarget) return null;
  return createPortal(
    <div className="txx-root" data-traceitx-skip-capture="true">
      <div
        className={`txx-toast txx-toast-${tone}`}
        role={tone === 'error' ? 'alert' : 'status'}
        aria-live={tone === 'error' ? 'assertive' : 'polite'}
        onClick={onDismiss}
        data-testid="traceitx-toast"
      >
        {message}
      </div>
    </div>,
    portalTarget,
  );
}
