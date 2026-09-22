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
    'txx-btn',
    variant === 'primary' && 'txx-btn-primary',
    variant === 'secondary' && 'txx-btn-secondary',
    variant === 'outline-destructive' && 'txx-btn-outline-destructive',
    variant === 'icon' && 'txx-btn-icon',
    size === 'sm' && 'txx-btn-sm',
    iconOnly && 'txx-btn-icon',
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
    console.warn('[traceitx] iconOnly Button missing aria-label');
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
