// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { ButtonHTMLAttributes, JSX } from 'react';

export interface ToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value'> {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  /** Accessible label when state is `checked === true`. Default: `Include`. */
  verbOn?: string;
  /** Accessible label when state is `checked === false`. Default: `Exclude`. */
  verbOff?: string;
}

/**
 * Switch primitive — track + thumb visual. Verb pair (`verbOn` / `verbOff`)
 * lives in `aria-label` for screen readers; the visual is the switch state,
 * so the panel header stays compact.
 */
export function Toggle({
  checked,
  onCheckedChange,
  verbOn = 'Include',
  verbOff = 'Exclude',
  className,
  ...rest
}: ToggleProps): JSX.Element {
  const cls = ['txx-switch', checked && 'txx-switch-on', className].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={checked ? verbOn : verbOff}
      onClick={() => onCheckedChange(!checked)}
      className={cls}
      {...rest}
    >
      <span className="txx-switch-thumb" aria-hidden="true" />
    </button>
  );
}
