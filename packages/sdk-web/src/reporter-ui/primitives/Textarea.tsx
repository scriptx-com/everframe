// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { forwardRef, useRef, type TextareaHTMLAttributes, type JSX } from 'react';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
}

/**
 * Textarea primitive — UI-SPEC §"Component primitives". Default 3 rows; resize:vertical
 * via reporter.css; system font (NOT mono) per UI-SPEC Typography.
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, className, id, rows = 3, ...rest },
  ref,
): JSX.Element {
  const generatedIdRef = useRef<string>(`everframe-ta-${Math.random().toString(36).slice(2)}`);
  const textareaId = id ?? generatedIdRef.current;
  const cls = ['everframe-textarea', className].filter(Boolean).join(' ');
  return (
    <div className="everframe-field">
      {label ? (
        <label htmlFor={textareaId} className="everframe-field-label">
          {label}
        </label>
      ) : null}
      <textarea ref={ref} id={textareaId} rows={rows} className={cls} {...rest} />
    </div>
  );
});
