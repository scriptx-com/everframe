// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { useEffect, useRef, type ReactNode, type CSSProperties, type JSX, type RefObject } from 'react';
import { sensitiveRegistry } from '@everframe/web';
import type { Rect } from '@everframe/sdk-core';

export interface SensitiveProps {
  children: ReactNode;
  /** Optional className applied to the wrapper div. */
  className?: string;
  /**
   * Optional style applied to the wrapper div.
   * Default: { display: 'contents' } so wrapping introduces zero layout shift.
   */
  style?: CSSProperties;
}

/**
 * <Sensitive>{children}</Sensitive> — wraps children in a div whose getBoundingClientRect
 * is registered with the sensitive-rect registry on mount. Capture-time mask plan blanks
 * the rect pixels (PRIV-02 / PRIV-03).
 *
 * Default wrapper style is `display: contents` so the wrapper does not affect layout.
 * Customer can override via `style` prop if they need a real container (e.g. for click-blocking).
 *
 * No-op under SSR (useEffect does not fire server-side).
 */
export function Sensitive({ children, className, style }: SensitiveProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    sensitiveRegistry.addRef(el);
    return () => sensitiveRegistry.removeRef(el);
  }, []);
  const wrapperStyle: CSSProperties = style ?? { display: 'contents' };
  return (
    <div ref={ref} className={className} style={wrapperStyle} data-everframe-sensitive="">
      {children}
    </div>
  );
}

/** Register an existing DOM element as sensitive while its host has a rect. */
export function useEverframeSensitiveRef<T extends Element>(
  ref: RefObject<T | null>,
  rect: Rect | null,
): void {
  useEffect(() => {
    const element = ref.current;
    if (element === null || rect === null) return;
    sensitiveRegistry.addRef(element);
    return () => sensitiveRegistry.removeRef(element);
  }, [ref, rect]);
}
