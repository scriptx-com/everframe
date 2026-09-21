// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Inline reporter theme flattening (reporter branding spec 2026-08-25, RN
// slice) — the host-facing nested `RuntimeConfig.theme` (8 optional hex-string
// roles) is flattened by `extractBridgeConfig` onto the 8 flat wire fields
// `ConfigOpts` declares for codegen (RN codegen cannot express a nested
// object in a struct field — same constraint `companionBadge` documents).
// No hex validation happens here by design: both native ThemeResolvers
// revalidate per-field and ignore invalid values (defense in depth exists
// natively; the RN side is pure passthrough).
import { describe, expect, it } from 'vitest';
import { __extractBridgeConfigForTesting as extract } from '../src/runtime.js';

describe('inline theme config flattening', () => {
  it('flattens a full nested theme onto the 8 flat wire fields', () => {
    const bridge = extract({
      apiKey: 'k',
      theme: {
        background: '#101314',
        surface: '#181c1e',
        border: '#2a3134',
        text: '#e8ecee',
        textMuted: '#8fa0a6',
        accent: '#336699',
        accentForeground: '#0b0d0e',
        destructive: '#e5484d',
      },
    });
    expect(bridge.themeBackground).toBe('#101314');
    expect(bridge.themeSurface).toBe('#181c1e');
    expect(bridge.themeBorder).toBe('#2a3134');
    expect(bridge.themeText).toBe('#e8ecee');
    expect(bridge.themeTextMuted).toBe('#8fa0a6');
    expect(bridge.themeAccent).toBe('#336699');
    expect(bridge.themeAccentForeground).toBe('#0b0d0e');
    expect(bridge.themeDestructive).toBe('#e5484d');
  });

  it('flattens a partial theme — only the supplied roles cross the wire', () => {
    const bridge = extract({ apiKey: 'k', theme: { accent: '#336699' } });
    expect(bridge.themeAccent).toBe('#336699');
    for (const absent of [
      'themeBackground',
      'themeSurface',
      'themeBorder',
      'themeText',
      'themeTextMuted',
      'themeAccentForeground',
      'themeDestructive',
    ]) {
      expect(absent in bridge, `${absent} must not be set`).toBe(false);
    }
  });

  it('omits every theme field when the host sets no theme — native sees "host did nothing"', () => {
    const bridge = extract({ apiKey: 'k' });
    for (const key of Object.keys(bridge)) {
      expect(key.startsWith('theme'), `unexpected theme wire field ${key}`).toBe(false);
    }
  });

  it('passes values through unvalidated — native resolvers own hex validation', () => {
    expect(extract({ apiKey: 'k', theme: { accent: 'not-a-hex' } }).themeAccent).toBe('not-a-hex');
  });
});
