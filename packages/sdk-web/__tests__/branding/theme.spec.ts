// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { resolveThemeVars, mixHex, hexToRgba } from '../../src/branding/theme.js';

describe('mixHex / hexToRgba', () => {
  it('mixes channel-wise', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#336699', '#FFFFFF', 0.08)).toBe('#4372a1');
    expect(mixHex('#336699', '#FFFFFF', 0)).toBe('#336699');
  });
  it('formats rgba', () => {
    expect(hexToRgba('#336699', 0.22)).toBe('rgba(51, 102, 153, 0.22)');
  });
});

describe('resolveThemeVars — entitlement gate', () => {
  it('no server block → {} even with an inline theme (fail closed)', () => {
    expect(resolveThemeVars(undefined, { accent: '#336699' })).toEqual({});
  });
  it('watermark: true (free plan) → {} even with an inline theme', () => {
    expect(resolveThemeVars({ watermark: true }, { accent: '#336699' })).toEqual({});
  });
  it('entitled but nothing overridden → {}', () => {
    expect(resolveThemeVars({ watermark: false }, undefined)).toEqual({});
    expect(resolveThemeVars({ watermark: false }, {})).toEqual({});
  });
});

describe('resolveThemeVars — mapping and derivation', () => {
  it('accent-only inline theme sets the accent family and nothing else', () => {
    const vars = resolveThemeVars({ watermark: false }, { accent: '#336699' });
    expect(vars).toEqual({
      '--everframe-accent': '#336699',
      '--everframe-accent-hover': mixHex('#336699', '#FFFFFF', 0.08),
      '--everframe-accent-2': mixHex('#336699', '#FFFFFF', 0.35),
      '--everframe-ring': 'rgba(51, 102, 153, 0.22)',
      '--everframe-border-focus': 'rgba(51, 102, 153, 0.45)',
      '--everframe-status-success-bg': 'rgba(51, 102, 153, 0.12)',
      '--everframe-status-success-fg': '#336699',
      '--everframe-accent-grad-top': mixHex('#336699', '#FFFFFF', 0.06),
      '--everframe-accent-grad-bottom': mixHex('#336699', '#000000', 0.04),
      '--everframe-accent-grad-top-hover': mixHex('#336699', '#FFFFFF', 0.12),
      '--everframe-accent-grad-bottom-hover': '#336699',
      '--everframe-accent-glow': hexToRgba('#336699', 0.2),
      '--everframe-accent-bg-soft': hexToRgba('#336699', 0.14),
    });
  });

  it('server theme field beats inline per-field; inline fills server gaps', () => {
    const vars = resolveThemeVars(
      { watermark: false, theme: { accent: '#ff0000' } },
      { accent: '#00ff00', accentForeground: '#111111' },
    );
    expect(vars['--everframe-accent']).toBe('#ff0000');      // server wins
    expect(vars['--everframe-accent-fg']).toBe('#111111');   // inline fills the gap
  });

  it('background derives the tonal ramp, modal gradient top, and surface', () => {
    const vars = resolveThemeVars({ watermark: false }, { background: '#101215' });
    expect(vars['--everframe-bg']).toBe('#101215');
    expect(vars['--everframe-bg-2']).toBe(mixHex('#101215', '#FFFFFF', 0.035));
    expect(vars['--everframe-bg-3']).toBe(mixHex('#101215', '#FFFFFF', 0.07));
    expect(vars['--everframe-modal-grad-top']).toBe(mixHex('#101215', '#FFFFFF', 0.055));
    expect(vars['--everframe-surface']).toBe(mixHex('#101215', '#FFFFFF', 0.07)); // no explicit surface
    // text-anchored derivations use the DEFAULT text (#F1F5FC):
    expect(vars['--everframe-divider']).toBe('rgba(241, 245, 252, 0.08)');
    expect(vars['--everframe-modal-border']).toBe('rgba(241, 245, 252, 0.1)');
  });

  it('an explicit surface overrides the derived one', () => {
    const vars = resolveThemeVars(
      { watermark: false },
      { background: '#101215', surface: '#222428' },
    );
    expect(vars['--everframe-surface']).toBe('#222428');
  });

  it('text overrides derive muted/faint/divider from the new ink', () => {
    const vars = resolveThemeVars({ watermark: false }, { text: '#e8e8f0' });
    expect(vars['--everframe-text']).toBe('#e8e8f0');
    expect(vars['--everframe-text-muted']).toBe(mixHex('#e8e8f0', '#0D0F13', 0.26));
    expect(vars['--everframe-text-faint']).toBe(mixHex('#e8e8f0', '#0D0F13', 0.5));
    expect(vars['--everframe-divider']).toBe('rgba(232, 232, 240, 0.08)');
    expect(vars['--everframe-border']).toBe(mixHex('#0D0F13', '#e8e8f0', 0.15));
  });

  it('destructive maps to destructive AND error, plus the outline-destructive control rgba trio', () => {
    const vars = resolveThemeVars({ watermark: false }, { destructive: '#cc3355' });
    expect(vars['--everframe-destructive']).toBe('#cc3355');
    expect(vars['--everframe-error']).toBe('#cc3355');
    expect(vars['--everframe-destructive-border']).toBe(hexToRgba('#cc3355', 0.5));
    expect(vars['--everframe-destructive-hover-bg']).toBe(hexToRgba('#cc3355', 0.1));
    expect(vars['--everframe-destructive-ring']).toBe(hexToRgba('#cc3355', 0.25));
    expect(vars['--everframe-destructive-ring-soft']).toBe(hexToRgba('#cc3355', 0.22));
    expect(vars['--everframe-destructive-bg-soft']).toBe(hexToRgba('#cc3355', 0.12));
  });

  it('invalid hex values are ignored per-field, never thrown on', () => {
    const vars = resolveThemeVars(
      { watermark: false },
      { accent: 'red; } body { background: url(x) }', text: '#e8e8f0' },
    );
    expect(vars['--everframe-accent']).toBeUndefined();
    expect(vars['--everframe-text']).toBe('#e8e8f0');
  });
});
