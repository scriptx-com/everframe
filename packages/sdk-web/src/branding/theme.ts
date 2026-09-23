// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Reporter theme contract + resolution (branding spec 2026-08-25).
//
// Eight semantic color roles, resolved PER-FIELD server → inline → default
// (the companionBadge precedence doctrine), then expanded into the concrete
// --everframe-* custom-property overrides reporter.css.ts consumes. Derived shades
// are computed here in plain sRGB hex — the stylesheet's header explains why
// the SDK must not depend on oklch()/color-mix() in arbitrary host pages.
//
// ENTITLEMENT: theming applies ONLY once the server confirmed a paid plan
// (branding.watermark === false). Before config arrives — or when the block
// is absent (old server, feature not negotiated) or says watermark: true —
// this resolves to {} and the widget keeps its default look. Fail closed.
//
// SECURITY: every value is re-validated against the 6-digit-hex regex here
// (defense in depth on top of both server gates) — the output lands as
// style declarations on an element in the CUSTOMER'S page, so only values
// this module itself produced (validated hex, or rgba()/hex strings derived
// from validated hex) may ever appear in the returned map.
import type { BrandingServerConfig } from '@everframe/sdk-core';

export interface ReporterTheme {
  background?: string;
  surface?: string;
  border?: string;
  text?: string;
  textMuted?: string;
  accent?: string;
  accentForeground?: string;
  destructive?: string;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const ROLES = [
  'background',
  'surface',
  'border',
  'text',
  'textMuted',
  'accent',
  'accentForeground',
  'destructive',
] as const;
type Role = (typeof ROLES)[number];

/** Derivation anchors — MUST match reporter.css.ts's token block defaults. */
const DEFAULT_BG = '#0D0F13';
const DEFAULT_TEXT = '#F1F5FC';

function channel(hex: string, i: number): number {
  return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
}

/** Channel-wise linear mix of two #rrggbb colors; t=0 → a, t=1 → b. */
export function mixHex(a: string, b: string, t: number): string {
  const c = (i: number): string =>
    Math.max(0, Math.min(255, Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(0)}${c(1)}${c(2)}`;
}

/** #rrggbb → "rgba(r, g, b, <alpha>)" — for the ring/divider alpha tokens. */
export function hexToRgba(hex: string, alpha: number): string {
  return `rgba(${channel(hex, 0)}, ${channel(hex, 1)}, ${channel(hex, 2)}, ${alpha})`;
}

/**
 * Resolve the effective --everframe-* overrides. Returns {} when unentitled or when
 * no valid role value was provided anywhere. Mix ratios reproduce the shipped
 * palette's own ramps (e.g. bg → bg-2 is ≈3.5% toward white in the defaults).
 */
export function resolveThemeVars(
  server: BrandingServerConfig | undefined,
  inline: ReporterTheme | undefined,
): Record<string, string> {
  if (server?.watermark !== false) return {};

  const pick = (role: Role): string | undefined => {
    const s = server.theme?.[role];
    if (typeof s === 'string' && HEX_RE.test(s)) return s;
    const i = inline?.[role];
    if (typeof i === 'string' && HEX_RE.test(i)) return i;
    return undefined;
  };

  const p: Partial<Record<Role, string>> = {};
  for (const role of ROLES) {
    const v = pick(role);
    if (v !== undefined) p[role] = v;
  }
  if (Object.keys(p).length === 0) return {};

  const vars: Record<string, string> = {};
  const effBg = p.background ?? DEFAULT_BG;
  const effText = p.text ?? DEFAULT_TEXT;

  if (p.background) {
    vars['--everframe-bg'] = p.background;
    vars['--everframe-bg-2'] = mixHex(p.background, '#FFFFFF', 0.035);
    vars['--everframe-bg-3'] = mixHex(p.background, '#FFFFFF', 0.07);
    vars['--everframe-modal-grad-top'] = mixHex(p.background, '#FFFFFF', 0.055);
    if (!p.surface) vars['--everframe-surface'] = mixHex(p.background, '#FFFFFF', 0.07);
  }
  if (p.surface) vars['--everframe-surface'] = p.surface;
  if (p.text) vars['--everframe-text'] = p.text;
  if (p.background || p.text) {
    vars['--everframe-divider'] = hexToRgba(effText, 0.08);
    vars['--everframe-row-hover'] = hexToRgba(effText, 0.04);
    vars['--everframe-modal-border'] = hexToRgba(effText, 0.1);
    vars['--everframe-text-faint'] = mixHex(effText, effBg, 0.5);
    if (!p.textMuted) vars['--everframe-text-muted'] = mixHex(effText, effBg, 0.26);
    if (!p.border) vars['--everframe-border'] = mixHex(effBg, effText, 0.15);
  }
  if (p.textMuted) vars['--everframe-text-muted'] = p.textMuted;
  if (p.border) vars['--everframe-border'] = p.border;
  if (p.accent) {
    vars['--everframe-accent'] = p.accent;
    vars['--everframe-accent-hover'] = mixHex(p.accent, '#FFFFFF', 0.08);
    vars['--everframe-accent-2'] = mixHex(p.accent, '#FFFFFF', 0.35);
    vars['--everframe-ring'] = hexToRgba(p.accent, 0.22);
    vars['--everframe-border-focus'] = hexToRgba(p.accent, 0.45);
    vars['--everframe-status-success-bg'] = hexToRgba(p.accent, 0.12);
    vars['--everframe-status-success-fg'] = p.accent;
    vars['--everframe-accent-grad-top'] = mixHex(p.accent, '#FFFFFF', 0.06);
    vars['--everframe-accent-grad-bottom'] = mixHex(p.accent, '#000000', 0.04);
    vars['--everframe-accent-grad-top-hover'] = mixHex(p.accent, '#FFFFFF', 0.12);
    vars['--everframe-accent-grad-bottom-hover'] = p.accent;
    vars['--everframe-accent-glow'] = hexToRgba(p.accent, 0.2);
    vars['--everframe-accent-bg-soft'] = hexToRgba(p.accent, 0.14);
  }
  if (p.accentForeground) vars['--everframe-accent-fg'] = p.accentForeground;
  if (p.destructive) {
    vars['--everframe-destructive'] = p.destructive;
    vars['--everframe-error'] = p.destructive;
    vars['--everframe-destructive-border'] = hexToRgba(p.destructive, 0.5);
    vars['--everframe-destructive-hover-bg'] = hexToRgba(p.destructive, 0.1);
    vars['--everframe-destructive-ring'] = hexToRgba(p.destructive, 0.25);
    vars['--everframe-destructive-ring-soft'] = hexToRgba(p.destructive, 0.22);
    vars['--everframe-destructive-bg-soft'] = hexToRgba(p.destructive, 0.12);
  }
  return vars;
}
