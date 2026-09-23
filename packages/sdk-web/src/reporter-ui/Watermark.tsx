// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { JSX } from 'react';

/**
 * "Powered by Everframe" footer mark (branding spec 2026-08-25). Rendered
 * whenever the server has NOT confirmed paid-plan entitlement
 * (branding.watermark !== false) — fail closed to watermarked. Inline SVG:
 * the SDK ships into arbitrary host pages and must not fetch remote assets
 * (no network dependency, no CSP img-src requirement). The diamond mirrors
 * the .everframe-modal-title::before glyph — the one brand mark in the window.
 */
export function Watermark(): JSX.Element {
  return (
    <a
      className="everframe-watermark"
      href="https://everframe.dev/?ref=powered-by"
      target="_blank"
      rel="noopener noreferrer"
      data-testid="everframe-watermark"
    >
      <svg
        className="everframe-watermark-mark"
        width="10"
        height="10"
        viewBox="0 0 10 10"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="2" y="2" width="6" height="6" rx="1.2" transform="rotate(45 5 5)" />
      </svg>
      <span>Powered by Everframe</span>
    </a>
  );
}
