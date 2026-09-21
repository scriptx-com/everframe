// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { forwardRef, useRef, type InputHTMLAttributes, type JSX } from 'react';

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  errorText?: string;
}

/**
 * TextInput primitive — UI-SPEC §"Component primitives". `<label htmlFor>` association +
 * aria-describedby on helper text (Accessibility Floor lock).
 */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { label, errorText, className, id, ...rest },
  ref,
): JSX.Element {
  const generatedIdRef = useRef<string>(`txx-input-${Math.random().toString(36).slice(2)}`);
  const inputId = id ?? generatedIdRef.current;
  const helperId = errorText ? `${inputId}-helper` : undefined;
  const cls = ['txx-input', errorText && 'txx-input-error', className].filter(Boolean).join(' ');
  return (
    <div className="txx-field">
      {label ? (
        <label htmlFor={inputId} className="txx-field-label">
          {label}
        </label>
      ) : null}
      <input
        ref={ref}
        id={inputId}
        className={cls}
        aria-describedby={helperId}
        aria-invalid={errorText ? true : undefined}
        {...rest}
      />
      {errorText ? (
        <span id={helperId} className="txx-helper-error">
          {errorText}
        </span>
      ) : null}
    </div>
  );
});
