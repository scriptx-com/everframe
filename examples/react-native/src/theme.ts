// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Elytra design tokens — the RN port of examples/react-web's field-guide
// look. Naturalist palette: cool specimen-paper ground, olive ink, moss
// actions, ochre catalog tags. The Everframe brand cyan appears ONLY on the
// floating report button so SDK chrome reads as a different owner than the
// demo app around it.

import { Platform } from 'react-native';

export const color = {
  paper: '#F5F5EF',
  paperRaised: '#FDFDF9',
  paperSunken: '#EEEEE6',
  ink: '#20241C',
  inkSoft: '#5A6153',
  inkFaint: '#8A9082',
  line: '#D8DACC',
  lineStrong: '#B9BCAB',
  moss: '#3A6B4F',
  mossDeep: '#2C523C',
  mossWash: '#E3EBE2',
  tag: '#96692B',
  tagWash: '#F2E9D8',
  danger: '#A43A2A',
  // SDK chrome (ReportFab) — brand cyan family, never used by app UI.
  sdkBg: '#12333C',
  sdkBgPressed: '#17414C',
  sdkText: '#A7DCEB',
} as const;

/**
 * Field-guide serif for display text. Iowan Old Style ships with iOS/tvOS;
 * Android's 'serif' resolves to Noto Serif.
 */
export const font = {
  display: Platform.select({ ios: 'Iowan Old Style', default: 'serif' }),
  mono: Platform.select({ ios: 'Menlo', default: 'monospace' }),
} as const;

/** Mild scale-up for the 10-foot TV view. */
const TV = Platform.isTV ? 1.35 : 1;

export const type = {
  display: { fontFamily: font.display, fontSize: 30 * TV, lineHeight: 34 * TV, color: color.ink },
  sectionTitle: { fontFamily: font.display, fontSize: 21 * TV, lineHeight: 26 * TV, color: color.ink },
  eyebrow: {
    fontFamily: font.mono,
    fontSize: 11 * TV,
    letterSpacing: 1.4,
    textTransform: 'uppercase' as const,
    color: color.tag,
  },
  body: { fontSize: 15 * TV, lineHeight: 22 * TV, color: color.ink },
  muted: { fontSize: 14 * TV, lineHeight: 20 * TV, color: color.inkSoft },
  monoNote: { fontFamily: font.mono, fontSize: 11 * TV, lineHeight: 16 * TV, color: color.inkFaint },
} as const;

export const radius = { card: 10, control: 8, pill: 999 } as const;
