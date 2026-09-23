// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode, type JSX } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'outline-destructive' | 'icon';
export type ButtonSize = 'default' | 'sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  iconOnly?: boolean;
  children?: ReactNode;
}

/**
 * Button primitive — UI-SPEC §"Component primitives". `iconOnly` warns when no aria-label
 * supplied (WCAG 1.4.1 lock; admin Phase 02.1 set the precedent at the type level).
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'default', loading, iconOnly, className, children, disabled, ...rest },
  ref,
): JSX.Element {
  const cls = [
    'everframe-btn',
    variant === 'primary' && 'everframe-btn-primary',
    variant === 'secondary' && 'everframe-btn-secondary',
    variant === 'outline-destructive' && 'everframe-btn-outline-destructive',
    variant === 'icon' && 'everframe-btn-icon',
    size === 'sm' && 'everframe-btn-sm',
    iconOnly && 'everframe-btn-icon',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  if (
    iconOnly &&
    typeof process !== 'undefined' &&
    process.env['NODE_ENV'] !== 'production' &&
    !rest['aria-label'] &&
    !rest['aria-labelledby']
  ) {
    // eslint-disable-next-line no-console
    console.warn('[everframe] iconOnly Button missing aria-label');
  }
  return (
    <button
      ref={ref}
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {children}
    </button>
  );
});
