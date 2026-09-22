// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// `@traceitx/react/preview` (admin branding editor, spec follow-on to
// 2026-08-25): a dedicated subpath entry so the dashboard can mount the REAL
// ReporterDialog as a live theme preview without widening the root SDK API.
// This spec locks the entry's surface — the admin app imports exactly these
// names, so a rename/removal here breaks the dashboard silently at its next
// typecheck otherwise.
import { describe, expect, it } from 'vitest';
import * as preview from '../src/preview.js';

describe('preview entry surface', () => {
  it('exposes the real dialog component', () => {
    expect(typeof preview.ReporterDialog).toBe('function');
  });

  it('exposes the injected stylesheet as a string', () => {
    expect(typeof preview.REPORTER_CSS).toBe('string');
    expect(preview.REPORTER_CSS).toContain('--txx-');
  });

  it('exposes the server-config box setter — driving it re-themes a mounted dialog through the production path', () => {
    expect(typeof preview.__setBrandingServerConfig).toBe('function');
  });

  it('exposes the branding resolver (same function the shipped widget runs)', () => {
    expect(typeof preview.resolveThemeVars).toBe('function');
    // Entitled + one role → the --txx-* override map, exactly as shipped.
    expect(
      preview.resolveThemeVars({ watermark: false, theme: { accent: '#336699' } }, undefined),
    ).toMatchObject({ '--txx-accent': '#336699' });
    // Unentitled → {} (fail closed) — the preview relies on this to show the
    // free-plan default look.
    expect(
      preview.resolveThemeVars({ watermark: true, theme: { accent: '#336699' } }, undefined),
    ).toEqual({});
  });
});
